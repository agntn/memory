import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { Text } from "@oh-my-pi/pi-tui";
import {
  ISO_INSTANT_PATTERN,
  MAX_TOOL_INGEST_MESSAGES,
  MAX_TOOL_LIST_LIMIT,
  MAX_TOOL_MESSAGE_CHARACTERS,
  MAX_TOOL_NAMESPACE_CHARACTERS,
  MAX_TOOL_PROFILE_CHARACTERS,
  MAX_TOOL_QUERY_CHARACTERS,
  MAX_TOOL_SESSION_ID_CHARACTERS,
  MEMORY_ID_PATTERN,
  MEMORY_NAME_PATTERN,
  memoryTarget,
  memoryToolExecutors,
  memoryToolMeta,
} from "../../shared/memory-tools.ts";
import {
  applyMemoryScope,
  configuredMemoryScope,
  memorySessionId,
} from "../../shared/memory-scope.ts";
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

/**
 * Rebuild the shared parameter shapes with OMP's TypeBox.
 *
 * OMP validates tool parameters with its host build, so these schemas cannot be
 * imported from `shared/memory-tool-schemas.ts`, which Pi and MCP share.
 */
function createParameters(Type: ExtensionAPI["typebox"]["Type"], scoped: boolean) {
  const namespaceName = Type.String({
    description:
      "Cloudflare Agent Memory namespace. The service accepts lowercase letters, numbers, and internal hyphens only. List existing ones with memory_namespace_list.",
    minLength: 1,
    maxLength: MAX_TOOL_NAMESPACE_CHARACTERS,
    pattern: MEMORY_NAME_PATTERN,
  });
  const profileParameters = {
    namespace: namespaceName,
    profile: Type.String({
      description:
        "Memory profile inside the namespace. The service accepts lowercase letters, numbers, and internal hyphens only. A profile starts existing on its first write; there is no profile listing.",
      minLength: 1,
      maxLength: MAX_TOOL_PROFILE_CHARACTERS,
      pattern: MEMORY_NAME_PATTERN,
    }),
  };
  const sessionIdDescription =
    "Session identifier grouping related memories. It is the only unit memory_delete_session can remove, so pass one whenever the memories may need removing together.";
  const cursorDescription =
    "Cursor copied from the previous response. A response without a cursor was the last page.";
  const parameters = {
    namespaceParameters: Type.Object({ namespace: namespaceName }),
    namespaceListParameters: Type.Object({
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_TOOL_LIST_LIMIT,
          description: `Namespaces per page, 1-${MAX_TOOL_LIST_LIMIT}.`,
        }),
      ),
      cursor: Type.Optional(Type.String({ description: cursorDescription })),
      order: Type.Optional(
        Type.Union([Type.Literal("id"), Type.Literal("name")], { description: "Sort field." }),
      ),
      direction: Type.Optional(
        Type.Union([Type.Literal("asc"), Type.Literal("desc")], {
          description: "Sort direction.",
        }),
      ),
    }),
    rememberParameters: Type.Object({
      ...profileParameters,
      content: Type.String({
        description:
          "Memory content to store. The service writes it verbatim, assigns the memory type itself, and publishes no size limit for this field.",
        minLength: 1,
      }),
      sessionId: Type.Optional(
        Type.String({
          description: sessionIdDescription,
          maxLength: MAX_TOOL_SESSION_ID_CHARACTERS,
        }),
      ),
    }),
    ingestParameters: Type.Object({
      ...profileParameters,
      messages: Type.Array(
        Type.Object({
          role: Type.Union(
            [Type.Literal("system"), Type.Literal("user"), Type.Literal("assistant")],
            { description: "Who produced the message." },
          ),
          content: Type.String({
            description: "Message text.",
            minLength: 1,
            maxLength: MAX_TOOL_MESSAGE_CHARACTERS,
          }),
          timestamp: Type.Optional(
            Type.String({
              description:
                "When the message was sent, as an ISO-8601 instant with an explicit offset, for example 2026-08-17T10:00:00Z.",
              pattern: ISO_INSTANT_PATTERN,
            }),
          ),
        }),
        {
          minItems: 1,
          maxItems: MAX_TOOL_INGEST_MESSAGES,
          description: "Conversation messages in the order they were exchanged.",
        },
      ),
      sessionId: Type.Optional(
        Type.String({
          description: sessionIdDescription,
          maxLength: MAX_TOOL_SESSION_ID_CHARACTERS,
        }),
      ),
    }),
    recallParameters: Type.Object({
      ...profileParameters,
      query: Type.String({
        description: "Natural-language recall query.",
        minLength: 1,
        maxLength: MAX_TOOL_QUERY_CHARACTERS,
      }),
      thinkingLevel: Type.Optional(
        Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], {
          description:
            "Retrieval breadth. Higher levels search more candidates and take longer. Defaults to low.",
        }),
      ),
      responseLength: Type.Optional(
        Type.Union([Type.Literal("short"), Type.Literal("medium"), Type.Literal("long")], {
          description: "Requested length of the prose answer. Defaults to medium.",
        }),
      ),
      referenceDate: Type.Optional(
        Type.String({
          description: "ISO-8601 date the service treats as now when the query is time-relative.",
        }),
      ),
    }),
    listParameters: Type.Object({
      ...profileParameters,
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_TOOL_LIST_LIMIT,
          description: `Memories per page, 1-${MAX_TOOL_LIST_LIMIT}.`,
        }),
      ),
      cursor: Type.Optional(Type.String({ description: cursorDescription })),
      sessionId: Type.Optional(
        Type.String({
          description: "Return only memories from this session.",
          maxLength: MAX_TOOL_SESSION_ID_CHARACTERS,
        }),
      ),
      type: Type.Optional(
        Type.Union(
          [
            Type.Literal("fact"),
            Type.Literal("event"),
            Type.Literal("instruction"),
            Type.Literal("task"),
          ],
          { description: "Filter by the type the service assigned when the memory was written." },
        ),
      ),
    }),
    memoryParameters: Type.Object({
      ...profileParameters,
      memoryId: Type.String({
        description: "Exact memory identifier from memory_list, memory_remember, or memory_recall.",
        minLength: 1,
        pattern: MEMORY_ID_PATTERN,
      }),
    }),
    sessionParameters: Type.Object({
      ...profileParameters,
      sessionId: Type.String({
        description: "Exact session identifier. Every memory carrying it is removed.",
        minLength: 1,
        maxLength: MAX_TOOL_SESSION_ID_CHARACTERS,
        pattern: MEMORY_ID_PATTERN,
      }),
    }),
    summaryParameters: Type.Object({
      ...profileParameters,
      sessionId: Type.Optional(
        Type.String({
          description: "Summarize only this session instead of the whole profile.",
          maxLength: MAX_TOOL_SESSION_ID_CHARACTERS,
        }),
      ),
    }),
    profileOnlyParameters: Type.Object(profileParameters),
  };
  if (!scoped) return parameters;
  return {
    ...parameters,
    rememberParameters: Type.Omit(parameters.rememberParameters, [
      "namespace",
      "profile",
      "sessionId",
    ]),
    ingestParameters: Type.Omit(parameters.ingestParameters, ["namespace", "profile", "sessionId"]),
    recallParameters: Type.Omit(parameters.recallParameters, ["namespace", "profile"]),
    listParameters: Type.Omit(parameters.listParameters, ["namespace", "profile"]),
    memoryParameters: Type.Omit(parameters.memoryParameters, ["namespace", "profile"]),
    summaryParameters: Type.Omit(parameters.summaryParameters, ["namespace", "profile"]),
    sessionParameters: Type.Omit(parameters.sessionParameters, ["namespace", "profile"]),
  };
}

