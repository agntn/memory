import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  createOperationalMemoryToolSchemas,
  namespaceListParameters,
  namespaceParameters,
  profileOnlyParameters,
} from "../../shared/memory-tool-schemas.ts";
import {
  applyMemoryScope,
  applyMemoryWriteScope,
  configuredPiMemoryScope,
  memorySessionId,
} from "../../shared/memory-scope.ts";
import {
  memoryToolExecutors,
  memoryToolMeta,
  memoryToolProgress,
} from "../../shared/memory-tools.ts";
import type { RenderedToolResult, RenderOptions, StatusTheme } from "../../shared/tui.ts";
import { describeToolCall, renderStatusLine, renderToolResult } from "../../shared/tui.ts";
import type {
  GetParams,
  IngestParams,
  ListParams,
  MemoryParams,
  NamespaceListParams,
  NamespaceParams,
  ProfileParams,
  RecallParams,
  RememberParams,
  SessionParams,
  SummaryParams,
} from "../../shared/memory-tools.types.ts";

/** One streamed update: the progress line, with the real result still to come. */
function progress(text: string): AgentToolResult<Record<string, unknown>> {
  return { content: [{ type: "text", text }], details: {} };
}

/**
 * Render a finished call.
 *
 * Pi orders the renderer arguments `(result, options, theme, context)` and
 * reports a failure in the context. Its result object never carries the flag.
 */
function resultLine(
  result: RenderedToolResult,
  options: RenderOptions,
  theme: StatusTheme,
  context?: { isError?: boolean },
) {
  return new Text(renderToolResult(result, context?.isError ?? false, options, theme), 0, 0);
}

