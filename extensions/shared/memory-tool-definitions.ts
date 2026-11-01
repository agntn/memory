import {
  defineTool,
  type TObject,
  type ToolCallContext,
  type ToolDefinition,
  type ToolEffect,
  ToolInputError,
} from "@agntn/tools";
import type { AbortOptions } from "@agntn/memory";
import {
  createOperationalMemoryToolSchemas,
  namespaceListParameters,
  namespaceParameters,
  profileListParameters,
  profileOnlyParameters,
} from "./memory-tool-schemas.ts";
import {
  applyMemoryScope,
  applyMemoryWriteScope,
  callerMemoryScope,
  memorySessionId,
} from "./memory-scope.ts";
import { memoryToolMeta, memoryToolProgress } from "./memory-tool-contract.ts";
import type * as MemoryTools from "./memory-tools.ts";
import type { MemoryToolResult, ProfileParams } from "./memory-tools.types.ts";
import { toolErrorMessage } from "./tool-errors.ts";

export type MemoryToolName = keyof typeof memoryToolMeta;

/** How each surface binds the calls it serves. */
export interface MemoryToolOptions {
  /** Namespace and profile a call gets when it names neither of them. */
  readonly scope?: ProfileParams;
  /** The host's conversation session for a write, read from the call's `host`. */
  readonly writeSession?: (host: unknown) => string | undefined;
}

/** How far the configured scope reaches into a call: administration, a profile read, or a write. */
type ScopeReach = "none" | "profile" | "write";

interface MemoryToolSpec {
  readonly name: MemoryToolName;
  readonly input: TObject;
  readonly effect: ToolEffect;
  readonly idempotent?: boolean;
  readonly reach: ScopeReach;
  readonly snippet: string;
  readonly guidelines: readonly string[];
  readonly operation: keyof typeof MemoryTools.memoryToolExecutors;
}

let executors: Promise<typeof MemoryTools> | undefined;

/**
 * Load the executors on the first call, so registering the tools stays cheap.
 *
 * @returns {Promise<typeof MemoryTools>} The executor module.
 */
function loadExecutors(): Promise<typeof MemoryTools> {
  executors ??= import("./memory-tools.ts");
  return executors;
}

/** MCP sends a still-waiting note this often while a call can run up to its timeout. */
const PROGRESS_INTERVAL_MS = 30_000;

const administrationTools: ReadonlySet<MemoryToolName> = new Set([
  "memory_namespace_list",
  "memory_namespace_get",
  "memory_namespace_create",
  "memory_namespace_delete",
  "memory_profile_list",
  "memory_profile_delete",
]);

/**
 * Arguments as a call line shows them, with the default scope filled in where the call left it out.
 *
 * @param name - Tool the arguments belong to.
 * @param args - Arguments the model sent.
 * @param scope - Namespace and profile the host defaults to, if any.
 * @returns {object} The arguments with the scope filled in where the tool takes it.
 */
export function scopedCallArguments(
  name: MemoryToolName,
  args: object,
  scope: ProfileParams | undefined,
): object {
  return administrationTools.has(name) ? args : applyMemoryScope(args, scope);
}

/**
 * Session id for a write from Pi's or OMP's own `ctx`, which the adapters hand over as `host`.
 *
 * @param harness - Harness name the id starts with.
 * @param host - The host context of the call.
 * @returns {string | undefined} The derived session id, or nothing for a host without a session.
 */
export function hostSessionId(harness: string, host: unknown): string | undefined {
  if (typeof host !== "object" || host === null) return undefined;
  const { cwd, sessionManager } = host as { cwd?: unknown; sessionManager?: unknown };
  if (typeof cwd !== "string" || typeof sessionManager !== "object" || sessionManager === null) {
    return undefined;
  }
  const { getSessionId } = sessionManager as { getSessionId?: unknown };
  if (typeof getSessionId !== "function") return undefined;
  const sessionId: unknown = getSessionId.call(sessionManager);
  return typeof sessionId === "string" ? memorySessionId(harness, cwd, sessionId) : undefined;
}

/**
 * Report a long call: one line at the start, then the elapsed share of its timeout every 30 s.
 *
 * @param name - Tool being called.
 * @param params - Validated arguments, read for `timeoutSeconds`.
 * @param context - Call context whose `progress` the host draws.
 * @returns {() => void} Stops the timer once the call settles.
 */
