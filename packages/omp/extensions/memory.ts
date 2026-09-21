import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@oh-my-pi/pi-coding-agent";
import { Text } from "@oh-my-pi/pi-tui";
import { toolErrorMessage } from "../../shared/tool-errors.ts";
import {
  ISO_INSTANT_PATTERN,
  MAX_TOOL_INGEST_MESSAGES,
  MAX_TOOL_LIST_LIMIT,
  MAX_TOOL_MEMORY_CONTENT_CHARACTERS,
  MAX_TOOL_MESSAGE_CHARACTERS,
  MAX_TOOL_NAMESPACE_CHARACTERS,
  MAX_TOOL_PROFILE_CHARACTERS,
  MAX_TOOL_QUERY_CHARACTERS,
  MAX_TOOL_RECALL_VISIBILITY_TIMEOUT_SECONDS,
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
import {
  describeToolCall,
  MEMORY_TOOL_SYMBOLS,
  renderStatusLine,
  renderToolResult,
} from "../../shared/tui.ts";
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
  ProfileListParams,
  ProfileParams,
  RecallParams,
  RecallVisibilityParams,
  RememberParams,
  ResumeSupersessionParams,
  SessionParams,
  SummaryParams,
  SupersedeParams,
} from "../../shared/memory-tools.types.ts";

/*
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
    profileListParameters: Type.Object({
      namespace: namespaceName,
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_TOOL_LIST_LIMIT,
          description: memoryFieldDescriptions.profilesPerPage,
        }),
      ),
      cursor: Type.Optional(Type.String({ description: memoryFieldDescriptions.cursor })),
    }),
    rememberParameters: Type.Object({
      ...profileParameters,
      content: Type.String({
        description: memoryFieldDescriptions.rememberContent,
        minLength: 1,
        maxLength: MAX_TOOL_MEMORY_CONTENT_CHARACTERS,
      }),
      sessionId: Type.Optional(
        Type.String({
          description: memoryFieldDescriptions.writeSessionId,
          maxLength: MAX_TOOL_SESSION_ID_CHARACTERS,
        }),
      ),
    }),
    supersedeParameters: Type.Object({
      ...profileParameters,
      oldMemoryId: Type.String({
        description: memoryFieldDescriptions.supersedeOldMemoryId,
        minLength: 1,
        pattern: MEMORY_ID_PATTERN,
      }),
      content: Type.String({
        description: memoryFieldDescriptions.rememberContent,
        minLength: 1,
        maxLength: MAX_TOOL_MEMORY_CONTENT_CHARACTERS,
      }),
      query: Type.String({
        description: memoryFieldDescriptions.recallVisibilityQuery,
        minLength: 1,
        maxLength: MAX_TOOL_QUERY_CHARACTERS,
      }),
      timeoutSeconds: Type.Integer({
        description: memoryFieldDescriptions.recallVisibilityTimeout,
        minimum: 1,
        maximum: MAX_TOOL_RECALL_VISIBILITY_TIMEOUT_SECONDS,
      }),
      sessionId: Type.Optional(
        Type.String({
          description: memoryFieldDescriptions.writeSessionId,
          maxLength: MAX_TOOL_SESSION_ID_CHARACTERS,
        }),
      ),
    }),
    resumeSupersessionParameters: Type.Object({
      ...profileParameters,
      oldMemoryId: Type.String({
        description: memoryFieldDescriptions.supersedeOldMemoryId,
        minLength: 1,
        pattern: MEMORY_ID_PATTERN,
      }),
      replacementMemoryId: Type.String({
        description: memoryFieldDescriptions.supersedeReplacementMemoryId,
        minLength: 1,
        pattern: MEMORY_ID_PATTERN,
      }),
      content: Type.String({
        description: memoryFieldDescriptions.replacementContent,
        minLength: 1,
      }),
      query: Type.String({
        description: memoryFieldDescriptions.recallVisibilityQuery,
        minLength: 1,
        maxLength: MAX_TOOL_QUERY_CHARACTERS,
      }),
      timeoutSeconds: Type.Integer({
        description: memoryFieldDescriptions.recallVisibilityTimeout,
        minimum: 1,
        maximum: MAX_TOOL_RECALL_VISIBILITY_TIMEOUT_SECONDS,
      }),
    }),
    recallVisibilityParameters: Type.Object({
      ...profileParameters,
      memoryId: Type.String({
        description: memoryFieldDescriptions.recallVisibilityMemoryId,
        minLength: 1,
        pattern: MEMORY_ID_PATTERN,
      }),
      query: Type.String({
        description: memoryFieldDescriptions.recallVisibilityQuery,
        minLength: 1,
        maxLength: MAX_TOOL_QUERY_CHARACTERS,
      }),
      timeoutSeconds: Type.Integer({
        description: memoryFieldDescriptions.recallVisibilityTimeout,
        minimum: 1,
        maximum: MAX_TOOL_RECALL_VISIBILITY_TIMEOUT_SECONDS,
      }),
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
    supersedeParameters: Type.Omit(parameters.supersedeParameters, [
      "namespace",
      "profile",
      "sessionId",
    ]),
    resumeSupersessionParameters: Type.Omit(parameters.resumeSupersessionParameters, [
      "namespace",
      "profile",
    ]),
    recallVisibilityParameters: Type.Omit(parameters.recallVisibilityParameters, [
      "namespace",
      "profile",
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

/* One streamed update: the progress line, with the real result still to come. */
function progress(text: string): AgentToolResult<Record<string, unknown>> {
  return { content: [{ type: "text", text }], details: {} };
}

