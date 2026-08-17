import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  CloudflareMemoryOptions,
  MemoryProfile,
  MemoryProvider,
  RecallResult,
} from "@agntn/memory";
import type {
  IngestParams,
  ListParams,
  MemoryModule,
  MemoryParams,
  MemoryToolResult,
  NamespaceListParams,
  NamespaceParams,
  ProfileParams,
  RecallParams,
  RememberParams,
  SessionParams,
  SummaryParams,
} from "./memory-tools.types.ts";

let memoryModulePromise: Promise<MemoryModule> | undefined;
let namespaceClientPromise:
  | Promise<InstanceType<MemoryModule["CloudflareNamespaceClient"]>>
  | undefined;
const providerPromises = new Map<string, Promise<MemoryProvider>>();

export const MAX_TOOL_LIST_LIMIT = 100;

/**
 * Bounds published in the tool schemas.
 *
 * They mirror `cloudflareMemoryLimits`, which the provider enforces, and
 * `test/tool-schemas.test.ts` keeps the two in step. Cloudflare counts UTF-8
 * bytes where these count characters, so non-ASCII text can pass a schema and
 * still be rejected by the provider with an explicit byte-limit error.
 */
export const MAX_TOOL_PROFILE_CHARACTERS = 100;
export const MAX_TOOL_NAMESPACE_CHARACTERS = 32;
export const MAX_TOOL_SESSION_ID_CHARACTERS = 64;
/** Namespaces and profiles share this charset rule; the service answers anything else with 400. */
export const MEMORY_NAME_PATTERN = "^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$";
/**
 * Identifiers that stay inside their own URL path segment.
 *
 * Slashes and the relative segments `.` and `..` are rejected: a dot segment
 * survives percent-encoding and would move a request up to the profile endpoint.
 */
export const MEMORY_ID_PATTERN = "^(?!\\.{1,2}$)[^/\\\\]+$";
/**
 * ISO-8601 instants that carry an explicit offset.
 *
 * `new Date("2026-08-17T10:00:00")` resolves against the host time zone, so an
 * offset-less timestamp would be stored as a different instant on every machine.
 */
export const ISO_INSTANT_PATTERN =
  "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d{1,9})?)?(Z|[+-]\\d{2}:\\d{2})$";
export const MAX_TOOL_QUERY_CHARACTERS = 1_024;
export const MAX_TOOL_MESSAGE_CHARACTERS = 32_768;
export const MAX_TOOL_INGEST_MESSAGES = 500;

/**
 * Names and descriptions shared by the Pi, OMP, and MCP tool surfaces.
 *
 * Descriptions state what the service does with a call, including the parts a
 * caller cannot control: assigned memory types, asynchronous extraction, and
 * deletions that report no counts.
 */
export const memoryToolMeta = {
  memory_namespace_list: {
    label: "List Memory Namespaces",
    description: "List Cloudflare Agent Memory namespaces for the configured account.",
  },
  memory_namespace_create: {
    label: "Create Memory Namespace",
    description:
      "Create one Cloudflare Agent Memory namespace. Every other tool addresses namespaces by name, not by the returned id.",
  },
  memory_namespace_delete: {
    label: "Delete Memory Namespace",
    description:
      "Permanently delete one Cloudflare Agent Memory namespace with every profile and memory inside it. There is no dry run, no undo, and no count of what was removed.",
  },
  memory_remember: {
    label: "Remember",
    description:
      "Store one durable memory in a Cloudflare Agent Memory profile. The service writes the content verbatim and assigns the summary and the memory type itself.",
  },
  memory_ingest: {
    label: "Ingest Messages",
    description:
      "Hand a bounded sequence of conversation messages to the extraction service. Extraction is asynchronous and decides on its own how many memories the messages produce, so the new memories show up in memory_list and memory_recall only after it finishes. Use memory_remember when one exact memory has to exist.",
  },
  memory_recall: {
    label: "Recall",
    description:
      "Answer a question from a memory profile. Returns a prose answer, then the candidate memories it drew on as one JSON object per line with id, score, sessionId, summary, namespace, and profile. The score comes from the service's rank fusion: higher is more relevant, but it is not a calibrated similarity, so use it for ordering and not as a confidence threshold.",
  },
  memory_list: {
    label: "List Memories",
    description:
      "List a page of memory metadata: ids, summaries, types, sessions, timestamps. Memory content is not included; read it with memory_get. Session ids appear here and nowhere else, so this is also how to find what memory_delete_session can remove.",
  },
  memory_get: {
    label: "Get Memory",
    description:
      "Get one memory, including its content, by exact identifier. An identifier that does not exist comes back as a server error rather than a not-found result.",
  },
  memory_delete: {
    label: "Delete Memory",
    description:
      "Delete one memory by exact identifier and return the deleted record. An identifier that does not exist comes back as a server error rather than a not-found result.",
  },
  memory_summary: {
    label: "Memory Summary",
    description:
      "Summarize a memory profile or one session. The service returns Markdown prose without memory ids; use memory_list or memory_recall when ids are needed.",
  },
  memory_delete_session: {
    label: "Delete Memory Session",
    description:
      "Delete every memory carrying one session id, which memory_list reports per memory. This is the only bulk deletion below profile level. The result counts what the session held, and says so explicitly when the session held nothing, because the service accepts a delete for a session that does not exist.",
  },
  memory_delete_profile: {
    label: "Delete Memory Profile",
    description:
      "Delete an entire memory profile and everything stored in it. There is no dry run and no undo; the result counts what the profile held.",
  },
} as const;

