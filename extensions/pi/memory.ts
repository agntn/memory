import { registerPiTools, type PiRenderers } from "@agntn/tools/pi";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  createMemoryTools,
  hostSessionId,
  type MemoryToolName,
  scopedCallArguments,
} from "../shared/memory-tool-definitions.ts";
import { hostMemoryFields } from "../shared/memory-fields.ts";
import { hostRepository, projectMemoryScope } from "../shared/memory-project-scope.ts";
import {
  createIngestRouter,
  type IngestRouterOptions,
  type RouteHost,
  unmappedChannelNotice,
} from "../shared/memory-ingest-routes.ts";
import { createTurnIngest, type TurnContext } from "../shared/memory-ingest-turns.ts";
import { configuredRedactionShapes, loadRedactor, type Redactor } from "../shared/redaction.ts";
import { createMissingNamespaces } from "../shared/memory-missing-namespaces.ts";
import { openBotDatabasePath } from "../shared/memory-openbot.ts";
import {
  configuredPiAgentNamespaceTemplate,
  configuredPiIngestTurns,
  configuredPiMemoryScope,
  configuredPiOpenBotChannels,
  piScopePath,
} from "../shared/memory-scope.ts";
import type { ProfileParams } from "../shared/memory-tools.types.ts";
import type { RenderedToolResult, RenderOptions, StatusTheme } from "../shared/tui.ts";
import {
  describeToolCall,
  MEMORY_TOOL_SYMBOLS,
  renderStatusLine,
  renderToolResult,
} from "../shared/tui.ts";
import { memoryToolMeta } from "../shared/memory-tool-contract.ts";

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

/**
 * Pi calls the call renderer with `(args, theme, context)`. Unscoped calls show the default.
 *
 * @param name - Tool the renderers draw.
 * @param scope - Namespace and profile the host defaults to, if any.
 * @returns {PiRenderers} Call and result renderers for the tool.
 */
function renderers(name: MemoryToolName, scope: ProfileParams | undefined): PiRenderers {
  return {
    renderCall: (args: unknown, theme: StatusTheme, context?: RenderOptions) =>
      new Text(
        renderStatusLine(
          describeToolCall(
            memoryToolMeta[name].label,
            scopedCallArguments(name, args as object, scope),
            context,
            MEMORY_TOOL_SYMBOLS[name],
          ),
          theme,
        ),
        0,
        0,
      ),
    renderResult: resultLine,
  };
}

/**
 * Moves a lone string `id` into the `memoryIds` list `memory_get` takes.
 *
 * @param args - Raw model arguments.
 * @returns {unknown} The repaired call, or `args` untouched.
 */
function singleIdAsList(args: unknown): unknown {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return args;
  const { id, ...rest } = args as Record<string, unknown>;
  if (typeof id !== "string" || Object.hasOwn(rest, "memoryIds")) return args;
  return { ...rest, memoryIds: [id] };
}

/**
 * Session and warning channel of the conversation behind a Pi event.
 *
 * @param ctx - Pi's context for the event.
 * @returns {TurnContext} What the turn ingest needs from it.
 */
function turnContext(ctx: ExtensionContext): TurnContext {
  return {
    sessionId: hostSessionId("pi", ctx),
    warn: (message) => {
      ctx.ui.notify(message, "warning");
    },
  };
}

/**
 * What the router reads from a Pi event's context.
 *
 * @param ctx - Pi's context for the event.
 * @returns {RouteHost} The working directory, session file, prompt and warning channel.
 */
function routeHost(ctx: ExtensionContext): RouteHost {
  return {
    cwd: ctx.cwd,
    sessionFile: () => ctx.sessionManager.getSessionFile(),
    systemPrompt: () => ctx.getSystemPrompt(),
    warn: turnContext(ctx).warn,
  };
}

/**
 * Feed the conversation to `memory_ingest` every `every` turns and once more on shutdown.
 *
 * @param pi - Pi's extension API.
 * @param options - Where the conversation goes, read from Pi's configuration.
 * @param every - Turns between ingests.
 */
function ingestEveryTurns(pi: ExtensionAPI, options: IngestRouterOptions, every: number): void {
  const namespaces = createMissingNamespaces();
  const ingest = createTurnIngest(every, { onMissing: namespaces.report });
  const shapes = configuredRedactionShapes();
  let redactor: Redactor | undefined;
  const router = createIngestRouter({ ...options, redact: (text) => redactor!(text).text });
  let started = false;
  /**
   * What only the first run has to say, after a short wait for the project's namespace lookup.
   *
   * @param host - The host at the run's start.
   * @returns {Promise<string[]>} The unmapped channel's note on the first run, else nothing.
   */
  async function firstRunNotices(host: RouteHost): Promise<string[]> {
    if (started) return [];
    started = true;
    const project = router.project(host);
    if (project !== undefined) await namespaces.watch(project);
    const channel = router.unmappedChannel(host);
    return channel === undefined ? [] : [unmappedChannelNotice(channel, piScopePath())];
  }
  /** Asks early, so the first run rarely has to wait. */
  pi.on("session_start", (_event, ctx) => {
    const project = projectMemoryScope(ctx.cwd);
    if (project !== undefined) namespaces.check(project.namespace);
  });
  pi.on("before_agent_start", async (_event, ctx) => {
    const notices = [...(await firstRunNotices(routeHost(ctx))), ...namespaces.notices()];
    if (notices.length === 0) return undefined;
    const content = notices.join("\n\n");
    return { message: { customType: "agntn-memory", content, display: true } };
  });
  pi.on("tool_result", (event) => {
    const { namespace } = event.input;
    if (event.toolName !== "memory_namespace_create" || event.isError) return;
    if (typeof namespace !== "string") return;
    namespaces.forget(namespace);
    ingest.created(namespace);
  });
  pi.on("message_end", async (event, ctx) => {
    redactor ??= await loadRedactor(shapes);
    ingest.add(router.route(event.message, routeHost(ctx)));
  });
  pi.on("turn_end", (_event, ctx) => {
    ingest.turn(turnContext(ctx));
  });
  pi.on("session_shutdown", (_event, ctx) => ingest.flush(turnContext(ctx)));
}

export default function memoryExtension(pi: ExtensionAPI) {
  const scope = configuredPiMemoryScope();
  const openBotDatabase = openBotDatabasePath();
  const fields = hostMemoryFields(
    openBotDatabase === undefined ? "pi" : { harness: "pi", app: "openbot" },
  );
  const ingestTurns = configuredPiIngestTurns();
  if (ingestTurns !== undefined) {
    const agentNamespace = configuredPiAgentNamespaceTemplate();
    ingestEveryTurns(
      pi,
      {
        ...(scope === undefined ? {} : { fallback: scope }),
        ...(openBotDatabase === undefined ? {} : { openBotDatabase }),
        openBotChannels: configuredPiOpenBotChannels(),
        agentNamespace,
      },
      ingestTurns,
    );
  }
  const tools = createMemoryTools({
    scope,
    fields,
    repository: hostRepository,
    writeSession: (host) => hostSessionId("pi", host),
  });
  registerPiTools(pi, tools, {
    prepareArguments: { memory_get: singleIdAsList },
    renderers: Object.fromEntries(
      tools.map((tool) => [tool.name, renderers(tool.name as MemoryToolName, scope)]),
    ),
  });
}
