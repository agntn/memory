import { tracing } from "cloudflare:workers";
import { type ProgressToken, Server, type ServerContext } from "@modelcontextprotocol/server";
import {
  callMemoryMcpTool,
  createMemoryMcpTools,
  listMemoryMcpTools,
  MCP_PROGRESS_INTERVAL_MS,
  memoryMcpProgress,
} from "../../packages/shared/memory-mcp-tools.ts";
import { createMemoryToolExecutors } from "../../packages/shared/memory-tools.ts";
import type { MemoryBackend, ProfileParams } from "../../packages/shared/memory-tools.types.ts";
import { version } from "../../src/version.ts";

export interface MemoryServerOptions {
  backend: MemoryBackend;
  /** The binding's namespace and the profile every call is filed under. */
  scope: ProfileParams;
  /**
   * Record tool arguments and results on the trace. They are the memory
   * content itself, so they stay off unless asked for.
   */
  tracePayloads: boolean;
}

/**
 * Stream a progress notification every interval until the returned stop runs.
 *
 * @param ctx - The request context that carries the notification channel.
 * @param progressToken - The client's token; without one nothing is sent.
 * @param progress - The message and total for this tool, when it reports progress.
 * @returns {() => void} Stops the notifications.
 */
function startProgress(
  ctx: ServerContext,
  progressToken: ProgressToken | undefined,
  progress: Readonly<{ message: string; total: number }> | undefined,
): () => void {
  if (progressToken === undefined || progress === undefined) return () => {};
  const startedAt = performance.now();
  const timer = setInterval(() => {
    const completed = Math.min(Math.round(performance.now() - startedAt), progress.total);
    void ctx.mcpReq
      .notify({
        method: "notifications/progress",
        params: {
          progressToken,
          progress: completed,
          total: progress.total,
          message: progress.message,
        },
      })
      .catch(() => {});
  }, MCP_PROGRESS_INTERVAL_MS);
  return () => clearInterval(timer);
}

/**
 * Build one MCP server for one request, as the stateless handler expects.
 *
 * The tool surface is the bound one: namespace and profile come from the
 * Worker, and the account-level tools a binding cannot serve are left out.
 * The low-level `Server` is deliberate, as in the stdio server: the tools are
 * TypeBox schemas validated by the shared call path, and `McpServer` would
 * validate them a second time with its own copy of every shape.
 *
 * @param options - Backend, bound scope and trace settings.
 * @returns {Server} An unconnected server.
 */
export function createMemoryServer(options: MemoryServerOptions): Server {
  const tools = createMemoryMcpTools({
    executors: createMemoryToolExecutors(options.backend),
    scope: options.scope,
    // A remote client sends no harness session, so the service derives one.
    writeSessionId: () => undefined,
    administration: false,
  });
  const toolsByName = new Map(tools.map((tool) => [tool.name as string, tool]));
  const server = new Server({ name: "memory", version }, { capabilities: { tools: {} } });

  server.setRequestHandler("tools/list", () => ({ tools: listMemoryMcpTools(tools) }));

  server.setRequestHandler("tools/call", async (request, ctx) => {
    const { name } = request.params;
    const args = request.params.arguments ?? {};
    const tool = toolsByName.get(name);
    const toolName = tool?.name ?? "unknown";

    return tracing.startActiveSpan(`execute_tool ${toolName}`, async (span) => {
      span.setAttribute("gen_ai.operation.name", "execute_tool");
      span.setAttribute("gen_ai.tool.type", "function");
      span.setAttribute("gen_ai.tool.name", toolName);
      span.setAttribute("mcp.method.name", "tools/call");
      if (options.tracePayloads) {
        span.setAttribute("gen_ai.tool.call.arguments", JSON.stringify(args));
      }
      const progress = tool && memoryMcpProgress(tool.name, args.timeoutSeconds);
      const stopProgress = startProgress(ctx, request.params._meta?.progressToken, progress);
      try {
        const result = await callMemoryMcpTool(tool, name, args, { signal: ctx.mcpReq.signal });
        if (result.isError) span.setAttribute("error.type", "tool_error");
        if (options.tracePayloads) {
          span.setAttribute("gen_ai.tool.call.result", JSON.stringify(result.content));
        }
        return result;
      } finally {
        stopProgress();
        span.end();
      }
    });
  });

  return server;
}
