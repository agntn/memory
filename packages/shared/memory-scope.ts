import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import type { ProfileParams } from "./memory-tools.types.ts";
import {
  MAX_TOOL_NAMESPACE_CHARACTERS,
  MAX_TOOL_PROFILE_CHARACTERS,
  MAX_TOOL_SESSION_ID_CHARACTERS,
  MEMORY_NAME_PATTERN,
} from "./memory-tools.ts";

export const MEMORY_NAMESPACE_ENV = "AGNTN_MEMORY_NAMESPACE";
export const MEMORY_PROFILE_ENV = "AGNTN_MEMORY_PROFILE";

const memoryNamePattern = new RegExp(MEMORY_NAME_PATTERN);

function validateMemoryName(name: string, label: string, maxLength: number): string {
  if (name.length > maxLength || !memoryNamePattern.test(name)) {
    throw new Error(
      `${label} must match ${MEMORY_NAME_PATTERN} and be at most ${maxLength} characters`,
    );
  }
  return name;
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
  return {
    namespace: validateMemoryName(namespace, "Memory namespace", MAX_TOOL_NAMESPACE_CHARACTERS),
    profile: validateMemoryName(profile, "Memory profile", MAX_TOOL_PROFILE_CHARACTERS),
  };
}

/** Inject a fixed scope after tool argument validation, so callers cannot select another profile. */
export function applyMemoryScope<T extends object>(
  params: T,
  scope: ProfileParams,
): T & ProfileParams {
  return { ...params, ...scope };
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