/* OMP keeps the failure flag in the result object it hands the renderer. */
function resultLine(result: RenderedToolResult, options: RenderOptions, theme: StatusTheme) {
  return new Text(renderToolResult(result, result.isError ?? false, options, theme), 0, 0);
}

export default function memoryExtension(omp: ExtensionAPI) {
  omp.setLabel("Memory");
  const operationalScope = configuredMemoryScope();
  const {
    namespaceParameters,
    namespaceListParameters,
    profileListParameters,
    rememberParameters,
    supersedeParameters,
    resumeSupersessionParameters,
    recallVisibilityParameters,
    ingestParameters,
    recallParameters,
    listParameters,
    getParameters,
    memoryParameters,
    sessionParameters,
    summaryParameters,
    profileOnlyParameters,
  } = createParameters(omp.typebox.Type, Boolean(operationalScope));

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

  /*
   * Build the call renderer for one tool.
   *
   * OMP orders the renderer arguments `(args, options, theme)`, unlike Pi. A
   * scoped tool hides the namespace and profile from the model, so the line
   * reads them back out of the configured scope.
   */
  function callRenderer(name: keyof typeof memoryToolMeta, scoped = true) {
    return (args: object, options: RenderOptions, theme: StatusTheme) => {
      const line = describeToolCall(
        memoryToolMeta[name].label,
        scoped ? operationalParams(args) : args,
        options,
        MEMORY_TOOL_SYMBOLS[name],
      );
      return new Text(renderStatusLine(line, theme), 0, 0);
    };
  }

  /**
   * OMP keeps a thrown failure as its message alone, the same way Pi does.
   * @param tool - Definition whose execution errors need their cause chain formatted.
   */
  function registerTool<TParams extends ToolDefinition["parameters"]>(
    tool: ToolDefinition<TParams, Record<string, unknown>>,
  ): void {
    omp.registerTool({
      ...tool,
      async execute(...args) {
        try {
          return await tool.execute(...args);
        } catch (error) {
          throw new Error(toolErrorMessage(error), { cause: error });
        }
      },
    });
  }

  registerTool({
    name: "memory_namespace_list",
    ...memoryToolMeta.memory_namespace_list,
    approval: "read",
    parameters: namespaceListParameters,
    renderCall: callRenderer("memory_namespace_list", false),
    renderResult: resultLine,
    execute(
      _id,
      params: NamespaceListParams,
      signal,
    ): Promise<AgentToolResult<Record<string, unknown>>> {
      return memoryToolExecutors.listNamespaces(params, { signal });
    },
  });

  registerTool({
    name: "memory_namespace_get",
    ...memoryToolMeta.memory_namespace_get,
    approval: "read",
    parameters: namespaceParameters,
    renderCall: callRenderer("memory_namespace_get", false),
    renderResult: resultLine,
    execute(
      _id,
      params: NamespaceParams,
      signal,
    ): Promise<AgentToolResult<Record<string, unknown>>> {
      return memoryToolExecutors.getNamespace(params, { signal });
    },
  });

  registerTool({
    name: "memory_namespace_create",
    ...memoryToolMeta.memory_namespace_create,
    approval: "write",
    parameters: namespaceParameters,
    renderCall: callRenderer("memory_namespace_create", false),
    renderResult: resultLine,
    execute(
      _id,
      params: NamespaceParams,
      signal,
    ): Promise<AgentToolResult<Record<string, unknown>>> {
      return memoryToolExecutors.createNamespace(params, { signal });
    },
  });

  registerTool({
    name: "memory_namespace_delete",
    ...memoryToolMeta.memory_namespace_delete,
    approval: "write",
    parameters: namespaceParameters,
    renderCall: callRenderer("memory_namespace_delete", false),
    renderResult: resultLine,
    execute(
      _id,
      params: NamespaceParams,
      signal,
    ): Promise<AgentToolResult<Record<string, unknown>>> {
      return memoryToolExecutors.deleteNamespace(params, { signal });
    },
  });

  registerTool({
    name: "memory_profile_list",
    ...memoryToolMeta.memory_profile_list,
    approval: "read",
    parameters: profileListParameters,
    renderCall: callRenderer("memory_profile_list", false),
    renderResult: resultLine,
    execute(
      _id,
      params: ProfileListParams,
      signal,
    ): Promise<AgentToolResult<Record<string, unknown>>> {
      return memoryToolExecutors.listProfiles(params, { signal });
    },
  });

  registerTool({
    name: "memory_remember",
    ...memoryToolMeta.memory_remember,
    approval: "write",
    parameters: rememberParameters,
    renderCall: callRenderer("memory_remember"),
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

  registerTool({
    name: "memory_supersede",
    ...memoryToolMeta.memory_supersede,
    approval: "write",
    parameters: supersedeParameters,
    renderCall: callRenderer("memory_supersede"),
    renderResult: resultLine,
    execute(_id, params, signal, onUpdate, ctx): Promise<AgentToolResult<Record<string, unknown>>> {
      onUpdate?.(progress(memoryToolProgress.memory_supersede));
      return memoryToolExecutors.supersede(operationalWriteParams(params, ctx) as SupersedeParams, {
        signal,
      });
    },
  });

  registerTool({
    name: "memory_resume_supersession",
    ...memoryToolMeta.memory_resume_supersession,
    approval: "write",
    parameters: resumeSupersessionParameters,
    renderCall: callRenderer("memory_resume_supersession"),
    renderResult: resultLine,
    execute(_id, params, signal, onUpdate): Promise<AgentToolResult<Record<string, unknown>>> {
      onUpdate?.(progress(memoryToolProgress.memory_resume_supersession));
      return memoryToolExecutors.resumeSupersession(
        operationalParams(params) as ResumeSupersessionParams,
        { signal },
      );
    },
  });

  registerTool({
    name: "memory_wait_for_recall",
    ...memoryToolMeta.memory_wait_for_recall,
    approval: "read",
    parameters: recallVisibilityParameters,
    renderCall: callRenderer("memory_wait_for_recall"),
    renderResult: resultLine,
    execute(_id, params, signal, onUpdate): Promise<AgentToolResult<Record<string, unknown>>> {
      onUpdate?.(progress(memoryToolProgress.memory_wait_for_recall));
      return memoryToolExecutors.waitForRecall(
        operationalParams(params) as RecallVisibilityParams,
        { signal },
      );
    },
  });

  registerTool({
    name: "memory_ingest",
    ...memoryToolMeta.memory_ingest,
    approval: "write",
    parameters: ingestParameters,
    renderCall: callRenderer("memory_ingest"),
    renderResult: resultLine,
    execute(_id, params, signal, onUpdate, ctx): Promise<AgentToolResult<Record<string, unknown>>> {
      onUpdate?.(progress(memoryToolProgress.memory_ingest));
      return memoryToolExecutors.ingest(operationalWriteParams(params, ctx) as IngestParams, {
        signal,
      });
    },
  });

  registerTool({
    name: "memory_recall",
    ...memoryToolMeta.memory_recall,
    approval: "read",
    parameters: recallParameters,
    renderCall: callRenderer("memory_recall"),
    renderResult: resultLine,
    execute(_id, params, signal, onUpdate): Promise<AgentToolResult<Record<string, unknown>>> {
      onUpdate?.(progress(memoryToolProgress.memory_recall));
      return memoryToolExecutors.recall(operationalParams(params) as RecallParams, { signal });
    },
  });

  registerTool({
    name: "memory_list",
    ...memoryToolMeta.memory_list,
    approval: "read",
    parameters: listParameters,
    renderCall: callRenderer("memory_list"),
    renderResult: resultLine,
    execute(_id, params, signal): Promise<AgentToolResult<Record<string, unknown>>> {
      return memoryToolExecutors.list(operationalParams(params) as ListParams, { signal });
    },
  });

  registerTool({
    name: "memory_get",
    ...memoryToolMeta.memory_get,
    approval: "read",
    parameters: getParameters,
    renderCall: callRenderer("memory_get"),
    renderResult: resultLine,
    execute(_id, params, signal): Promise<AgentToolResult<Record<string, unknown>>> {
      return memoryToolExecutors.get(operationalParams(params) as GetParams, { signal });
    },
  });

  registerTool({
    name: "memory_delete",
    ...memoryToolMeta.memory_delete,
    approval: "write",
    parameters: memoryParameters,
    renderCall: callRenderer("memory_delete"),
    renderResult: resultLine,
    execute(_id, params, signal): Promise<AgentToolResult<Record<string, unknown>>> {
      return memoryToolExecutors.deleteMemory(operationalParams(params) as MemoryParams, {
        signal,
      });
    },
  });

  registerTool({
    name: "memory_summary",
    ...memoryToolMeta.memory_summary,
    approval: "read",
    parameters: summaryParameters,
    renderCall: callRenderer("memory_summary"),
    renderResult: resultLine,
    execute(_id, params, signal): Promise<AgentToolResult<Record<string, unknown>>> {
      return memoryToolExecutors.summary(operationalParams(params) as SummaryParams, { signal });
    },
  });

  registerTool({
    name: "memory_delete_session",
    ...memoryToolMeta.memory_delete_session,
    approval: "write",
    parameters: sessionParameters,
    renderCall: callRenderer("memory_delete_session"),
    renderResult: resultLine,
    execute(_id, params, signal): Promise<AgentToolResult<Record<string, unknown>>> {
      return memoryToolExecutors.deleteSession(operationalParams(params) as SessionParams, {
        signal,
      });
    },
  });

  registerTool({
    name: "memory_delete_profile",
    ...memoryToolMeta.memory_delete_profile,
    approval: "write",
    parameters: profileOnlyParameters,
    renderCall: callRenderer("memory_delete_profile", false),
    renderResult: resultLine,
    execute(_id, params: ProfileParams, signal): Promise<AgentToolResult<Record<string, unknown>>> {
      return memoryToolExecutors.deleteProfile(params, { signal });
    },
  });
}