function loadMemory(): Promise<MemoryModule> {
  if (!memoryModulePromise) {
    const sourceUrl = new URL("../../src/index.ts", import.meta.url);
    // Runtime-selected so a checkout uses current source while a published package uses dist.
    memoryModulePromise = existsSync(fileURLToPath(sourceUrl))
      ? import(sourceUrl.href).then((memory) => memory as MemoryModule)
      : import("@agntn/memory").then((memory) => memory as unknown as MemoryModule);
  }
  return memoryModulePromise;
}

function getCredentials(): { accountId: string; apiToken: string } {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) {
    throw new Error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN");
  }
  return { accountId, apiToken };
}

function optionalString(value: string | undefined): string | undefined {
  return value === "" ? undefined : value;
}

async function getNamespaceClient(): Promise<
  InstanceType<MemoryModule["CloudflareNamespaceClient"]>
> {
  if (!namespaceClientPromise) {
    const credentials = getCredentials();
    namespaceClientPromise = loadMemory().then(
      (memory) => new memory.CloudflareNamespaceClient(credentials),
    );
  }
  return namespaceClientPromise;
}

async function getProvider(namespace: string): Promise<MemoryProvider> {
  let providerPromise = providerPromises.get(namespace);
  if (!providerPromise) {
    const credentials = getCredentials();
    providerPromise = loadMemory().then((memory) => {
      memory.registerAll();
      return memory.create<CloudflareMemoryOptions>("cloudflare", {
        ...credentials,
        namespace,
      });
    });
    providerPromises.set(namespace, providerPromise);
  }
  return providerPromise;
}

async function getProfile(params: ProfileParams): Promise<MemoryProfile> {
  const profile = params.profile.trim();
  if (!profile) throw new Error("Profile cannot be empty");
  return (await getProvider(params.namespace)).getProfile(profile);
}

function requireCapability<K extends keyof MemoryProfile>(
  profile: MemoryProfile,
  capability: K,
): NonNullable<MemoryProfile[K]> {
  const operation = profile[capability];
  if (typeof operation !== "function") {
    throw new Error(`Memory provider does not support ${String(capability)}`);
  }
  return operation.bind(profile) as NonNullable<MemoryProfile[K]>;
}

function json(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, item) => (item instanceof Date ? item.toISOString() : item),
    2,
  );
}

export function memoryTarget(params: ProfileParams): string {
  return `${params.namespace}/${params.profile}`;
}

/**
 * Restate a page result with an explicit end-of-pages marker.
 *
 * A missing cursor key reads as an unimplemented feature; `hasMore: false` says
 * the page was the last one.
 */
function paged<T extends { cursor?: string }>(result: T): Record<string, unknown> {
  return { ...result, cursor: result.cursor ?? null, hasMore: result.cursor !== undefined };
}

/**
 * Render a recall answer together with the memories it was drawn from.
 *
 * The answer alone is a dead end: without ids a caller cannot inspect, correct,
 * or delete the memory behind a recalled claim.
 */
