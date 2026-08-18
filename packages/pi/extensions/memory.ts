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
  configuredMemoryScope,
  memorySessionId,
} from "../../shared/memory-scope.ts";
import { memoryTarget, memoryToolExecutors, memoryToolMeta } from "../../shared/memory-tools.ts";
import type {
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

function callText(
  name: string,
  suffix: string,
  theme: { bold(text: string): string; fg(color: string, text: string): string },
) {
  return new Text(theme.fg("toolTitle", theme.bold(`${name} ${suffix}`)), 0, 0);
}

export default function memoryExtension(pi: ExtensionAPI) {
  const operationalScope = configuredMemoryScope();
  const {
    rememberParameters,
    ingestParameters,
    recallParameters,
    listParameters,
    memoryParameters,
    sessionParameters,
    summaryParameters,
  } = createOperationalMemoryToolSchemas(Boolean(operationalScope));

  function operationalParams<T extends object>(params: T): T & ProfileParams {
    return operationalScope
      ? applyMemoryScope(params, operationalScope)
      : (params as T & ProfileParams);
  }

  function operationalWriteParams<T extends object>(
    params: T,
    ctx: ExtensionContext,
  ): T & ProfileParams & { sessionId?: string } {
    const scoped = operationalParams(params) as T & ProfileParams & { sessionId?: string };
    return scoped.sessionId
      ? scoped
      : {
          ...scoped,
          sessionId: memorySessionId("pi", ctx.cwd, ctx.sessionManager.getSessionId()),
        };
  }
  pi.registerTool({
    name: "memory_namespace_list",
    ...memoryToolMeta.memory_namespace_list,
    promptSnippet: "List available Agent Memory namespaces.",
    promptGuidelines: ["Use cursor to page through results."],
    parameters: namespaceListParameters,
    renderCall(_args, theme) {
      return callText("memory_namespace_list", "account", theme);
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
    renderCall(args, theme) {
      return callText("memory_namespace_create", args.namespace, theme);
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
    renderCall(args, theme) {
      return callText("memory_namespace_delete", args.namespace, theme);
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
    renderCall(args, theme) {
      return callText("memory_remember", memoryTarget(operationalParams(args)), theme);
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
    renderCall(args, theme) {
      return callText("memory_ingest", memoryTarget(operationalParams(args)), theme);
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
    renderCall(args, theme) {
      return callText("memory_recall", memoryTarget(operationalParams(args)), theme);
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
    renderCall(args, theme) {
      return callText("memory_list", memoryTarget(operationalParams(args)), theme);
    },
    execute(_id, params): Promise<AgentToolResult<Record<string, unknown>>> {
      return memoryToolExecutors.list(operationalParams(params) as ListParams);
    },
  });

  for (const definition of [
    { name: "memory_get", operation: "get" as const },
    { name: "memory_delete", operation: "delete" as const },
  ] as const) {
    pi.registerTool({
      name: definition.name,
      ...memoryToolMeta[definition.name],
      promptSnippet: memoryToolMeta[definition.name].description,
      promptGuidelines: ["Use an exact memory id returned by another memory tool."],
      parameters: memoryParameters,
      renderCall(args, theme) {
        const params = operationalParams(args);
        return callText(definition.name, `${memoryTarget(params)}:${params.memoryId}`, theme);
      },
      execute(_id, params): Promise<AgentToolResult<Record<string, unknown>>> {
        return memoryToolExecutors.memory(
          operationalParams(params) as MemoryParams,
          definition.operation,
        );
      },
    });
  }

  pi.registerTool({
    name: "memory_summary",
    ...memoryToolMeta.memory_summary,
    promptSnippet: "Get a compact memory summary.",
    promptGuidelines: ["Pass sessionId only when a session-scoped summary is needed."],
    parameters: summaryParameters,
    renderCall(args, theme) {
      return callText("memory_summary", memoryTarget(operationalParams(args)), theme);
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
    renderCall(args, theme) {
      const params = operationalParams(args);
      return callText(
        "memory_delete_session",
        `${memoryTarget(params)}:${params.sessionId}`,
        theme,
      );
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
    renderCall(args, theme) {
      return callText("memory_delete_profile", memoryTarget(args), theme);
    },
    execute(_id, params: ProfileParams): Promise<AgentToolResult<Record<string, unknown>>> {
      return memoryToolExecutors.deleteProfile(params);
    },
  });
}
