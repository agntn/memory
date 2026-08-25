import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { AbortOptions } from "./index.ts";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import {
  createOperationalMemoryToolSchemas,
  namespaceListParameters,
  namespaceParameters,
  profileOnlyParameters,
} from "../packages/shared/memory-tool-schemas.ts";
import {
  applyMemoryScope,
  applyMemoryWriteScope,
  claudeCodeMemorySessionId,
  configuredMemoryScope,
  grokMemorySessionId,
} from "../packages/shared/memory-scope.ts";
import { memoryToolExecutors, memoryToolMeta } from "../packages/shared/memory-tools.ts";
import type {
  GetParams,
  IngestParams,
  ListParams,
  MemoryParams,
  MemoryToolResult,
  NamespaceListParams,
  NamespaceParams,
  ProfileParams,
  RecallParams,
  RememberParams,
  SessionParams,
  SummaryParams,
} from "../packages/shared/memory-tools.types.ts";
import { version } from "./version.ts";

/** One row of the MCP server's tool table; Pi and OMP register their own shapes. */
interface MemoryToolDefinition {
  name: keyof typeof memoryToolMeta;
  inputSchema: TSchema;
  annotations: Tool["annotations"];
  /** Called only after `Value.Check` accepted the arguments against `inputSchema`. */
  execute(args: unknown, options: AbortOptions): Promise<MemoryToolResult>;
}

/** Every tool reaches Cloudflare Agent Memory, so no operation is closed-world. */
const readAnnotations: Tool["annotations"] = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
const writeAnnotations: Tool["annotations"] = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};
const destructiveAnnotations: Tool["annotations"] = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

function createTools(): MemoryToolDefinition[] {
  const operationalScope = configuredMemoryScope();
  const operationalSchemas = createOperationalMemoryToolSchemas(Boolean(operationalScope));

  function operationalParams<T extends object>(args: T): T & ProfileParams {
    return applyMemoryScope(args, operationalScope);
  }

  function operationalWriteParams<T extends object>(
    args: T,
  ): T & ProfileParams & { sessionId?: string } {
    return applyMemoryWriteScope(
      args,
      operationalScope,
      claudeCodeMemorySessionId() ?? grokMemorySessionId(),
    );
  }

  return [
    {
      name: "memory_namespace_list",
      inputSchema: namespaceListParameters,
      annotations: readAnnotations,
      execute: (args, options) =>
        memoryToolExecutors.listNamespaces(args as NamespaceListParams, options),
    },
    {
      name: "memory_namespace_get",
      inputSchema: namespaceParameters,
      annotations: readAnnotations,
      execute: (args, options) =>
        memoryToolExecutors.getNamespace(args as NamespaceParams, options),
    },
    {
      name: "memory_namespace_create",
      inputSchema: namespaceParameters,
      annotations: writeAnnotations,
      execute: (args, options) =>
        memoryToolExecutors.createNamespace(args as NamespaceParams, options),
    },
    {
      name: "memory_namespace_delete",
      inputSchema: namespaceParameters,
      annotations: destructiveAnnotations,
      execute: (args, options) =>
        memoryToolExecutors.deleteNamespace(args as NamespaceParams, options),
    },
    {
      name: "memory_remember",
      inputSchema: operationalSchemas.rememberParameters,
      annotations: writeAnnotations,
      execute: (args, options) =>
        memoryToolExecutors.remember(
          operationalWriteParams(args as { sessionId?: string }) as RememberParams,
          options,
        ),
    },
    {
      name: "memory_ingest",
      inputSchema: operationalSchemas.ingestParameters,
      annotations: writeAnnotations,
      execute: (args, options) =>
        memoryToolExecutors.ingest(
          operationalWriteParams(args as { sessionId?: string }) as IngestParams,
          options,
        ),
    },
    {
      name: "memory_recall",
      inputSchema: operationalSchemas.recallParameters,
      annotations: readAnnotations,
      execute: (args, options) =>
        memoryToolExecutors.recall(operationalParams(args as object) as RecallParams, options),
    },
    {
      name: "memory_list",
      inputSchema: operationalSchemas.listParameters,
      annotations: readAnnotations,
      execute: (args, options) =>
        memoryToolExecutors.list(operationalParams(args as object) as ListParams, options),
    },
    {
      name: "memory_get",
      inputSchema: operationalSchemas.getParameters,
      annotations: readAnnotations,
      execute: (args, options) =>
        memoryToolExecutors.get(operationalParams(args as object) as GetParams, options),
    },
    {
      name: "memory_delete",
      inputSchema: operationalSchemas.memoryParameters,
      annotations: destructiveAnnotations,
      execute: (args, options) =>
        memoryToolExecutors.deleteMemory(
          operationalParams(args as object) as MemoryParams,
          options,
        ),
    },
    {
      name: "memory_summary",
      inputSchema: operationalSchemas.summaryParameters,
      annotations: readAnnotations,
      execute: (args, options) =>
        memoryToolExecutors.summary(operationalParams(args as object) as SummaryParams, options),
    },
    {
      name: "memory_delete_session",
      inputSchema: operationalSchemas.sessionParameters,
      annotations: destructiveAnnotations,
      execute: (args, options) =>
        memoryToolExecutors.deleteSession(
          operationalParams(args as object) as SessionParams,
          options,
        ),
    },
    {
      name: "memory_delete_profile",
      inputSchema: profileOnlyParameters,
      annotations: destructiveAnnotations,
      execute: (args, options) => memoryToolExecutors.deleteProfile(args as ProfileParams, options),
    },
  ];
}

/** Format the first TypeBox validation failure for an MCP client. */
function validationError(schema: TSchema, value: unknown): string {
  const first = Value.Errors(schema, value)[0];
  if (!first) return "Invalid arguments";
  return `Invalid arguments at ${first.instancePath || "/"}: ${first.message}`;
}

/**
 * Convert a shared tool result to the MCP text-result contract.
 *
 * `structuredContent` is intentionally omitted because clients prefer it over
 * `content`, which would hide the human-readable memory result.
 */
function toCallToolResult(result: MemoryToolResult): CallToolResult {
  return { content: result.content.map((part) => ({ type: "text" as const, text: part.text })) };
}

/**
 * Create a stdio-compatible MCP server exposing the shared memory tool surface.
 *
 * The server publishes the TypeBox schemas that back the Pi extension and
 * validates every request before forwarding it to the shared executors. The
 * low-level `Server` is deliberate: `McpServer` accepts Zod schemas only, which
 * would require a second definition of every tool parameter shape.
 *
 * @returns An unconnected MCP server; the caller owns its transport and lifecycle.
 */
export function createMcpServer(): Server {
  const tools = createTools();
  const toolsByName = new Map(tools.map((tool) => [tool.name as string, tool]));
  const server = new Server({ name: "memory", version }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map((tool): Tool => ({
      name: tool.name,
      title: memoryToolMeta[tool.name].label,
      description: memoryToolMeta[tool.name].description,
      inputSchema: tool.inputSchema as Tool["inputSchema"],
      annotations: tool.annotations,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const tool = toolsByName.get(request.params.name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `Unknown memory tool: ${request.params.name}` }],
        isError: true,
      };
    }

    const args = request.params.arguments ?? {};
    if (!Value.Check(tool.inputSchema, args)) {
      return {
        content: [{ type: "text", text: validationError(tool.inputSchema, args) }],
        isError: true,
      };
    }

    try {
      return toCallToolResult(await tool.execute(args, { signal: extra.signal }));
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `${tool.name} failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}
