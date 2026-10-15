import type { TSchema } from "typebox";
import { toolErrorMessage } from "../shared/tool-errors.ts";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  createOperationalMemoryToolSchemas,
  namespaceListParameters,
  namespaceParameters,
  profileListParameters,
  profileOnlyParameters,
} from "../shared/memory-tool-schemas.ts";
import {
  applyMemoryScope,
  applyMemoryWriteScope,
  configuredPiMemoryScope,
  memorySessionId,
} from "../shared/memory-scope.ts";
import { memoryToolExecutors, memoryToolMeta, memoryToolProgress } from "../shared/memory-tools.ts";
import type { RenderedToolResult, RenderOptions, StatusTheme } from "../shared/tui.ts";
import {
  describeToolCall,
  MEMORY_TOOL_SYMBOLS,
  renderStatusLine,
  renderToolResult,
} from "../shared/tui.ts";
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
} from "../shared/memory-tools.types.ts";

/* One streamed update: the progress line, with the real result still to come. */
function progress(text: string): AgentToolResult<Record<string, unknown>> {
  return { content: [{ type: "text", text }], details: {} };
}

/*
 * Render a finished call.
 *
 * Pi orders the renderer arguments `(result, options, theme, context)` and
 * reports a failure in the context. Its result object never carries the flag.
 */
function resultLine(
  result: RenderedToolResult,
  options: RenderOptions,
  theme: StatusTheme,
  context?: Readonly<{ isError?: boolean }>,
) {
  return new Text(renderToolResult(result, context?.isError ?? false, options, theme), 0, 0);
}