export default function memoryExtension(pi: ExtensionAPI) {
  const operationalScope = configuredPiMemoryScope();
  const {
    rememberParameters,
    ingestParameters,
    recallParameters,
    listParameters,
    getParameters,
    memoryParameters,
    sessionParameters,
    summaryParameters,
  } = createOperationalMemoryToolSchemas(Boolean(operationalScope));

  function operationalParams<T extends object>(params: T): T & ProfileParams {
    return applyMemoryScope(params, operationalScope);
  }

  function operationalWriteParams<T extends object>(
    params: T,
    ctx: ExtensionContext,
  ): T & ProfileParams & { sessionId?: string } {
    return applyMemoryWriteScope(
      params,
      operationalScope,
      memorySessionId("pi", ctx.cwd, ctx.sessionManager.getSessionId()),
    );
  }

  /**
   * Build the call renderer for one tool.
   *
   * Pi orders the renderer arguments `(args, theme, context)`. A scoped tool
   * hides the namespace and profile from the model, so the line reads them back
   * out of the configured scope.
   */
  function callRenderer(label: string, scoped = true) {
    return (args: object, theme: StatusTheme, context?: RenderOptions) => {
      const line = describeToolCall(label, scoped ? operationalParams(args) : args, context);
      return new Text(renderStatusLine(line, theme), 0, 0);
    };
  }
  pi.registerTool({
    name: "memory_namespace_list",
    ...memoryToolMeta.memory_namespace_list,
    promptSnippet: "List available Agent Memory namespaces.",
    promptGuidelines: ["Use cursor to page through results."],
    parameters: namespaceListParameters,
    renderCall: callRenderer(memoryToolMeta.memory_namespace_list.label, false),
    renderResult: resultLine,
    execute(
      _id,
      params: NamespaceListParams,
      signal,
    ): Promise<AgentToolResult<Record<string, unknown>>> {
      return memoryToolExecutors.listNamespaces(params, { signal });
    },
  });

  pi.registerTool({
    name: "memory_namespace_create",
    ...memoryToolMeta.memory_namespace_create,
    promptSnippet: "Create an Agent Memory namespace.",
    promptGuidelines: ["Namespace names are lowercase letters, numbers, and internal hyphens."],
    parameters: namespaceParameters,
    renderCall: callRenderer(memoryToolMeta.memory_namespace_create.label, false),
    renderResult: resultLine,
    execute(
      _id,
      params: NamespaceParams,
      signal,
    ): Promise<AgentToolResult<Record<string, unknown>>> {
      return memoryToolExecutors.createNamespace(params, { signal });
    },
  });

  pi.registerTool({
    name: "memory_namespace_delete",
    ...memoryToolMeta.memory_namespace_delete,
    promptSnippet: "Delete one exact Agent Memory namespace.",
    promptGuidelines: [
      "This is destructive and removes every profile and memory in the namespace.",
    ],
    parameters: namespaceParameters,
    renderCall: callRenderer(memoryToolMeta.memory_namespace_delete.label, false),
    renderResult: resultLine,
    execute(
      _id,
      params: NamespaceParams,
      signal,
    ): Promise<AgentToolResult<Record<string, unknown>>> {
      return memoryToolExecutors.deleteNamespace(params, { signal });
    },
  });

  pi.registerTool({
    name: "memory_remember",
    ...memoryToolMeta.memory_remember,
    promptSnippet: "Store a durable fact or instruction in agent memory.",
    promptGuidelines: ["Use only for information worth retaining across sessions."],
    parameters: rememberParameters,
    renderCall: callRenderer(memoryToolMeta.memory_remember.label),
    renderResult: resultLine,
    execute(
      _id,
      params,
      signal,
      _onUpdate,
      ctx,
    ): Promise<AgentToolResult<Record<string, unknown>>> {
      return memoryToolExecutors.remember(operationalWriteParams(params, ctx) as RememberParams, {
        signal,
      });
    },
  });

  pi.registerTool({
    name: "memory_ingest",
    ...memoryToolMeta.memory_ingest,
    promptSnippet: "Ingest conversation messages into agent memory.",
    promptGuidelines: [
      "Use for conversation history; use memory_remember for one explicit memory.",
    ],
    parameters: ingestParameters,
    renderCall: callRenderer(memoryToolMeta.memory_ingest.label),
    renderResult: resultLine,
    execute(_id, params, signal, onUpdate, ctx): Promise<AgentToolResult<Record<string, unknown>>> {
      onUpdate?.(progress(memoryToolProgress.memory_ingest));
      return memoryToolExecutors.ingest(operationalWriteParams(params, ctx) as IngestParams, {
        signal,
      });
    },
  });

  pi.registerTool({
    name: "memory_recall",
    ...memoryToolMeta.memory_recall,
    promptSnippet: "Recall durable context before answering or acting.",
    promptGuidelines: ["Use a focused natural-language query."],
    parameters: recallParameters,
    renderCall: callRenderer(memoryToolMeta.memory_recall.label),
    renderResult: resultLine,
    execute(_id, params, signal, onUpdate): Promise<AgentToolResult<Record<string, unknown>>> {
      onUpdate?.(progress(memoryToolProgress.memory_recall));
      return memoryToolExecutors.recall(operationalParams(params) as RecallParams, { signal });
    },
  });

  pi.registerTool({
    name: "memory_list",
    ...memoryToolMeta.memory_list,
    promptSnippet: "List memories by session or type.",
    promptGuidelines: ["Use cursor to page through results."],
    parameters: listParameters,
    renderCall: callRenderer(memoryToolMeta.memory_list.label),
    renderResult: resultLine,
    execute(_id, params, signal): Promise<AgentToolResult<Record<string, unknown>>> {
      return memoryToolExecutors.list(operationalParams(params) as ListParams, { signal });
    },
  });

  pi.registerTool({
    name: "memory_get",
    ...memoryToolMeta.memory_get,
    promptSnippet: memoryToolMeta.memory_get.description,
    promptGuidelines: ["Use exact memory ids returned by another memory tool."],
    parameters: getParameters,
    renderCall: callRenderer(memoryToolMeta.memory_get.label),
    renderResult: resultLine,
    execute(_id, params, signal): Promise<AgentToolResult<Record<string, unknown>>> {
      return memoryToolExecutors.get(operationalParams(params) as GetParams, { signal });
    },
  });

  pi.registerTool({
    name: "memory_delete",
    ...memoryToolMeta.memory_delete,
    promptSnippet: memoryToolMeta.memory_delete.description,
    promptGuidelines: ["Use an exact memory id returned by another memory tool."],
    parameters: memoryParameters,
    renderCall: callRenderer(memoryToolMeta.memory_delete.label),
    renderResult: resultLine,
    execute(_id, params, signal): Promise<AgentToolResult<Record<string, unknown>>> {
      return memoryToolExecutors.deleteMemory(operationalParams(params) as MemoryParams, {
        signal,
      });
    },
  });

  pi.registerTool({
    name: "memory_summary",
    ...memoryToolMeta.memory_summary,
    promptSnippet: "Get a compact memory summary.",
    promptGuidelines: ["Pass sessionId only when a session-scoped summary is needed."],
    parameters: summaryParameters,
    renderCall: callRenderer(memoryToolMeta.memory_summary.label),
    renderResult: resultLine,
    execute(_id, params, signal): Promise<AgentToolResult<Record<string, unknown>>> {
      return memoryToolExecutors.summary(operationalParams(params) as SummaryParams, { signal });
    },
  });

  pi.registerTool({
    name: "memory_delete_session",
    ...memoryToolMeta.memory_delete_session,
    promptSnippet: "Delete one exact memory session.",
    promptGuidelines: ["This is destructive; use only with an exact session id."],
    parameters: sessionParameters,
    renderCall: callRenderer(memoryToolMeta.memory_delete_session.label),
    renderResult: resultLine,
    execute(_id, params, signal): Promise<AgentToolResult<Record<string, unknown>>> {
      return memoryToolExecutors.deleteSession(operationalParams(params) as SessionParams, {
        signal,
      });
    },
  });

  pi.registerTool({
    name: "memory_delete_profile",
    ...memoryToolMeta.memory_delete_profile,
    promptSnippet: "Delete one exact memory profile.",
    promptGuidelines: ["This is destructive and removes the complete profile."],
    parameters: profileOnlyParameters,
    renderCall: callRenderer(memoryToolMeta.memory_delete_profile.label, false),
    renderResult: resultLine,
    execute(_id, params: ProfileParams, signal): Promise<AgentToolResult<Record<string, unknown>>> {
      return memoryToolExecutors.deleteProfile(params, { signal });
    },
  });
}