function startProgress(name: MemoryToolName, params: object, context: ToolCallContext): () => void {
  const { progress } = context;
  const message: string | undefined = (memoryToolProgress as Partial<Record<string, string>>)[name];
  if (progress === undefined || message === undefined) return () => undefined;
  const timeoutSeconds: unknown = (params as { timeoutSeconds?: unknown }).timeoutSeconds;
  if (typeof timeoutSeconds !== "number") {
    progress(message);
    return () => undefined;
  }
  const total = timeoutSeconds * 1_000;
  const startedAt = performance.now();
  progress(message, { progress: 0, total });
  const timer = setInterval(() => {
    progress(message, {
      progress: Math.min(Math.round(performance.now() - startedAt), total),
      total,
    });
  }, PROGRESS_INTERVAL_MS);
  return () => clearInterval(timer);
}

/**
 * Refuse half a pair: completing it from the default would land the call in a third profile.
 *
 * @param input - Arguments the core validated.
 * @param scope - The host's default scope.
 * @throws {ToolInputError} When exactly one of the two is present.
 */
function assertWholeScope(input: object, scope: ProfileParams | undefined): void {
  if (scope === undefined || callerMemoryScope(input) !== "half") return;
  throw new ToolInputError([
    `Invalid arguments: pass namespace and profile together, or neither for ${scope.namespace}/${scope.profile}`,
  ]);
}

/**
 * Bind the scope and stream progress. The causes go into the message, the only part hosts show.
 *
 * @param spec - The tool being called.
 * @param input - Arguments the core validated.
 * @param context - Per-call context from the adapter.
 * @param binding - Scope and session binding of the surface.
 * @returns {Promise<MemoryToolResult>} The executor's result.
 * @throws {ToolInputError} When the call names only half of its scope.
 * @throws {Error} The executor's failure with its causes in the message.
 */
async function runMemoryTool(
  spec: MemoryToolSpec,
  input: object,
  context: ToolCallContext,
  binding: MemoryToolOptions,
): Promise<MemoryToolResult> {
  if (spec.reach !== "none") assertWholeScope(input, binding.scope);
  const params =
    spec.reach === "none"
      ? input
      : spec.reach === "profile"
        ? applyMemoryScope(input, binding.scope)
        : applyMemoryWriteScope(input, binding.scope, binding.writeSession?.(context.host));
  const stopProgress = startProgress(spec.name, params, context);
  try {
    const { memoryToolExecutors } = await loadExecutors();
    const options: AbortOptions = { signal: context.signal };
    return await memoryToolExecutors[spec.operation](params as never, options);
  } catch (error) {
    throw new Error(toolErrorMessage(error), { cause: error });
  } finally {
    stopProgress();
  }
}

/**
 * The tool table, in the order every surface lists it.
 *
 * @param scope - Namespace and profile the host defaults to, if any.
 * @returns {readonly MemoryToolSpec[]} One entry per tool.
 */
