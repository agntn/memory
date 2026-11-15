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
import { hostRepository } from "../shared/memory-project-scope.ts";
import {
  createIngestRouter,
  type IngestRouterOptions,
  type RouteHost,
  unmappedChannelNotice,
} from "../shared/memory-ingest-routes.ts";
import { createTurnIngest, type TurnContext } from "../shared/memory-ingest-turns.ts";
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
  const ingest = createTurnIngest(every);
  const router = createIngestRouter(options);
  let noticed = false;
  pi.on("before_agent_start", (_event, ctx) => {
    if (noticed) return undefined;
    noticed = true;
    const channel = router.unmappedChannel(routeHost(ctx));
    if (channel === undefined) return undefined;
    const content = unmappedChannelNotice(channel, piScopePath());
    return { message: { customType: "agntn-memory", content, display: true } };
  });
  pi.on("message_end", (event, ctx) => {
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
    renderers: Object.fromEntries(
      tools.map((tool) => [tool.name, renderers(tool.name as MemoryToolName, scope)]),
    ),
  });
}