function recallText(params: ProfileParams, result: RecallResult): string {
  const answer = result.answer || "No answer returned.";
  const header = `Recall from ${memoryTarget(params)}:`;
  if (result.candidates.length === 0) return `${header}\n\n${answer}`;
  const candidates = result.candidates.map((candidate) =>
    JSON.stringify({ ...candidate, namespace: params.namespace, profile: params.profile }),
  );
  return `${header}\n\n${answer}\n\nCandidates (${candidates.length}), one JSON object per line:\n${candidates.join("\n")}`;
}

/** How much a cascade delete removed, or `undefined` when it could not be read. */
type RemovedCount = { count: number; atLeast: boolean } | undefined;

/**
 * Count the memories a cascade delete is about to remove.
 *
 * Cloudflare accepts a delete for a session that holds nothing and answers it
 * exactly like a real one, so without this the caller cannot tell a typo from a
 * successful removal. One page is enough to make that distinction, and a failed
 * read must never stop the delete the caller actually asked for.
 */
async function countMemories(profile: MemoryProfile, sessionId?: string): Promise<RemovedCount> {
  if (typeof profile.list !== "function") return undefined;
  try {
    const page = await profile.list({
      limit: MAX_TOOL_LIST_LIMIT,
      ...(sessionId === undefined ? {} : { sessionId }),
    });
    return { count: page.memories.length, atLeast: page.cursor !== undefined };
  } catch {
    return undefined;
  }
}

function removedText(removed: RemovedCount): string {
  if (removed === undefined) return "an unknown number of memories";
  if (removed.atLeast) return `at least ${removed.count} memories`;
  return removed.count === 1 ? "1 memory" : `${removed.count} memories`;
}

/** Whether a failure could mean the addressed memory simply is not there. */
function mayMeanMissing(error: unknown): boolean {
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === "number" && (status === 404 || status >= 500);
}

