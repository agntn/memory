import type { AbortOptions } from "@agntn/memory";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import {
  createOperationalMemoryToolSchemas,
  namespaceListParameters,
  namespaceParameters,
  profileListParameters,
  profileOnlyParameters,
} from "./memory-tool-schemas.ts";
import {
  applyMemoryScope,
  applyMemoryWriteScope,
  memoryToolMeta,
  memoryToolProgress,
  type MemoryToolExecutors,
  singleLineToolText,
} from "./memory-tools.ts";
import type {
  GetParams,
  IngestParams,
  ListParams,
  MemoryParams,
  MemoryToolResult,
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
} from "./memory-tools.types.ts";
import { toolErrorMessage } from "./tool-errors.ts";

export type MemoryMcpToolName = keyof typeof memoryToolMeta;

export interface MemoryMcpToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/** One row of an MCP server's tool table; Pi and OMP register their own shapes. */
export interface MemoryMcpTool {
  name: MemoryMcpToolName;
  inputSchema: TSchema;
  annotations: MemoryMcpToolAnnotations;
  /** Called only after `Value.Check` accepted the arguments against `inputSchema`. */
  execute(args: unknown, options: AbortOptions): Promise<MemoryToolResult>;
}

/** One `tools/list` entry. */
export interface MemoryMcpToolListing {
  name: MemoryMcpToolName;
  title: string;
  description: string;
  inputSchema: { type: "object"; [key: string]: unknown };
  annotations: MemoryMcpToolAnnotations;
}

/** What an MCP server returns for a tool call, in the shape both SDK versions accept. */
export interface MemoryMcpCallResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface MemoryMcpToolOptions {
  executors: MemoryToolExecutors;
  /** A bound namespace and profile, or `undefined` for the raw multi-profile surface. */
  scope: ProfileParams | undefined;
  /** The session a write is filed under; asked at every write. */
  writeSessionId(): string | undefined;
  /**
   * Include the namespace tools, the profile listing and profile deletion.
   * A Workers binding has no namespace calls, so a server on one leaves them out.
   */
  administration: boolean;
}

/** Every tool reaches Cloudflare Agent Memory, so no operation is closed-world. */
const readAnnotations: MemoryMcpToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
const writeAnnotations: MemoryMcpToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};
const destructiveAnnotations: MemoryMcpToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};
const supersedeAnnotations: MemoryMcpToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

/**
 * Build the MCP tool table over one set of executors.
 *
 * @param options - Executors, scope, write session and whether administration tools are served.
 * @returns {MemoryMcpTool[]} The tools in the order clients list them.
 */
export function createMemoryMcpTools(options: MemoryMcpToolOptions): MemoryMcpTool[] {
  const { executors, scope } = options;
  const operationalSchemas = createOperationalMemoryToolSchemas(Boolean(scope));

  function operationalParams<T extends object>(args: T): T & ProfileParams {
    return applyMemoryScope(args, scope);
  }

  function operationalWriteParams<T extends object>(
    args: T,
  ): T & ProfileParams & { sessionId?: string } {
    return applyMemoryWriteScope(args, scope, options.writeSessionId());
  }

  const namespaceTools: MemoryMcpTool[] = [
    {
      name: "memory_namespace_list",
      inputSchema: namespaceListParameters,
      annotations: readAnnotations,
      execute: (args, callOptions) =>
        executors.listNamespaces(args as NamespaceListParams, callOptions),
    },
    {
      name: "memory_namespace_get",
      inputSchema: namespaceParameters,
      annotations: readAnnotations,
      execute: (args, callOptions) => executors.getNamespace(args as NamespaceParams, callOptions),
    },
    {
      name: "memory_namespace_create",
      inputSchema: namespaceParameters,
      annotations: writeAnnotations,
      execute: (args, callOptions) =>
        executors.createNamespace(args as NamespaceParams, callOptions),
    },
    {
      name: "memory_namespace_delete",
      inputSchema: namespaceParameters,
      annotations: destructiveAnnotations,
      execute: (args, callOptions) =>
        executors.deleteNamespace(args as NamespaceParams, callOptions),
    },
    {
      name: "memory_profile_list",
      inputSchema: profileListParameters,
      annotations: readAnnotations,
      execute: (args, callOptions) =>
        executors.listProfiles(args as ProfileListParams, callOptions),
    },
  ];

  const operationalTools: MemoryMcpTool[] = [
    {
      name: "memory_remember",
      inputSchema: operationalSchemas.rememberParameters,
      annotations: writeAnnotations,
      execute: (args, callOptions) =>
        executors.remember(
          operationalWriteParams(args as { sessionId?: string }) as RememberParams,
          callOptions,
        ),
    },
    {
      name: "memory_supersede",
      inputSchema: operationalSchemas.supersedeParameters,
      annotations: supersedeAnnotations,
      execute: (args, callOptions) =>
        executors.supersede(
          operationalWriteParams(args as { sessionId?: string }) as SupersedeParams,
          callOptions,
        ),
    },
    {
      name: "memory_resume_supersession",
      inputSchema: operationalSchemas.resumeSupersessionParameters,
      annotations: supersedeAnnotations,
      execute: (args, callOptions) =>
        executors.resumeSupersession(
          operationalParams(args as object) as ResumeSupersessionParams,
          callOptions,
        ),
    },
    {
      name: "memory_wait_for_recall",
      inputSchema: operationalSchemas.recallVisibilityParameters,
      annotations: readAnnotations,
      execute: (args, callOptions) =>
        executors.waitForRecall(
          operationalParams(args as object) as RecallVisibilityParams,
          callOptions,
        ),
    },
    {
      name: "memory_ingest",
      inputSchema: operationalSchemas.ingestParameters,
      annotations: writeAnnotations,
      execute: (args, callOptions) =>
        executors.ingest(
          operationalWriteParams(args as { sessionId?: string }) as IngestParams,
          callOptions,
        ),
    },
    {
      name: "memory_recall",
      inputSchema: operationalSchemas.recallParameters,
      annotations: readAnnotations,
      execute: (args, callOptions) =>
        executors.recall(operationalParams(args as object) as RecallParams, callOptions),
    },
    {
      name: "memory_list",
      inputSchema: operationalSchemas.listParameters,
      annotations: readAnnotations,
      execute: (args, callOptions) =>
        executors.list(operationalParams(args as object) as ListParams, callOptions),
    },
    {
      name: "memory_get",
      inputSchema: operationalSchemas.getParameters,
      annotations: readAnnotations,
      execute: (args, callOptions) =>
        executors.get(operationalParams(args as object) as GetParams, callOptions),
    },
    {
      name: "memory_delete",
      inputSchema: operationalSchemas.memoryParameters,
      annotations: destructiveAnnotations,
      execute: (args, callOptions) =>
        executors.deleteMemory(operationalParams(args as object) as MemoryParams, callOptions),
    },
    {
      name: "memory_summary",
      inputSchema: operationalSchemas.summaryParameters,
      annotations: readAnnotations,
      execute: (args, callOptions) =>
        executors.summary(operationalParams(args as object) as SummaryParams, callOptions),
    },
    {
      name: "memory_delete_session",
      inputSchema: operationalSchemas.sessionParameters,
      annotations: destructiveAnnotations,
      execute: (args, callOptions) =>
        executors.deleteSession(operationalParams(args as object) as SessionParams, callOptions),
    },
  ];

  const profileDeletion: MemoryMcpTool = {
    name: "memory_delete_profile",
    inputSchema: profileOnlyParameters,
    annotations: destructiveAnnotations,
    execute: (args, callOptions) => executors.deleteProfile(args as ProfileParams, callOptions),
  };

  return options.administration
    ? [...namespaceTools, ...operationalTools, profileDeletion]
    : operationalTools;
}