function callText(
  name: string,
  suffix: string,
  theme: { bold(text: string): string; fg(color: string, text: string): string },
) {
  return new Text(theme.fg("toolTitle", theme.bold(`${name} ${suffix}`)), 0, 0);
}

export default function memoryExtension(omp: ExtensionAPI) {
  const operationalScope = configuredMemoryScope();
  const {
    namespaceParameters,
    namespaceListParameters,
    rememberParameters,
    ingestParameters,
    recallParameters,
    listParameters,
    memoryParameters,
    sessionParameters,
    summaryParameters,
    profileOnlyParameters,
  } = createParameters(omp.typebox.Type, Boolean(operationalScope));
  const pi = omp;

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
          sessionId: memorySessionId("omp", ctx.cwd, ctx.sessionManager.getSessionId()),
        };
  }
  pi.registerTool({
    name: "memory_namespace_list",
    ...memoryToolMeta.memory_namespace_list,
    approval: "read",
    parameters: namespaceListParameters,
    renderCall(_args, _options, theme) {
      return callText("memory_namespace_list", "account", theme);
    },
    execute(_id, params: NamespaceListParams): Promise<AgentToolResult<Record<string, unknown>>> {
      return memoryToolExecutors.listNamespaces(params);
    },
  });

  pi.registerTool({
    name: "memory_namespace_create",
    ...memoryToolMeta.memory_namespace_create,
    approval: "write",
    parameters: namespaceParameters,
    renderCall(args, _options, theme) {
      return callText("memory_namespace_create", args.namespace, theme);
    },
    execute(_id, params: NamespaceParams): Promise<AgentToolResult<Record<string, unknown>>> {
      return memoryToolExecutors.createNamespace(params);
    },
  });

  pi.registerTool({
    name: "memory_namespace_delete",
    ...memoryToolMeta.memory_namespace_delete,
    approval: "write",
    parameters: namespaceParameters,
    renderCall(args, _options, theme) {
      return callText("memory_namespace_delete", args.namespace, theme);
    },
    execute(_id, params: NamespaceParams): Promise<AgentToolResult<Record<string, unknown>>> {
      return memoryToolExecutors.deleteNamespace(params);
    },
  });

  pi.registerTool({
    name: "memory_remember",
    ...memoryToolMeta.memory_remember,
    approval: "write",
    parameters: rememberParameters,
    renderCall(args, _options, theme) {
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
    approval: "write",
    parameters: ingestParameters,
    renderCall(args, _options, theme) {
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
    approval: "read",
    parameters: recallParameters,
    renderCall(args, _options, theme) {
      return callText("memory_recall", memoryTarget(operationalParams(args)), theme);
    },
    execute(_id, params): Promise<AgentToolResult<Record<string, unknown>>> {
      return memoryToolExecutors.recall(operationalParams(params) as RecallParams);
    },
  });

  pi.registerTool({
    name: "memory_list",
    ...memoryToolMeta.memory_list,
    approval: "read",
    parameters: listParameters,
    renderCall(args, _options, theme) {
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
      approval: definition.operation === "get" ? "read" : "write",
      parameters: memoryParameters,
      renderCall(args, _options, theme) {
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
    approval: "read",
    parameters: summaryParameters,
    renderCall(args, _options, theme) {
      return callText("memory_summary", memoryTarget(operationalParams(args)), theme);
    },
    execute(_id, params): Promise<AgentToolResult<Record<string, unknown>>> {
      return memoryToolExecutors.summary(operationalParams(params) as SummaryParams);
    },
  });

  pi.registerTool({
    name: "memory_delete_session",
    ...memoryToolMeta.memory_delete_session,
    approval: "write",
    parameters: sessionParameters,
    renderCall(args, _options, theme) {
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
    approval: "write",
    parameters: profileOnlyParameters,
    renderCall(args, _options, theme) {
      return callText("memory_delete_profile", memoryTarget(args), theme);
    },
    execute(_id, params: ProfileParams): Promise<AgentToolResult<Record<string, unknown>>> {
      return memoryToolExecutors.deleteProfile(params);
    },
  });
}