function memoryToolSpecs(scope: ProfileParams | undefined): readonly MemoryToolSpec[] {
  const schemas = createOperationalMemoryToolSchemas(scope);
  return [
    {
      name: "memory_namespace_list",
      input: namespaceListParameters,
      effect: "read",
      reach: "none",
      snippet: "List available Agent Memory namespaces.",
      guidelines: ["Use cursor to page through results."],
      operation: "listNamespaces",
    },
    {
      name: "memory_namespace_get",
      input: namespaceParameters,
      effect: "read",
      reach: "none",
      snippet: "Get one exact Agent Memory namespace.",
      guidelines: ["Use the exact name; memory_namespace_list shows the existing ones."],
      operation: "getNamespace",
    },
    {
      name: "memory_namespace_create",
      input: namespaceParameters,
      effect: "write",
      reach: "none",
      snippet: "Create an Agent Memory namespace.",
      guidelines: ["Namespace names are lowercase letters, numbers, and internal hyphens."],
      operation: "createNamespace",
    },
    {
      name: "memory_namespace_delete",
      input: namespaceParameters,
      effect: "destructive",
      idempotent: true,
      reach: "none",
      snippet: "Delete one exact Agent Memory namespace.",
      guidelines: ["This is destructive and removes every profile and memory in the namespace."],
      operation: "deleteNamespace",
    },
    {
      name: "memory_profile_list",
      input: profileListParameters,
      effect: "read",
      reach: "none",
      snippet: "List the profiles one Agent Memory namespace holds.",
      guidelines: ["Use cursor to page through results."],
      operation: "listProfiles",
    },
    {
      name: "memory_remember",
      input: schemas.rememberParameters,
      effect: "write",
      reach: "write",
      snippet: "Store a durable fact or instruction in agent memory.",
      guidelines: ["Use only for information worth retaining across sessions."],
      operation: "remember",
    },
    {
      name: "memory_supersede",
      input: schemas.supersedeParameters,
      effect: "destructive",
      idempotent: false,
      reach: "write",
      snippet: "Replace a durable memory without deleting the old record first.",
      guidelines: [
        "Use the old id and the exact recall query that must find the replacement before deletion.",
      ],
      operation: "supersede",
    },
    {
      name: "memory_supersession_resume",
      input: schemas.resumeSupersessionParameters,
      effect: "destructive",
      idempotent: false,
      reach: "profile",
      snippet: "Finish a supersession from the replacement memory already stored.",
      guidelines: [
        "Use both ids from the failed memory_supersede call and the same expected content and query.",
      ],
      operation: "resumeSupersession",
    },
    {
      name: "memory_recall_wait",
      input: schemas.recallVisibilityParameters,
      effect: "read",
      reach: "profile",
      snippet: "Wait until one stored memory can be found through recall.",
      guidelines: ["Pass the exact id returned by memory_remember and the query you will reuse."],
      operation: "waitForRecall",
    },
    {
      name: "memory_ingest",
      input: schemas.ingestParameters,
      effect: "write",
      reach: "write",
      snippet: "Ingest conversation messages into agent memory.",
      guidelines: [
        "Use for conversation history; use memory_remember for one explicit memory.",
        "Ingesting the same messages again runs extraction again and supersedes what it extracted before, so read the ids from memory_list afresh afterwards.",
      ],
      operation: "ingest",
    },
    {
      name: "memory_recall",
      input: schemas.recallParameters,
      effect: "read",
      reach: "profile",
      snippet: "Recall durable context before answering or acting.",
      guidelines: [
        "Use a focused natural-language query.",
        "A candidate marked kind: message is a raw ingested message with its text under the line; no memory record answers its id.",
      ],
      operation: "recall",
    },
    {
      name: "memory_list",
      input: schemas.listParameters,
      effect: "read",
      reach: "profile",
      snippet: "List memories by session or type, oldest first.",
      guidelines: [
        "Pages run from the oldest memory up and cannot be reversed. Use cursor to page forward, sessionId to see one session, memory_recall for recent facts.",
      ],
      operation: "list",
    },
    {
      name: "memory_get",
      input: schemas.getParameters,
      effect: "read",
      reach: "profile",
      snippet: memoryToolMeta.memory_get.description,
      guidelines: ["Use exact memory ids returned by another memory tool."],
      operation: "get",
    },
    {
      name: "memory_delete",
      input: schemas.memoryParameters,
      effect: "destructive",
      idempotent: true,
      reach: "profile",
      snippet: memoryToolMeta.memory_delete.description,
      guidelines: ["Use an exact memory id returned by another memory tool."],
      operation: "deleteMemory",
    },
    {
      name: "memory_summary",
      input: schemas.summaryParameters,
      effect: "read",
      reach: "profile",
      snippet: "Summarize everything a profile holds when there is no specific question to ask.",
      guidelines: [
        "The summary always covers the whole profile; sessionId only picks the session named on its Current session line. Use memory_list with sessionId to see one session.",
      ],
      operation: "summary",
    },
    {
      name: "memory_session_delete",
      input: schemas.sessionParameters,
      effect: "destructive",
      idempotent: true,
      reach: "profile",
      snippet: "Delete one exact memory session.",
      guidelines: ["This is destructive; use only with an exact session id."],
      operation: "deleteSession",
    },
    {
      name: "memory_profile_delete",
      input: profileOnlyParameters,
      effect: "destructive",
      idempotent: true,
      reach: "none",
      snippet: "Delete one exact memory profile.",
      guidelines: ["This is destructive and removes the complete profile."],
      operation: "deleteProfile",
    },
  ];
}

/**
 * Every memory tool as one `@agntn/tools` definition, for every surface from MCP to the AI SDK.
 *
 * @param options - Scope and session binding of the surface serving them.
 * @returns {readonly ToolDefinition[]} The definitions, in listing order.
 */
export function createMemoryTools(options: MemoryToolOptions = {}): readonly ToolDefinition[] {
  return memoryToolSpecs(options.scope).map((spec) =>
    defineTool({
      name: spec.name,
      title: memoryToolMeta[spec.name].label,
      description: memoryToolMeta[spec.name].description,
      snippet: spec.snippet,
      guidelines: spec.guidelines,
      effect: spec.effect,
      ...(spec.idempotent === undefined ? {} : { idempotent: spec.idempotent }),
      openWorld: true,
      input: spec.input,
      execute: (input: object, context) => runMemoryTool(spec, input, context, options),
    }),
  );
}
