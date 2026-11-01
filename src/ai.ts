/** Vercel AI SDK tool surface over the shared memory tool definitions. */

import { toAiTools } from "@agntn/tools/ai";
import type { Tool } from "ai";
import {
  createMemoryTools,
  type MemoryToolName,
  type MemoryToolOptions,
} from "../extensions/shared/memory-tool-definitions.ts";
import { validateMemoryScope } from "../extensions/shared/memory-scope.ts";
import { MAX_TOOL_SESSION_ID_CHARACTERS } from "../extensions/shared/memory-tool-contract.ts";

export type { MemoryToolName } from "../extensions/shared/memory-tool-definitions.ts";

/** Where the tools land. The app names it, and no scope variable in the env gets a vote. */
export interface MemoryAiToolOptions {
  /** Namespace for a call that names neither namespace nor profile. Set it with `profile`. */
  readonly namespace?: string;
  /** Profile for a call that names neither namespace nor profile. Set it with `namespace`. */
  readonly profile?: string;
  /** Session for a write that names none. Bound to a profile, the model can't name one. */
  readonly sessionId?: string;
}

/**
 * Refuse a session id the service would drop or the write schema would never accept.
 *
 * @param sessionId - Session id the app passed.
 * @returns {string} The id, unchanged.
 * @throws {Error} When the id is blank or longer than a write accepts.
 */
function validateSessionId(sessionId: string): string {
  if (sessionId.trim() === "" || sessionId.length > MAX_TOOL_SESSION_ID_CHARACTERS) {
    throw new Error(
      `Memory session ID must be non-blank and at most ${MAX_TOOL_SESSION_ID_CHARACTERS} characters`,
    );
  }
  return sessionId;
}

/**
 * Turn the app's options into the binding the shared definitions take, checked up front.
 *
 * @param options - Namespace, profile and write session from the app.
 * @returns {MemoryToolOptions} The scope and write session for every tool.
 * @throws {Error} When the pair is half set, a name is invalid, or the session id is unusable.
 */
function memoryToolOptions(options: MemoryAiToolOptions): MemoryToolOptions {
  const { namespace, profile, sessionId } = options;
  const scope =
    namespace === undefined && profile === undefined
      ? undefined
      : validateMemoryScope(namespace, profile, "Memory AI tool options");
  const session = sessionId === undefined ? undefined : validateSessionId(sessionId);
  return {
    ...(scope === undefined ? {} : { scope }),
    ...(session === undefined ? {} : { writeSession: () => session }),
  };
}

/**
 * Every memory tool for the AI SDK, keyed by the name MCP, Pi and OMP use for it.
 *
 * @param options - Namespace, profile and write session the app binds the tools to.
 * @returns {Record<MemoryToolName, Tool>} The AI SDK tools, in listing order.
 * @throws {Error} When the pair is half set, a name is invalid, or the session id is unusable.
 */
export function createMemoryAiTools(
  options: MemoryAiToolOptions = {},
): Record<MemoryToolName, Tool> {
  return toAiTools(createMemoryTools(memoryToolOptions(options))) as Record<MemoryToolName, Tool>;
}