export const memoryToolExecutors = {
  async remember(params: RememberParams): Promise<MemoryToolResult> {
    const profile = await getProfile(params);
    const memory = await requireCapability(
      profile,
      "remember",
    )({ content: params.content, sessionId: optionalString(params.sessionId) });
    return {
      content: [{ type: "text", text: json(memory) }],
      details: memory as unknown as Record<string, unknown>,
    };
  },

  async ingest(params: IngestParams): Promise<MemoryToolResult> {
    const profile = await getProfile(params);
    // Copy the modelled fields only: anything else the caller attached would be
    // posted upstream under the account token without appearing in the schema.
    const messages = params.messages.map((message) => {
      const timestamp = optionalString(message.timestamp);
      return {
        role: message.role,
        content: message.content,
        ...(timestamp === undefined ? {} : { timestamp: new Date(timestamp) }),
      };
    });
    await requireCapability(profile, "ingest")(messages, {
      sessionId: optionalString(params.sessionId),
    });
    const sessionId = optionalString(params.sessionId);
    const session = sessionId === undefined ? "" : ` in session ${sessionId}`;
    return {
      content: [
        {
          type: "text",
          text: `Submitted ${messages.length} messages for ingestion into ${memoryTarget(params)}${session}. Extraction runs asynchronously: memories appear in memory_list and memory_recall once it finishes, and the service decides how many memories the messages produce.`,
        },
      ],
      details: {
        namespace: params.namespace,
        profile: params.profile,
        messageCount: messages.length,
        ...(sessionId === undefined ? {} : { sessionId }),
      },
    };
  },

  async recall(params: RecallParams): Promise<MemoryToolResult> {
    const profile = await getProfile(params);
    const result = await requireCapability(profile, "recall")(params.query, {
      thinkingLevel: params.thinkingLevel,
      responseLength: params.responseLength,
      referenceDate: optionalString(params.referenceDate),
    });
    return {
      content: [{ type: "text", text: recallText(params, result) }],
      details: result as unknown as Record<string, unknown>,
    };
  },

  async list(params: ListParams): Promise<MemoryToolResult> {
    const profile = await getProfile(params);
    const result = await requireCapability(
      profile,
      "list",
    )({
      limit: params.limit,
      cursor: optionalString(params.cursor),
      sessionId: optionalString(params.sessionId),
      type: params.type,
    });
    const page = paged(result);
    return {
      content: [{ type: "text", text: json(page) }],
      details: page,
    };
  },

  async memory(params: MemoryParams, operation: "get" | "delete"): Promise<MemoryToolResult> {
    const profile = await getProfile(params);
    const result = await requireCapability(
      profile,
      operation,
    )(params.memoryId).catch((error: unknown) => {
      // Cloudflare answers an unknown id with a generic server error, so say so here,
      // but only for failures that could actually mean the id is absent.
      if (!mayMeanMissing(error)) throw error;
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} (an id that does not exist in ${memoryTarget(params)} fails this way too; confirm it with memory_list)`,
        { cause: error },
      );
    });
    return {
      content: [{ type: "text", text: json(result) }],
      details: result as unknown as Record<string, unknown>,
    };
  },

  async summary(params: SummaryParams): Promise<MemoryToolResult> {
    const profile = await getProfile(params);
    const result = await requireCapability(
      profile,
      "getSummary",
    )({
      sessionId: optionalString(params.sessionId),
    });
    const sessionId = optionalString(params.sessionId);
    const scope =
      sessionId === undefined
        ? `Summary of ${memoryTarget(params)}, all sessions:`
        : `Summary of ${memoryTarget(params)}, session ${sessionId}:`;
    return {
      content: [{ type: "text", text: `${scope}\n\n${result.summary}` }],
      details: result as unknown as Record<string, unknown>,
    };
  },

  async deleteSession(params: SessionParams): Promise<MemoryToolResult> {
    const profile = await getProfile(params);
    const removed = await countMemories(profile, params.sessionId);
    await requireCapability(profile, "deleteSession")(params.sessionId);
    const text =
      removed?.count === 0 && !removed.atLeast
        ? `No memory in ${memoryTarget(params)} carried session ${params.sessionId}; nothing was removed. Check the session id against memory_list.`
        : `Deleted session ${params.sessionId} in ${memoryTarget(params)}, holding ${removedText(removed)}.`;
    return {
      content: [{ type: "text", text }],
      details: {
        namespace: params.namespace,
        profile: params.profile,
        sessionId: params.sessionId,
        removedMemories: removed?.count ?? null,
        removedAtLeast: removed?.atLeast ?? null,
      },
    };
  },

  async deleteProfile(params: ProfileParams): Promise<MemoryToolResult> {
    const provider = await getProvider(params.namespace);
    if (!provider.deleteProfile) {
      throw new Error("Memory provider does not support deleteProfile");
    }
    const removed = await countMemories(await getProfile(params));
    await provider.deleteProfile(params.profile);
    const text =
      removed?.count === 0 && !removed.atLeast
        ? `Deleted profile ${memoryTarget(params)}, which held no memories. A profile name that was never written to reports the same result.`
        : `Deleted profile ${memoryTarget(params)}, holding ${removedText(removed)}.`;
    return {
      content: [{ type: "text", text }],
      details: {
        namespace: params.namespace,
        profile: params.profile,
        removedMemories: removed?.count ?? null,
        removedAtLeast: removed?.atLeast ?? null,
      },
    };
  },

  async listNamespaces(params: NamespaceListParams): Promise<MemoryToolResult> {
    const result = await (
      await getNamespaceClient()
    ).list({
      limit: params.limit,
      cursor: optionalString(params.cursor),
      order: params.order,
      direction: params.direction,
    });
    const page = paged(result);
    return {
      content: [{ type: "text", text: json(page) }],
      details: page,
    };
  },

  async createNamespace(params: NamespaceParams): Promise<MemoryToolResult> {
    const namespace = await (await getNamespaceClient()).create(params.namespace);
    return {
      content: [{ type: "text", text: json(namespace) }],
      details: namespace as unknown as Record<string, unknown>,
    };
  },

  async deleteNamespace(params: NamespaceParams): Promise<MemoryToolResult> {
    await (await getNamespaceClient()).delete(params.namespace);
    return {
      content: [
        {
          type: "text",
          text: `Deleted namespace ${params.namespace} with every profile and memory it held.`,
        },
      ],
      details: { namespace: params.namespace },
    };
  },
};
