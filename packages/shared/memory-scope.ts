import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { ProfileParams } from "./memory-tools.types.ts";
import {
  MAX_TOOL_NAMESPACE_CHARACTERS,
  MAX_TOOL_PROFILE_CHARACTERS,
  MAX_TOOL_SESSION_ID_CHARACTERS,
  MEMORY_NAME_PATTERN,
} from "./memory-tools.ts";

export const MEMORY_NAMESPACE_ENV = "AGNTN_MEMORY_NAMESPACE";
export const MEMORY_PROFILE_ENV = "AGNTN_MEMORY_PROFILE";
export const PI_MEMORY_SCOPE_FILENAME = "memory-scope.json";

const memoryNamePattern = new RegExp(MEMORY_NAME_PATTERN);

function validateMemoryName(name: string, label: string, maxLength: number): string {
  if (name.length > maxLength || !memoryNamePattern.test(name)) {
    throw new Error(
      `${label} must match ${MEMORY_NAME_PATTERN} and be at most ${maxLength} characters`,
    );
  }
  return name;
}

function validateMemoryScope(
  namespace: string | undefined,
  profile: string | undefined,
  source: string,
): ProfileParams {
  if (!namespace || !profile) {
    throw new Error(`${source} must define both namespace and profile`);
  }
  return {
    namespace: validateMemoryName(namespace, "Memory namespace", MAX_TOOL_NAMESPACE_CHARACTERS),
    profile: validateMemoryName(profile, "Memory profile", MAX_TOOL_PROFILE_CHARACTERS),
  };
}

/** Return the fixed operational scope, or undefined when the raw multi-profile surface is requested. */
export function configuredMemoryScope(
  env: NodeJS.ProcessEnv = process.env,
): ProfileParams | undefined {
  const namespace = env[MEMORY_NAMESPACE_ENV]?.trim();
  const profile = env[MEMORY_PROFILE_ENV]?.trim();
  if (!namespace && !profile) return undefined;
  if (!namespace || !profile) {
    throw new Error(`${MEMORY_NAMESPACE_ENV} and ${MEMORY_PROFILE_ENV} must be set together`);
  }
  return validateMemoryScope(namespace, profile, "Memory environment");
}

/**
 * Resolve Pi's operational scope from environment first, then its agent-local
 * `memory-scope.json`. Pi does not load `.env` files, so the extension owns this
 * narrow non-secret configuration path.
 */
export function configuredPiMemoryScope(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = homedir(),
): ProfileParams | undefined {
  const environmentScope = configuredMemoryScope(env);
  if (environmentScope) return environmentScope;

  const configuredAgentDir = env.PI_CODING_AGENT_DIR?.trim();
  const agentDir = configuredAgentDir
    ? configuredAgentDir === "~"
      ? homeDirectory
      : configuredAgentDir.startsWith("~/")
        ? join(homeDirectory, configuredAgentDir.slice(2))
        : resolve(configuredAgentDir)
    : join(homeDirectory, ".pi", "agent");
  const configPath = join(agentDir, PI_MEMORY_SCOPE_FILENAME);

  let source: string;
  try {
    source = readFileSync(configPath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw new Error(
      `Cannot read Pi memory scope from ${configPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(
      `Cannot parse Pi memory scope from ${configPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Pi memory scope at ${configPath} must be a JSON object`);
  }
  const record = value as Record<string, unknown>;
  return validateMemoryScope(
    typeof record.namespace === "string" ? record.namespace.trim() : undefined,
    typeof record.profile === "string" ? record.profile.trim() : undefined,
    `Pi memory scope at ${configPath}`,
  );
}

/** Inject a fixed scope after tool argument validation, so callers cannot select another profile. */
export function applyMemoryScope<T extends object>(
  params: T,
  scope: ProfileParams,
): T & ProfileParams {
  return { ...params, ...scope };
}

/** Own write provenance in bound mode; preserve caller-owned sessions only in raw mode. */
export function applyMemoryWriteScope<T extends object>(
  params: T,
  scope: ProfileParams | undefined,
  harnessSessionId: string | undefined,
): T & ProfileParams & { sessionId?: string } {
  const scoped: T & ProfileParams & { sessionId?: string } = scope
    ? applyMemoryScope(params, scope)
    : (params as T & ProfileParams & { sessionId?: string });
  if (!scope && scoped.sessionId) return scoped;
  return { ...scoped, sessionId: harnessSessionId };
}

/**
 * Build a stable, non-identifying session key from the harness, project, and harness conversation id.
 * The readable prefix aids audits; the digest avoids leaking full paths or conversation identifiers.
 */
export function memorySessionId(harness: string, cwd: string, conversationId: string): string {
  const normalizedHarness = harness
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const project = basename(resolve(cwd))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24);
  const digest = createHash("sha256")
    .update(`${normalizedHarness}\0${resolve(cwd)}\0${conversationId}`)
    .digest("hex")
    .slice(0, 16);
  return `${normalizedHarness}-${project || "root"}-${digest}`.slice(
    0,
    MAX_TOOL_SESSION_ID_CHARACTERS,
  );
}

/** Derive Claude Code's stable session key from environment injected into MCP children. */
export function claudeCodeMemorySessionId(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const cwd = env.CLAUDE_PROJECT_DIR?.trim();
  const conversationId = env.CLAUDE_CODE_SESSION_ID?.trim();
  if (!cwd || !conversationId) return undefined;
  return memorySessionId("claude", cwd, conversationId);
}
