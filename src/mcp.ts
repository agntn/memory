import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { memoryToolExecutors } from "../packages/shared/memory-api-backend.ts";
import {
  callMemoryMcpTool,
  createMemoryMcpTools,
  listMemoryMcpTools,
  MCP_PROGRESS_INTERVAL_MS,
  memoryMcpProgress,
} from "../packages/shared/memory-mcp-tools.ts";
import {
  claudeCodeMemorySessionId,
  configuredMemoryScope,
  grokMemorySessionId,
} from "../packages/shared/memory-scope.ts";
import { version } from "./version.ts";

/**
 * Create a stdio-compatible MCP server exposing the shared memory tool surface.
 *
 * The server publishes the TypeBox schemas that back the Pi extension and
 * validates every request before forwarding it to the shared executors. The
 * low-level `Server` is deliberate: `McpServer` accepts Zod schemas only, which
 * would require a second definition of every tool parameter shape.
 *
 * @returns {Server} An unconnected MCP server; the caller owns its transport and lifecycle.
 */
export function createMcpServer(): Server {
  const scope = configuredMemoryScope();
  const tools = createMemoryMcpTools({
    executors: memoryToolExecutors,
    scope,
    writeSessionId: () => claudeCodeMemorySessionId() ?? grokMemorySessionId(),
    administration: true,
  });
  const toolsByName = new Map(tools.map((tool) => [tool.name as string, tool]));
  const server = new Server({ name: "memory", version }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: listMemoryMcpTools(tools) as Tool[],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const tool = toolsByName.get(request.params.name);
    const args = request.params.arguments ?? {};

    let progressTimer: ReturnType<typeof setInterval> | undefined;
    const progressToken = extra._meta?.progressToken;
    const progress = tool && memoryMcpProgress(tool.name, args.timeoutSeconds);
    if (progressToken !== undefined && progress !== undefined) {
      const startedAt = performance.now();
      progressTimer = setInterval(() => {
        const completed = Math.min(Math.round(performance.now() - startedAt), progress.total);
        void extra
          .sendNotification({
            method: "notifications/progress",
            params: {
              progressToken,
              progress: completed,
              total: progress.total,
              message: progress.message,
            },
          })
          .catch((error: unknown) => {
            server.onerror?.(error instanceof Error ? error : new Error(String(error)));
          });
      }, MCP_PROGRESS_INTERVAL_MS);
    }

    try {
      return (await callMemoryMcpTool(tool, request.params.name, args, {
        signal: extra.signal,
      })) as CallToolResult;
    } finally {
      if (progressTimer !== undefined) clearInterval(progressTimer);
    }
  });

  return server;
}
