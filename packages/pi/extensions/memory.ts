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
import { memoryToolExecutors, memoryToolMeta } from "../../shared/memory-tools.ts";
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

/** Pi orders the renderer arguments `(args, theme, context)`. */
function callLine(label: string, args: unknown, theme: StatusTheme, options?: RenderOptions) {
  return new Text(renderStatusLine(describeToolCall(label, args, options), theme), 0, 0);
}

/** Pi reports a failure through the render context, not in the result object. */
function resultLine(
  result: RenderedToolResult,
  options: RenderOptions,
  theme: StatusTheme,
  context?: { isError?: boolean },
) {
  const isError = context?.isError ?? result.isError ?? false;
  return new Text(renderToolResult(result, isError, options, theme), 0, 0);
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
  pi.registerTool({
    name: "memory_namespace_list",
    ...memoryToolMeta.memory_namespace_list,
    promptSnippet: "List available Agent Memory namespaces.",
    promptGuidelines: ["Use cursor to page through results."],
    parameters: namespaceListParameters,
    renderCall(args, theme, context) {
      return callLine(memoryToolMeta.memory_namespace_list.label, args, theme, context);
    },
    renderResult(result, options, theme, context) {
      return resultLine(result, options, theme, context);
    },
    execute(_id, params: NamespaceListParams): Promise<AgentToolResult<Record<string, unknown>>> {
      return memoryToolExecutors.listNamespaces(params);
    },
  });

  pi.registerTool({
    name: "memory_namespace_create",
    ...memoryToolMeta.memory_namespace_create,
    promptSnippet: "Create an Agent Memory namespace.",
    promptGuidelines: ["Namespace names are lowercase letters, numbers, and internal hyphens."],
    parameters: namespaceParameters,
    renderCall(args, theme, context) {
      return callLine(memoryToolMeta.memory_namespace_create.label, args, theme, context);
    },
    renderResult(result, options, theme, context) {
      return resultLine(result, options, theme, context);
    },
    execute(_id, params: NamespaceParams): Promise<AgentToolResult<Record<string, unknown>>> {
      return memoryToolExecutors.createNamespace(params);
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
    renderCall(args, theme, context) {
      return callLine(memoryToolMeta.memory_namespace_delete.label, args, theme, context);
    },
    renderResult(result, options, theme, context) {
      return resultLine(result, options, theme, context);
    },
    execute(_id, params: NamespaceParams): Promise<AgentToolResult<Record<string, unknown>>> {
      return memoryToolExecutors.deleteNamespace(params);
    },
  });

  pi.registerTool({
    name: "memory_remember",
    ...memoryToolMeta.memory_remember,
    promptSnippet: "Store a durable fact or instruction in agent memory.",
    promptGuidelines: ["Use only for information worth retaining across sessions."],
    parameters: rememberParameters,
    renderCall(args, theme, context) {
      return callLine(
        memoryToolMeta.memory_remember.label,
        operationalParams(args),
        theme,
        context,
      );
    },
    renderResult(result, options, theme, context) {
      return resultLine(result, options, theme, context);
    },
    execute(
      _id,
      params,
      _signal,
      _onUpdate,
      ctx,
    ): Promise<AgentToolResult<Record<string, unknown>>> {
      return memoryToolExecutors.remember(operationalWriteParams(params, ctx) as RememberParams);
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
    renderCall(args, theme, context) {
      return callLine(memoryToolMeta.memory_ingest.label, operationalParams(args), theme, context);
    },
    renderResult(result, options, theme, context) {
      return resultLine(result, options, theme, context);
    },
    execute(
      _id,
      params,
      _signal,
      _onUpdate,
      ctx,
    ): Promise<AgentToolResult<Record<string, unknown>>> {
      return memoryToolExecutors.ingest(operationalWriteParams(params, ctx) as IngestParams);
    },
  });

  pi.registerTool({
    name: "memory_recall",
    ...memoryToolMeta.memory_recall,
    promptSnippet: "Recall durable context before answering or acting.",
    promptGuidelines: ["Use a focused natural-language query."],
    parameters: recallParameters,
    renderCall(args, theme, context) {
      return callLine(memoryToolMeta.memory_recall.label, operationalParams(args), theme, context);
    },
    renderResult(result, options, theme, context) {
      return resultLine(result, options, theme, context);
    },
    execute(_id, params): Promise<AgentToolResult<Record<string, unknown>>> {
      return memoryToolExecutors.recall(operationalParams(params) as RecallParams);
    },
  });

  pi.registerTool({
    name: "memory_list",
    ...memoryToolMeta.memory_list,
    promptSnippet: "List memories by session or type.",
    promptGuidelines: ["Use cursor to page through results."],
    parameters: listParameters,
    renderCall(args, theme, context) {
      return callLine(memoryToolMeta.memory_list.label, operationalParams(args), theme, context);
    },
    renderResult(result, options, theme, context) {
      return resultLine(result, options, theme, context);
    },
    execute(_id, params): Promise<AgentToolResult<Record<string, unknown>>> {
      return memoryToolExecutors.list(operationalParams(params) as ListParams);
    },
  });

  pi.registerTool({
    name: "memory_get",
    ...memoryToolMeta.memory_get,
    promptSnippet: memoryToolMeta.memory_get.description,
    promptGuidelines: ["Use exact memory ids returned by another memory tool."],
    parameters: getParameters,
    renderCall(args, theme, context) {
      return callLine(memoryToolMeta.memory_get.label, operationalParams(args), theme, context);
    },
    renderResult(result, options, theme, context) {
      return resultLine(result, options, theme, context);
    },
    execute(_id, params): Promise<AgentToolResult<Record<string, unknown>>> {
      return memoryToolExecutors.get(operationalParams(params) as GetParams);
    },
  });

  pi.registerTool({
    name: "memory_delete",
    ...memoryToolMeta.memory_delete,
    promptSnippet: memoryToolMeta.memory_delete.description,
    promptGuidelines: ["Use an exact memory id returned by another memory tool."],
    parameters: memoryParameters,
    renderCall(args, theme, context) {
      return callLine(memoryToolMeta.memory_delete.label, operationalParams(args), theme, context);
    },
    renderResult(result, options, theme, context) {
      return resultLine(result, options, theme, context);
    },
    execute(_id, params): Promise<AgentToolResult<Record<string, unknown>>> {
      return memoryToolExecutors.deleteMemory(operationalParams(params) as MemoryParams);
    },
  });

  pi.registerTool({
    name: "memory_summary",
    ...memoryToolMeta.memory_summary,
    promptSnippet: "Get a compact memory summary.",
    promptGuidelines: ["Pass sessionId only when a session-scoped summary is needed."],
    parameters: summaryParameters,
    renderCall(args, theme, context) {
      return callLine(memoryToolMeta.memory_summary.label, operationalParams(args), theme, context);
    },
    renderResult(result, options, theme, context) {
      return resultLine(result, options, theme, context);
    },
    execute(_id, params): Promise<AgentToolResult<Record<string, unknown>>> {
      return memoryToolExecutors.summary(operationalParams(params) as SummaryParams);
    },
  });

  pi.registerTool({
    name: "memory_delete_session",
    ...memoryToolMeta.memory_delete_session,
    promptSnippet: "Delete one exact memory session.",
    promptGuidelines: ["This is destructive; use only with an exact session id."],
    parameters: sessionParameters,
    renderCall(args, theme, context) {
      return callLine(
        memoryToolMeta.memory_delete_session.label,
        operationalParams(args),
        theme,
        context,
      );
    },
    renderResult(result, options, theme, context) {
      return resultLine(result, options, theme, context);
    },
    execute(_id, params): Promise<AgentToolResult<Record<string, unknown>>> {
      return memoryToolExecutors.deleteSession(operationalParams(params) as SessionParams);
    },
  });

  pi.registerTool({
    name: "memory_delete_profile",
    ...memoryToolMeta.memory_delete_profile,
    promptSnippet: "Delete one exact memory profile.",
    promptGuidelines: ["This is destructive and removes the complete profile."],
    parameters: profileOnlyParameters,
    renderCall(args, theme, context) {
      return callLine(memoryToolMeta.memory_delete_profile.label, args, theme, context);
    },
    renderResult(result, options, theme, context) {
      return resultLine(result, options, theme, context);
    },
    execute(_id, params: ProfileParams): Promise<AgentToolResult<Record<string, unknown>>> {
      return memoryToolExecutors.deleteProfile(params);
    },
  });
}
