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
  MAX_TOOL_EXPAND,
  MAX_TOOL_SESSION_ID_CHARACTERS,
  MEMORY_ID_PATTERN,
  MEMORY_NAME_PATTERN,
  memoryFieldDescriptions,
  memoryToolExecutors,
  memoryToolMeta,
  memoryToolProgress,
} from "../../shared/memory-tools.ts";
import type { RenderedToolResult, RenderOptions, StatusTheme } from "../../shared/tui.ts";
import { describeToolCall, renderStatusLine, renderToolResult } from "../../shared/tui.ts";
import {
  applyMemoryScope,
  applyMemoryWriteScope,
  configuredMemoryScope,
  memorySessionId,
} from "../../shared/memory-scope.ts";
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

/**
 * Rebuild the shared parameter shapes with OMP's TypeBox.
 *
 * OMP validates tool parameters with its host build, so these schemas cannot be
 * imported from `shared/memory-tool-schemas.ts`, which Pi and MCP share.
 */
function createParameters(Type: ExtensionAPI["typebox"]["Type"], scoped: boolean) {
  const namespaceName = Type.String({
    description: memoryFieldDescriptions.namespace,
    minLength: 1,
    maxLength: MAX_TOOL_NAMESPACE_CHARACTERS,
    pattern: MEMORY_NAME_PATTERN,
  });
  const profileParameters = {
    namespace: namespaceName,
    profile: Type.String({
      description: memoryFieldDescriptions.profile,
      minLength: 1,
      maxLength: MAX_TOOL_PROFILE_CHARACTERS,
      pattern: MEMORY_NAME_PATTERN,
    }),
  };
  const memoryId = Type.String({
    description: memoryFieldDescriptions.memoryId,
    minLength: 1,
    pattern: MEMORY_ID_PATTERN,
  });
  const parameters = {
    namespaceParameters: Type.Object({ namespace: namespaceName }),
    namespaceListParameters: Type.Object({
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_TOOL_LIST_LIMIT,
          description: memoryFieldDescriptions.namespacesPerPage,
        }),
      ),
      cursor: Type.Optional(Type.String({ description: memoryFieldDescriptions.cursor })),
      order: Type.Optional(
        Type.Union([Type.Literal("id"), Type.Literal("name")], {
          description: memoryFieldDescriptions.sortField,
        }),
      ),
      direction: Type.Optional(
        Type.Union([Type.Literal("asc"), Type.Literal("desc")], {
          description: memoryFieldDescriptions.sortDirection,
        }),
      ),
    }),
    rememberParameters: Type.Object({
      ...profileParameters,
      content: Type.String({
        description: memoryFieldDescriptions.rememberContent,
        minLength: 1,
      }),
      sessionId: Type.Optional(
        Type.String({
          description: memoryFieldDescriptions.writeSessionId,
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
            { description: memoryFieldDescriptions.messageRole },
          ),
          content: Type.String({
            description: memoryFieldDescriptions.messageContent,
            minLength: 1,
            maxLength: MAX_TOOL_MESSAGE_CHARACTERS,
          }),
          timestamp: Type.Optional(
            Type.String({
              description: memoryFieldDescriptions.messageTimestamp,
              pattern: ISO_INSTANT_PATTERN,
            }),
          ),
        }),
        {
          minItems: 1,
          maxItems: MAX_TOOL_INGEST_MESSAGES,
          description: memoryFieldDescriptions.messages,
        },
      ),
      sessionId: Type.Optional(
        Type.String({
          description: memoryFieldDescriptions.writeSessionId,
          maxLength: MAX_TOOL_SESSION_ID_CHARACTERS,
        }),
      ),
    }),
    recallParameters: Type.Object({
      ...profileParameters,
      query: Type.String({
        description: memoryFieldDescriptions.recallQuery,
        minLength: 1,
        maxLength: MAX_TOOL_QUERY_CHARACTERS,
      }),
      thinkingLevel: Type.Optional(
        Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], {
          description: memoryFieldDescriptions.thinkingLevel,
        }),
      ),
      responseLength: Type.Optional(
        Type.Union([Type.Literal("short"), Type.Literal("medium"), Type.Literal("long")], {
          description: memoryFieldDescriptions.responseLength,
        }),
      ),
      referenceDate: Type.Optional(
        Type.String({ description: memoryFieldDescriptions.referenceDate }),
      ),
      candidates: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_TOOL_EXPAND,
          description: memoryFieldDescriptions.candidates,
        }),
      ),
      expand: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_TOOL_EXPAND,
          description: memoryFieldDescriptions.expand,
        }),
      ),
    }),
    listParameters: Type.Object({
      ...profileParameters,
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_TOOL_LIST_LIMIT,
          description: memoryFieldDescriptions.memoriesPerPage,
        }),
      ),
      cursor: Type.Optional(Type.String({ description: memoryFieldDescriptions.cursor })),
      sessionId: Type.Optional(
        Type.String({
          description: memoryFieldDescriptions.listSessionId,
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
          { description: memoryFieldDescriptions.memoryType },
        ),
      ),
      expand: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_TOOL_EXPAND,
          description: memoryFieldDescriptions.listExpand,
        }),
      ),
    }),
    getParameters: Type.Object({
      ...profileParameters,
      memoryIds: Type.Array(memoryId, {
        minItems: 1,
        maxItems: MAX_TOOL_EXPAND,
        description: memoryFieldDescriptions.memoryIds,
      }),
    }),
    memoryParameters: Type.Object({
      ...profileParameters,
      memoryId,
    }),
    sessionParameters: Type.Object({
      ...profileParameters,
      sessionId: Type.String({
        description: memoryFieldDescriptions.sessionToDelete,
        minLength: 1,
        maxLength: MAX_TOOL_SESSION_ID_CHARACTERS,
        pattern: MEMORY_ID_PATTERN,
      }),
    }),
    summaryParameters: Type.Object({
      ...profileParameters,
      sessionId: Type.Optional(
        Type.String({
          description: memoryFieldDescriptions.summarySessionId,
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
    getParameters: Type.Omit(parameters.getParameters, ["namespace", "profile"]),
    memoryParameters: Type.Omit(parameters.memoryParameters, ["namespace", "profile"]),
    summaryParameters: Type.Omit(parameters.summaryParameters, ["namespace", "profile"]),
    sessionParameters: Type.Omit(parameters.sessionParameters, ["namespace", "profile"]),
  };
}

/** One streamed update: the progress line, with the real result still to come. */
function progress(text: string): AgentToolResult<Record<string, unknown>> {
  return { content: [{ type: "text", text }], details: {} };
}

/** OMP keeps the failure flag in the result object it hands the renderer. */
function resultLine(result: RenderedToolResult, options: RenderOptions, theme: StatusTheme) {
  return new Text(renderToolResult(result, result.isError ?? false, options, theme), 0, 0);
}

export default function memoryExtension(omp: ExtensionAPI) {
  omp.setLabel("Memory");
  const operationalScope = configuredMemoryScope();
  const {
    namespaceParameters,
    namespaceListParameters,
    rememberParameters,
    ingestParameters,
    recallParameters,
    listParameters,
    getParameters,
    memoryParameters,
    sessionParameters,
    summaryParameters,
    profileOnlyParameters,
  } = createParameters(omp.typebox.Type, Boolean(operationalScope));
  const pi = omp;

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
      memorySessionId("omp", ctx.cwd, ctx.sessionManager.getSessionId()),
    );
  }

  /**
   * Build the call renderer for one tool.
   *
   * OMP orders the renderer arguments `(args, options, theme)`, unlike Pi. A
   * scoped tool hides the namespace and profile from the model, so the line
   * reads them back out of the configured scope.
   */
  function callRenderer(label: string, scoped = true) {
    return (args: object, options: RenderOptions, theme: StatusTheme) => {
      const line = describeToolCall(label, scoped ? operationalParams(args) : args, options);
      return new Text(renderStatusLine(line, theme), 0, 0);
    };
  }
  pi.registerTool({
    name: "memory_namespace_list",
    ...memoryToolMeta.memory_namespace_list,
    approval: "read",
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
    name: "memory_namespace_get",
    ...memoryToolMeta.memory_namespace_get,
    approval: "read",
    parameters: namespaceParameters,
    renderCall: callRenderer(memoryToolMeta.memory_namespace_get.label, false),
    renderResult: resultLine,
    execute(
      _id,
      params: NamespaceParams,
      signal,
    ): Promise<AgentToolResult<Record<string, unknown>>> {
      return memoryToolExecutors.getNamespace(params, { signal });
    },
  });

  pi.registerTool({
    name: "memory_namespace_create",
    ...memoryToolMeta.memory_namespace_create,
    approval: "write",
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
    approval: "write",
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
    approval: "write",
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
    approval: "write",
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
    approval: "read",
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
    approval: "read",
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
    approval: "read",
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
    approval: "write",
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
    approval: "read",
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
    approval: "write",
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
    approval: "write",
    parameters: profileOnlyParameters,
    renderCall: callRenderer(memoryToolMeta.memory_delete_profile.label, false),
    renderResult: resultLine,
    execute(_id, params: ProfileParams, signal): Promise<AgentToolResult<Record<string, unknown>>> {
      return memoryToolExecutors.deleteProfile(params, { signal });
    },
  });
}
