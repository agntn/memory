/** Vercel AI SDK tool surface over the shared memory tool definitions. */

import { toAiTools } from "@agntn/tools/ai";
import type { Tool } from "ai";
import {
  type BindingMemoryToolName,
  createMemoryTools,
  type MemoryToolName,
  type MemoryToolOptions,
  type ProfileMemoryToolName,
} from "../extensions/shared/memory-tool-definitions.ts";
import type { ProfileParams } from "../extensions/shared/memory-tools.types.ts";
import { validateMemoryScope } from "../extensions/shared/memory-scope.ts";
import { MAX_TOOL_SESSION_ID_CHARACTERS } from "../extensions/shared/memory-tool-contract.ts";
import type { AgentMemoryNamespaceBinding } from "./providers/cloudflare.ts";

export type {
  BindingMemoryToolName,
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
  /** Leave it out, or use {@link BoundMemoryAiToolOptions} for a Workers binding. */
  readonly binding?: undefined;
}

/** Tools inside a Worker, over its Memory binding. No API token to babysit. */
export interface BoundMemoryAiToolOptions extends Omit<
  MemoryAiToolOptions,
  "namespace" | "profile" | "binding"
> {
  /** The namespace the binding serves. Calls can't leave it. */
  readonly namespace: string;
  readonly profile: string;
  /** The Memory binding from `env`. */
  readonly binding: AgentMemoryNamespaceBinding;
}

/** One profile and nothing else, for an app that serves many users from one account. */
export interface LockedMemoryAiToolOptions extends Omit<MemoryAiToolOptions, "locked" | "binding"> {
  readonly namespace: string;
  readonly profile: string;
  /** No call can name another scope, and the namespace and profile tools are gone. */
  readonly locked: true;
  /** The Memory binding from `env`, instead of HTTP and a token. */
  readonly binding?: AgentMemoryNamespaceBinding;
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
 * Check the binding now, not on the model's first call.
 *
 * @param binding - The option as the app passed it.
 * @returns {AgentMemoryNamespaceBinding | undefined} The binding, or nothing for HTTP.
 * @throws {TypeError} When it has no `getProfile` or `deleteProfile` to call.
 */
function bindingOption(binding: unknown): AgentMemoryNamespaceBinding | undefined {
  if (binding === undefined) return undefined;
  const { getProfile, deleteProfile } = (binding ?? {}) as Record<string, unknown>;
  if (typeof getProfile !== "function" || typeof deleteProfile !== "function") {
    throw new TypeError("Memory AI tool option binding must be a Workers Memory binding");
  }
  return binding as AgentMemoryNamespaceBinding;
}

/**
 * The scope to bind. Locked and bound sets can't leave it to the model.
 *
 * @param options - Namespace and profile from the app.
 * @param locked - Whether the tools are locked.
 * @param bound - Whether the tools go through a Workers binding.
 * @returns {ProfileParams | undefined} The checked pair, or nothing for unbound tools.
 * @throws {Error} When the pair is half set, missing when required, or a name is invalid.
 */
function memoryToolScope(
  options: Readonly<Pick<MemoryAiToolOptions, "namespace" | "profile">>,
  locked: boolean,
  bound: boolean,
): ProfileParams | undefined {
  const { namespace, profile } = options;
  if (!locked && !bound && namespace === undefined && profile === undefined) return undefined;
  return validateMemoryScope(
    namespace,
    profile,
    locked ? "Locked memory AI tool options" : "Memory AI tool options",
  );
}

/**
 * Turn the app's options into the binding the shared definitions take, checked up front.
 *
 * @param options - Namespace, profile, write session, lock and binding from the app.
 * @returns {MemoryToolOptions} The scope, write session, lock and binding for every tool.
 * @throws {Error} When an option can't bind the tools.
 */
function memoryToolOptions(
  options: MemoryAiToolOptions | LockedMemoryAiToolOptions | BoundMemoryAiToolOptions,
): MemoryToolOptions {
  const locked = lockedOption(options.locked);
  const binding = bindingOption(options.binding);
  const scope = memoryToolScope(options, locked, binding !== undefined);
  const { sessionId } = options;
  const session = sessionId === undefined ? undefined : validateSessionId(sessionId);
  return {
    ...(scope === undefined ? {} : { scope }),
    ...(session === undefined ? {} : { writeSession: () => session }),
    ...(locked ? { locked } : {}),
    ...(binding === undefined ? {} : { binding }),
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
 * The memory tools a Workers binding can serve, kept in its namespace.
 *
 * @param options - Binding, namespace, profile and write session from the app.
 * @returns {Record<BindingMemoryToolName, Tool>} The AI SDK tools, in listing order.
 * @throws {Error} When the binding, the pair or the session id is unusable.
 */
export function createMemoryAiTools(
  options: BoundMemoryAiToolOptions,
): Record<BindingMemoryToolName, Tool>;
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
  options: MemoryAiToolOptions | LockedMemoryAiToolOptions | BoundMemoryAiToolOptions = {},
): Partial<Record<MemoryToolName, Tool>> {
  return toAiTools(createMemoryTools(memoryToolOptions(options))) as Partial<
    Record<MemoryToolName, Tool>
  >;
}
