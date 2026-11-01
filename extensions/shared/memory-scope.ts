import { sha256 } from "@agntn/hashes/sha2";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { ProfileParams } from "./memory-tools.types.ts";
import {
  MAX_TOOL_NAMESPACE_CHARACTERS,
  MAX_TOOL_PROFILE_CHARACTERS,
  MAX_TOOL_SESSION_ID_CHARACTERS,
  MEMORY_NAME_PATTERN,
} from "./memory-tool-contract.ts";

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

/**
 * Return the default operational scope, or undefined for the raw multi-profile surface.
 *
 * @param env - Environment carrying the optional namespace and profile pair.
 * @returns {ProfileParams | undefined} The default scope, or `undefined` with neither variable set.
 */
export function configuredMemoryScope(
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): ProfileParams | undefined {
  const namespace = env[MEMORY_NAMESPACE_ENV]?.trim();
  const profile = env[MEMORY_PROFILE_ENV]?.trim();
  if (!namespace && !profile) return undefined;
  if (!namespace || !profile) {
    throw new Error(`${MEMORY_NAMESPACE_ENV} and ${MEMORY_PROFILE_ENV} must be set together`);
  }
  return validateMemoryScope(namespace, profile, "Memory environment");
}

function piAgentDirectory(configured: string | undefined, homeDirectory: string): string {
  if (configured === undefined || configured === "") return join(homeDirectory, ".pi", "agent");
  if (configured === "~") return homeDirectory;
  return configured.startsWith("~/")
    ? join(homeDirectory, configured.slice(2))
    : resolve(configured);
}

function caughtMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readPiScope(configPath: string): unknown {
  let source: string;
  try {
    source = readFileSync(configPath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw new Error(`Cannot read Pi memory scope from ${configPath}: ${caughtMessage(error)}`, {
      cause: error,
    });
  }

  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`Cannot parse Pi memory scope from ${configPath}: ${caughtMessage(error)}`, {
      cause: error,
    });
  }
}

function trimmedString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

function parsePiScope(value: unknown, configPath: string): ProfileParams {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Pi memory scope at ${configPath} must be a JSON object`);
  }
  const record = value as Record<string, unknown>;
  return validateMemoryScope(
    trimmedString(record.namespace),
    trimmedString(record.profile),
    `Pi memory scope at ${configPath}`,
  );
}

/**
 * Resolve Pi's operational scope from environment first, then its agent-local
 * `memory-scope.json`. Pi does not load `.env` files, so the extension owns this
 * narrow non-secret configuration path.
 *
 * @param env - Pi process environment and optional scope override.
 * @param homeDirectory - Home directory used to expand the Pi agent path.
 * @returns {ProfileParams | undefined} The default scope, or `undefined` when Pi is unbound.
 */
export function configuredPiMemoryScope(
  env: Readonly<NodeJS.ProcessEnv> = process.env,
  homeDirectory: string = homedir(),
): ProfileParams | undefined {
  const environmentScope = configuredMemoryScope(env);
  if (environmentScope) return environmentScope;

  const agentDir = piAgentDirectory(env.PI_CODING_AGENT_DIR?.trim(), homeDirectory);
  const configPath = join(agentDir, PI_MEMORY_SCOPE_FILENAME);
  const value = readPiScope(configPath);
  return value === undefined ? undefined : parsePiScope(value, configPath);
}

/**
 * Fill in the host's scope when a call names neither namespace nor profile; a named pair stays.
 *
 * @param params - Already validated tool arguments.
 * @param scope - Host-bound namespace and profile, when configured.
 * @returns {T & ProfileParams} The arguments carrying the effective namespace and profile.
 */
export function applyMemoryScope<T extends object>(
  params: T,
  scope: ProfileParams | undefined,
): T & ProfileParams {
  if (scope === undefined || callerMemoryScope(params) !== "none") {
    return params as T & ProfileParams;
  }
  return { ...params, ...scope };
}

/**
 * How much of the namespace and profile pair a call names itself.
 *
 * @param params - Tool arguments.
 * @returns {"none" | "half" | "both"} Neither, only one of the two, or both.
 */
export function callerMemoryScope(params: object): "none" | "half" | "both" {
  const { namespace, profile } = params as Partial<ProfileParams>;
  if (namespace === undefined && profile === undefined) return "none";
  return namespace === undefined || profile === undefined ? "half" : "both";
}

/**
 * Bound writes carry the host session wherever they go; raw mode keeps the caller's session.
 *
 * @param params - Already validated write arguments.
 * @param scope - Host-bound namespace and profile, when configured.
 * @param harnessSessionId - Session identifier derived from the owning harness.
 * @returns {T & ProfileParams & { sessionId?: string }} Scoped write arguments with the effective session identifier.
 */
export function applyMemoryWriteScope<T extends object>(
  params: T,
  scope: ProfileParams | undefined,
  harnessSessionId: string | undefined,
): T & ProfileParams & { sessionId?: string } {
  const scoped = applyMemoryScope(params, scope) as T & ProfileParams & { sessionId?: string };
  if (!scope && scoped.sessionId) return scoped;
  return { ...scoped, sessionId: harnessSessionId };
}

/**
 * Build a stable, non-identifying session key from the harness, project, and harness conversation id.
 * The readable prefix aids audits; the digest avoids leaking full paths or conversation identifiers.
 *
 * @param harness - Stable harness label.
 * @param cwd - Project working directory.
 * @param conversationId - Harness-native conversation identifier.
 * @returns {string} A bounded, non-identifying session key.
 */
export function memorySessionId(harness: string, cwd: string, conversationId: string): string {
  const normalizedHarness = harness
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");
  const project = basename(resolve(cwd))
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "")
    .slice(0, 24);
  const key = new TextEncoder().encode(`${normalizedHarness}\0${resolve(cwd)}\0${conversationId}`);
  const digest = Buffer.from(sha256(key)).toString("hex").slice(0, 16);
  return `${normalizedHarness}-${project || "root"}-${digest}`.slice(
    0,
    MAX_TOOL_SESSION_ID_CHARACTERS,
  );
}

/**
 * Derive Claude Code's stable session key from environment injected into MCP children.
 *
 * @param env - Child-process environment supplied by Claude Code.
 * @returns {string | undefined} The derived key, or `undefined` outside a Claude Code session.
 */
export function claudeCodeMemorySessionId(
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): string | undefined {
  const cwd = env.CLAUDE_PROJECT_DIR?.trim();
  const conversationId = env.CLAUDE_CODE_SESSION_ID?.trim();
  if (!cwd || !conversationId) return undefined;
  return memorySessionId("claude", cwd, conversationId);
}

/**
 * Derive Grok CLI's stable session key from the environment injected into MCP children.
 * Grok injects only GROK_SESSION_ID and starts the child in the project root, so the child's
 * own working directory stands in for a directory variable. Both harnesses leak their session
 * variable into shell subprocesses, so a nested launch can carry both markers at once and the
 * caller decides which harness wins.
 *
 * @param env - Child-process environment supplied by Grok CLI.
 * @param cwd - Child working directory used as the project component.
 * @returns {string | undefined} The derived key, or `undefined` outside a Grok CLI session.
 */
export function grokMemorySessionId(
  env: Readonly<NodeJS.ProcessEnv> = process.env,
  cwd: string = process.cwd(),
): string | undefined {
  const conversationId = env.GROK_SESSION_ID?.trim();
  if (!conversationId) return undefined;
  return memorySessionId("grok", cwd, conversationId);
}
