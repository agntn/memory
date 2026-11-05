/** Vercel AI SDK tool surface over the shared memory tool definitions. */

import { toAiTools } from "@agntn/tools/ai";
import type { Tool } from "ai";
import {
  createMemoryTools,
  type MemoryToolName,
  type MemoryToolOptions,
  type ProfileMemoryToolName,
} from "../extensions/shared/memory-tool-definitions.ts";
import type { ProfileParams } from "../extensions/shared/memory-tools.types.ts";
import { validateMemoryScope } from "../extensions/shared/memory-scope.ts";
import { MAX_TOOL_SESSION_ID_CHARACTERS } from "../extensions/shared/memory-tool-contract.ts";

export type {
  MemoryToolName,
  ProfileMemoryToolName,
} from "../extensions/shared/memory-tool-definitions.ts";

/** Where the tools land. The app names it, and no scope variable in the env gets a vote. */
export interface MemoryAiToolOptions {
  /** Namespace for a call that names neither namespace nor profile. Set it with `profile`. */
  readonly namespace?: string;
  /** Profile for a call that names neither namespace nor profile. Set it with `namespace`. */
  readonly profile?: string;
  /** Session for a write that names none. Bound to a profile, the model can't name one. */
  readonly sessionId?: string;
  /** Leave it out, or use {@link LockedMemoryAiToolOptions} to lock the tools to the profile. */
  readonly locked?: false;
}

/** One profile and nothing else, for an app that serves many users from one account. */
export interface LockedMemoryAiToolOptions extends Omit<MemoryAiToolOptions, "locked"> {
  readonly namespace: string;
  readonly profile: string;
  /** No call can name another scope, and the namespace and profile tools are gone. */
  readonly locked: true;
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
 * Read `locked` strictly: a plain JS caller passing `"true"` must not get unlocked tools.
 *
 * @param locked - The option as the app passed it.
 * @returns {boolean} Whether the tools are locked.
 * @throws {TypeError} When the option is neither boolean nor left out.
 */
function lockedOption(locked: unknown): boolean {
  if (locked === undefined) return false;
  if (typeof locked !== "boolean") {
    throw new TypeError("Memory AI tool option locked must be a boolean");
  }
  return locked;
}

/**
 * The scope to bind. A locked set needs one, so it can't fall back to letting the model choose.
 *
 * @param options - Namespace and profile from the app.
 * @param locked - Whether the tools are locked.
 * @returns {ProfileParams | undefined} The checked pair, or nothing for unbound tools.
 * @throws {Error} When the pair is half set, missing under a lock, or a name is invalid.
 */
function memoryToolScope(
  options: Readonly<Pick<MemoryAiToolOptions, "namespace" | "profile">>,
  locked: boolean,
): ProfileParams | undefined {
  const { namespace, profile } = options;
  if (!locked && namespace === undefined && profile === undefined) return undefined;
  return validateMemoryScope(
    namespace,
    profile,
    locked ? "Locked memory AI tool options" : "Memory AI tool options",
  );
}

/**
 * Turn the app's options into the binding the shared definitions take, checked up front.
 *
 * @param options - Namespace, profile, write session and lock from the app.
 * @returns {MemoryToolOptions} The scope, write session and lock for every tool.
 * @throws {Error} When the pair is half set or missing under a lock, or a name or id is invalid.
 */
function memoryToolOptions(
  options: MemoryAiToolOptions | LockedMemoryAiToolOptions,
): MemoryToolOptions {
  const locked = lockedOption(options.locked);
  const scope = memoryToolScope(options, locked);
  const { sessionId } = options;
  const session = sessionId === undefined ? undefined : validateSessionId(sessionId);
  return {
    ...(scope === undefined ? {} : { scope }),
    ...(session === undefined ? {} : { writeSession: () => session }),
    ...(locked ? { locked } : {}),
  };
}

/**
 * The profile tools for the AI SDK, locked to the app's namespace and profile.
 *
 * @param options - Namespace, profile and write session the tools never leave.
 * @returns {Record<ProfileMemoryToolName, Tool>} The AI SDK tools, in listing order.
 * @throws {Error} When the pair is incomplete, a name is invalid, or the session id is unusable.
 */
export function createMemoryAiTools(
  options: LockedMemoryAiToolOptions,
): Record<ProfileMemoryToolName, Tool>;
/**
 * Every memory tool for the AI SDK, keyed by the name MCP, Pi and OMP use for it.
 *
 * @param options - Namespace, profile and write session the app binds the tools to.
 * @returns {Record<MemoryToolName, Tool>} The AI SDK tools, in listing order.
 * @throws {Error} When the pair is half set, a name is invalid, or the session id is unusable.
 */
export function createMemoryAiTools(options?: MemoryAiToolOptions): Record<MemoryToolName, Tool>;
/**
 * Build the AI SDK tools for either form.
 *
 * @param options - The app's binding, locked or not.
 * @returns {Partial<Record<MemoryToolName, Tool>>} The AI SDK tools, in listing order.
 * @throws {Error} When the options can't bind the tools as written.
 */
export function createMemoryAiTools(
  options: MemoryAiToolOptions | LockedMemoryAiToolOptions = {},
): Partial<Record<MemoryToolName, Tool>> {
  return toAiTools(createMemoryTools(memoryToolOptions(options))) as Partial<
    Record<MemoryToolName, Tool>
  >;
}