export default function memoryExtension(pi: ExtensionAPI) {
  /**
   * Pi marks thrown failures as errors but only displays their message.
   * @param tool - Definition whose execution errors need their cause chain formatted.
   */
  function registerTool<TParams extends TSchema>(
    tool: ToolDefinition<TParams, Record<string, unknown>>,
  ) {
    pi.registerTool({
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

  const operationalScope = configuredPiMemoryScope();
  const {
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

  /*
   * Build the call renderer for one tool.
   *
   * Pi orders the renderer arguments `(args, theme, context)`. A scoped tool
   * hides the namespace and profile from the model, so the line reads them back
   * out of the configured scope.
   */
  function callRenderer(name: keyof typeof memoryToolMeta, scoped = true) {
    return (args: object, theme: StatusTheme, context?: RenderOptions) => {
      const line = describeToolCall(
        memoryToolMeta[name].label,
        scoped ? operationalParams(args) : args,
        context,
        MEMORY_TOOL_SYMBOLS[name],
      );
      return new Text(renderStatusLine(line, theme), 0, 0);
    };
  }
  registerTool({
    name: "memory_namespace_list",
    ...memoryToolMeta.memory_namespace_list,
    promptSnippet: "List available Agent Memory namespaces.",
    promptGuidelines: ["Use cursor to page through results."],
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
    promptSnippet: "Get one exact Agent Memory namespace.",
    promptGuidelines: ["Use the exact name; memory_namespace_list shows the existing ones."],
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
    promptSnippet: "Create an Agent Memory namespace.",
    promptGuidelines: ["Namespace names are lowercase letters, numbers, and internal hyphens."],
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
    promptSnippet: "Delete one exact Agent Memory namespace.",
    promptGuidelines: [
      "This is destructive and removes every profile and memory in the namespace.",
    ],
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
    promptSnippet: "List the profiles one Agent Memory namespace holds.",
    promptGuidelines: ["Use cursor to page through results."],
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
    promptSnippet: "Store a durable fact or instruction in agent memory.",
    promptGuidelines: ["Use only for information worth retaining across sessions."],
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
    promptSnippet: "Replace a durable memory without deleting the old record first.",
    promptGuidelines: [
      "Use the old id and the exact recall query that must find the replacement before deletion.",
    ],
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
    name: "memory_supersession_resume",
    ...memoryToolMeta.memory_supersession_resume,
    promptSnippet: "Finish a supersession from the replacement memory already stored.",
    promptGuidelines: [
      "Use both ids from the failed memory_supersede call and the same expected content and query.",
    ],
    parameters: resumeSupersessionParameters,
    renderCall: callRenderer("memory_supersession_resume"),
    renderResult: resultLine,
    execute(_id, params, signal, onUpdate): Promise<AgentToolResult<Record<string, unknown>>> {
      onUpdate?.(progress(memoryToolProgress.memory_supersession_resume));
      return memoryToolExecutors.resumeSupersession(
        operationalParams(params) as ResumeSupersessionParams,
        { signal },
      );
    },
  });

  registerTool({
    name: "memory_recall_wait",
    ...memoryToolMeta.memory_recall_wait,
    promptSnippet: "Wait until one stored memory can be found through recall.",
    promptGuidelines: [
      "Pass the exact id returned by memory_remember and the query you will reuse.",
    ],
    parameters: recallVisibilityParameters,
    renderCall: callRenderer("memory_recall_wait"),
    renderResult: resultLine,
    execute(_id, params, signal, onUpdate): Promise<AgentToolResult<Record<string, unknown>>> {
      onUpdate?.(progress(memoryToolProgress.memory_recall_wait));
      return memoryToolExecutors.waitForRecall(
        operationalParams(params) as RecallVisibilityParams,
        { signal },
      );
    },
  });

  registerTool({
    name: "memory_ingest",
    ...memoryToolMeta.memory_ingest,
    promptSnippet: "Ingest conversation messages into agent memory.",
    promptGuidelines: [
      "Use for conversation history; use memory_remember for one explicit memory.",
      "Ingesting the same messages again runs extraction again and supersedes what it extracted before, so read the ids from memory_list afresh afterwards.",
    ],
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
    promptSnippet: "Recall durable context before answering or acting.",
    promptGuidelines: [
      "Use a focused natural-language query.",
      "A candidate marked kind: message is a raw ingested message with its text under the line; no memory record answers its id.",
    ],
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
    promptSnippet: "List memories by session or type, oldest first.",
    promptGuidelines: [
      "Pages run from the oldest memory up and cannot be reversed. Use cursor to page forward, sessionId to see one session, memory_recall for recent facts.",
    ],
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
    promptSnippet: memoryToolMeta.memory_get.description,
    promptGuidelines: ["Use exact memory ids returned by another memory tool."],
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
    promptSnippet: memoryToolMeta.memory_delete.description,
    promptGuidelines: ["Use an exact memory id returned by another memory tool."],
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
    promptSnippet:
      "Summarize everything a profile holds when there is no specific question to ask.",
    promptGuidelines: [
      "The summary always covers the whole profile; sessionId only picks the session named on its Current session line. Use memory_list with sessionId to see one session.",
    ],
    parameters: summaryParameters,
    renderCall: callRenderer("memory_summary"),
    renderResult: resultLine,
    execute(_id, params, signal): Promise<AgentToolResult<Record<string, unknown>>> {
      return memoryToolExecutors.summary(operationalParams(params) as SummaryParams, { signal });
    },
  });

  registerTool({
    name: "memory_session_delete",
    ...memoryToolMeta.memory_session_delete,
    promptSnippet: "Delete one exact memory session.",
    promptGuidelines: ["This is destructive; use only with an exact session id."],
    parameters: sessionParameters,
    renderCall: callRenderer("memory_session_delete"),
    renderResult: resultLine,
    execute(_id, params, signal): Promise<AgentToolResult<Record<string, unknown>>> {
      return memoryToolExecutors.deleteSession(operationalParams(params) as SessionParams, {
        signal,
      });
    },
  });

  registerTool({
    name: "memory_profile_delete",
    ...memoryToolMeta.memory_profile_delete,
    promptSnippet: "Delete one exact memory profile.",
    promptGuidelines: ["This is destructive and removes the complete profile."],
    parameters: profileOnlyParameters,
    renderCall: callRenderer("memory_profile_delete", false),
    renderResult: resultLine,
    execute(_id, params: ProfileParams, signal): Promise<AgentToolResult<Record<string, unknown>>> {
      return memoryToolExecutors.deleteProfile(params, { signal });
    },
  });
}