/**
 * The `tools/list` entries for a tool table.
 *
 * @param tools - The table from `createMemoryMcpTools`.
 * @returns {MemoryMcpToolListing[]} The entries in table order.
 */
export function listMemoryMcpTools(tools: readonly MemoryMcpTool[]): MemoryMcpToolListing[] {
  return tools.map((tool) => ({
    name: tool.name,
    title: memoryToolMeta[tool.name].label,
    description: memoryToolMeta[tool.name].description,
    inputSchema: tool.inputSchema as { type: "object"; [key: string]: unknown },
    annotations: tool.annotations,
  }));
}

/* Format the first TypeBox validation failure for an MCP client. */
function validationError(schema: TSchema, value: unknown): string {
  const first = Value.Errors(schema, value)[0];
  if (!first) return "Invalid arguments";
  return `Invalid arguments at ${first.instancePath || "/"}: ${first.message}`;
}

/**
 * Validate and run one tool call.
 *
 * `structuredContent` is intentionally omitted because clients prefer it over
 * `content`, which would hide the human-readable memory result.
 *
 * @param tool - The tool the client named, or `undefined` when no tool has that name.
 * @param name - The name the client sent, for the unknown-tool message.
 * @param args - The raw arguments.
 * @param options - Request cancellation.
 * @returns {Promise<MemoryMcpCallResult>} The text result, with `isError` on any failure.
 */
export async function callMemoryMcpTool(
  tool: MemoryMcpTool | undefined,
  name: string,
  args: Readonly<Record<string, unknown>>,
  options: AbortOptions,
): Promise<MemoryMcpCallResult> {
  if (!tool) {
    return {
      content: [{ type: "text", text: `Unknown memory tool: ${singleLineToolText(name)}` }],
      isError: true,
    };
  }
  if (!Value.Check(tool.inputSchema, args)) {
    return {
      content: [{ type: "text", text: validationError(tool.inputSchema, args) }],
      isError: true,
    };
  }
  try {
    const result = await tool.execute(args, options);
    return { content: result.content.map((part) => ({ type: "text", text: part.text })) };
  } catch (error) {
    return {
      content: [{ type: "text", text: `${tool.name} failed: ${toolErrorMessage(error)}` }],
      isError: true,
    };
  }
}

/**
 * The progress line a long-running tool streams, with its total in milliseconds.
 *
 * @param name - The tool being called.
 * @param timeoutSeconds - The call's `timeoutSeconds` argument.
 * @returns {{ message: string; total: number } | undefined} The message and total, or `undefined` for a tool that reports no progress.
 */
export function memoryMcpProgress(
  name: MemoryMcpToolName,
  timeoutSeconds: unknown,
): { message: string; total: number } | undefined {
  const message =
    name === "memory_wait_for_recall"
      ? memoryToolProgress.memory_wait_for_recall
      : name === "memory_supersede"
        ? memoryToolProgress.memory_supersede
        : name === "memory_resume_supersession"
          ? memoryToolProgress.memory_resume_supersession
          : undefined;
  if (message === undefined || typeof timeoutSeconds !== "number") return undefined;
  return { message, total: timeoutSeconds * 1_000 };
}

export const MCP_PROGRESS_INTERVAL_MS = 30_000;
