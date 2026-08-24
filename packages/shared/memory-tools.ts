import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  AbortOptions,
  CloudflareMemoryOptions,
  Memory,
  MemoryProfile,
  MemoryProvider,
  RecallCandidate,
  RecallResult,
} from "@agntn/memory";
import type {
  GetParams,
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
 * Cap on how many memories one call may read with full content.
 *
 * Recall and list expansion and memory_get share it. Every full record is one
 * read against the service, and measured recall responses have never carried
 * more than 30 candidates.
 */
export const MAX_TOOL_EXPAND = 30;

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
      "Answer a question from a memory profile. Returns a prose answer, then the candidate memories it drew on as one JSON object per line with id, score, sessionId, summary, namespace, and profile. The score comes from the service's rank fusion: higher is more relevant, but it is not a calibrated similarity, so use it for ordering and not as a confidence threshold. Candidate summaries are capped by the service; pass expand to read the full content of the best-scoring candidates in the same call instead of following each id up with memory_get.",
  },
  memory_list: {
    label: "List Memories",
    description:
      "List a page of memory metadata: ids, summaries, types, sessions, timestamps. Memory content is not included; pass expand to read the full content of the first entries in the same call, or memory_get for chosen ids. Session ids appear here and nowhere else, so this is also how to find what memory_delete_session can remove.",
  },
  memory_get: {
    label: "Get Memories",
    description: `Get up to ${MAX_TOOL_EXPAND} memories, including their content, by exact identifier in one call. Duplicate ids are read once and records return in request order; when only some reads fail, those entries carry an error message instead of a record. An identifier that does not exist comes back as a server error rather than a not-found result.`,
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

/**
 * What the extensions print while a slow call is still running.
 *
 * Recall waits on the service's own model and ingest waits on extraction, so
 * both leave the row silent for seconds. The other tools answer fast enough
 * that a progress line would only flicker.
 */
export const memoryToolProgress = {
  memory_recall: "Searching memories",
  memory_ingest: "Submitting messages for extraction",
} as const;

/**
 * Field descriptions for the parameter schemas.
 *
 * Pi and MCP read them through `memory-tool-schemas.ts`; the OMP extension reads
 * them directly, because it rebuilds its schemas with the host TypeBox but has
 * no reason to retype the prose.
 */
export const memoryFieldDescriptions = {
  namespace:
    "Cloudflare Agent Memory namespace. The service accepts lowercase letters, numbers, and internal hyphens only. List existing ones with memory_namespace_list.",
  profile:
    "Memory profile inside the namespace. The service accepts lowercase letters, numbers, and internal hyphens only. A profile starts existing on its first write; there is no profile listing.",
  writeSessionId:
    "Session identifier grouping related memories. It is the only unit memory_delete_session can remove, so pass one whenever the memories may need removing together.",
  cursor:
    "Cursor copied from the previous response. A response without a cursor was the last page.",
  rememberContent:
    "Memory content to store. The service writes it verbatim, assigns the memory type itself, and publishes no size limit for this field.",
  messageRole: "Who produced the message.",
  messageContent: "Message text.",
  messageTimestamp:
    "When the message was sent, as an ISO-8601 instant with an explicit offset, for example 2026-08-17T10:00:00Z.",
  messages: "Conversation messages in the order they were exchanged.",
  recallQuery: "Natural-language recall query.",
  thinkingLevel:
    "Retrieval breadth. Higher levels search more candidates and take longer. Defaults to low.",
  responseLength: "Requested length of the prose answer. Defaults to medium.",
  referenceDate: "ISO-8601 date the service treats as now when the query is time-relative.",
  expand:
    "How many of the best-scoring candidates to return with full content, one extra read each. Candidate summaries are capped by the service, so expand the ones a conclusion will rest on.",
  listExpand:
    "How many memories from the top of the page to return with full content, one extra read each. The rest of the page keeps summaries only, and a read that fails shows content: null.",
  memoriesPerPage: `Memories per page, 1-${MAX_TOOL_LIST_LIMIT}.`,
  listSessionId: "Return only memories from this session.",
  memoryType: "Filter by the type the service assigned when the memory was written.",
  memoryId: "Exact memory identifier from memory_list, memory_remember, or memory_recall.",
  memoryIds:
    "Exact memory identifiers from memory_list, memory_remember, or memory_recall. Each unique id costs one read.",
  sessionToDelete: "Exact session identifier. Every memory carrying it is removed.",
  summarySessionId: "Summarize only this session instead of the whole profile.",
  namespacesPerPage: `Namespaces per page, 1-${MAX_TOOL_LIST_LIMIT}.`,
  sortField: "Sort field.",
  sortDirection: "Sort direction.",
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
 * Check the expand bounds before any round-trip is paid.
 *
 * Schemas enforce them for tool callers, but the executors are exported, and
 * handed in directly a negative count would silently slice from the wrong end
 * while an oversized one would authorize more reads than the published cap.
 */
function assertExpand(expand: number | undefined): void {
  if (expand === undefined) return;
  if (!Number.isInteger(expand) || expand < 1 || expand > MAX_TOOL_EXPAND) {
    throw new Error(`Expand must be an integer between 1 and ${MAX_TOOL_EXPAND}`);
  }
}

type MemoryReading = { memory: Memory } | { error: unknown };

/**
 * Read each unique id once and settle per id instead of failing the batch.
 *
 * memory_get and the expand paths share this fan-out, so a read policy added
 * here (dedup today, throttling tomorrow) covers both. The map keeps the ids in
 * first-seen order.
 */
async function readMemories(
  profile: MemoryProfile,
  ids: readonly string[],
  options: AbortOptions = {},
): Promise<Map<string, MemoryReading>> {
  const unique = [...new Set(ids)];
  const get = requireCapability(profile, "get");
  const readings = await Promise.all(
    unique.map((id) =>
      get(id, options).then(
        (memory): [string, MemoryReading] => [id, { memory }],
        (error: unknown): [string, MemoryReading] => [id, { error }],
      ),
    ),
  );
  return new Map(readings);
}

/**
 * Read the full content behind a set of memories.
 *
 * Summaries are capped by the service, so a conclusion drawn from them alone
 * misreads any memory longer than the cap. A read that fails maps to null: one
 * missing record must not take down the result it was meant to enrich.
 */
async function readContents(
  profile: MemoryProfile,
  ids: readonly string[],
  options: AbortOptions = {},
): Promise<Map<string, string | null>> {
  if (ids.length === 0) return new Map();
  const readings = await readMemories(profile, ids, options);
  return new Map(
    [...readings].map(([id, reading]): [string, string | null] => [
      id,
      "memory" in reading ? reading.memory.content : null,
    ]),
  );
}

/** Read the full content behind the best-scoring recall candidates. */
function expandCandidates(
  profile: MemoryProfile,
  candidates: readonly RecallCandidate[],
  expand: number | undefined,
  options: AbortOptions = {},
): Promise<Map<string, string | null>> {
  if (expand === undefined) return Promise.resolve(new Map());
  const top = candidates.toSorted((a, b) => b.score - a.score).slice(0, expand);
  return readContents(
    profile,
    top.map((candidate) => candidate.id),
    options,
  );
}

/**
 * Render a recall answer together with the memories it was drawn from.
 *
 * The answer alone is a dead end: without ids a caller cannot inspect, correct,
 * or delete the memory behind a recalled claim.
 */
function recallText(
  params: ProfileParams,
  result: RecallResult,
  expanded: Map<string, string | null>,
): string {
  const answer = result.answer || "No answer returned.";
  const header = `Recall from ${memoryTarget(params)}:`;
  if (result.candidates.length === 0) return `${header}\n\n${answer}`;
  const candidates = result.candidates.map((candidate) =>
    JSON.stringify({
      ...candidate,
      namespace: params.namespace,
      profile: params.profile,
      ...(expanded.has(candidate.id) ? { content: expanded.get(candidate.id) ?? null } : {}),
    }),
  );
  const failed = expanded.values().some((content) => content === null);
  const expansion =
    expanded.size === 0
      ? ""
      : `, full content on the ${expanded.size} best-scoring${failed ? " (null where the read failed)" : ""}`;
  return `${header}\n\n${answer}\n\nCandidates (${candidates.length}), one JSON object per line${expansion}:\n${candidates.join("\n")}`;
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
async function countMemories(
  profile: MemoryProfile,
  options: AbortOptions = {},
  sessionId?: string,
): Promise<RemovedCount> {
  if (typeof profile.list !== "function") return undefined;
  try {
    const page = await profile.list({
      limit: MAX_TOOL_LIST_LIMIT,
      ...options,
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

/**
 * Render one failed read, naming the missing-id ambiguity when it applies.
 *
 * Cloudflare answers an unknown id with a generic server error, so say so here,
 * but only for failures that could actually mean the id is not there.
 */
function describeReadError(params: ProfileParams, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!mayMeanMissing(error)) return message;
  return `${message} (an id that does not exist in ${memoryTarget(params)} fails this way too; confirm it with memory_list)`;
}

/** Restate a failure that could mean the addressed id is absent. */
function explainMissing(params: ProfileParams, error: unknown): unknown {
  if (!mayMeanMissing(error)) return error;
  return new Error(describeReadError(params, error), { cause: error });
}

/**
 * Check the id list bounds before any round-trip is paid.
 *
 * Schemas enforce them for tool callers, but the executors are exported, and an
 * oversized list handed in directly would authorize more reads than the
 * published cap.
 */
function assertMemoryIds(memoryIds: readonly string[]): void {
  if (!Array.isArray(memoryIds) || memoryIds.length < 1 || memoryIds.length > MAX_TOOL_EXPAND) {
    throw new Error(`Memory ids must be a list of 1 to ${MAX_TOOL_EXPAND} identifiers`);
  }
}

export const memoryToolExecutors = {
  async remember(params: RememberParams, options: AbortOptions = {}): Promise<MemoryToolResult> {
    const profile = await getProfile(params);
    const memory = await requireCapability(profile, "remember")(
      { content: params.content, sessionId: optionalString(params.sessionId) },
      options,
    );
    return {
      content: [{ type: "text", text: json(memory) }],
      details: memory as unknown as Record<string, unknown>,
    };
  },

  async ingest(params: IngestParams, options: AbortOptions = {}): Promise<MemoryToolResult> {
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
      ...options,
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

  /** Answer a recall query, expanding the best-scoring candidates on request. */
  async recall(params: RecallParams, options: AbortOptions = {}): Promise<MemoryToolResult> {
    assertExpand(params.expand);
    const profile = await getProfile(params);
    const result = await requireCapability(profile, "recall")(params.query, {
      thinkingLevel: params.thinkingLevel,
      responseLength: params.responseLength,
      referenceDate: optionalString(params.referenceDate),
      ...options,
    });
    const expanded = await expandCandidates(profile, result.candidates, params.expand, options);
    return {
      content: [{ type: "text", text: recallText(params, result, expanded) }],
      details: result as unknown as Record<string, unknown>,
    };
  },

  /** List a page of memories, expanding the first entries on request. */
  async list(params: ListParams, options: AbortOptions = {}): Promise<MemoryToolResult> {
    assertExpand(params.expand);
    const profile = await getProfile(params);
    const result = await requireCapability(
      profile,
      "list",
    )({
      limit: params.limit,
      cursor: optionalString(params.cursor),
      sessionId: optionalString(params.sessionId),
      type: params.type,
      ...options,
    });
    const expanded = await readContents(
      profile,
      result.memories.slice(0, params.expand ?? 0).map((memory) => memory.id),
      options,
    );
    const memories = result.memories.map((memory) =>
      expanded.has(memory.id) ? { ...memory, content: expanded.get(memory.id) ?? null } : memory,
    );
    const page = paged({ ...result, memories });
    return {
      content: [{ type: "text", text: json(page) }],
      details: page,
    };
  },

  /**
   * Read every requested memory, keeping first-seen order and per-id failures.
   *
   * When every read fails the call itself fails: a result that is nothing but
   * error entries would hide the failure from clients that only check isError.
   */
  async get(params: GetParams, options: AbortOptions = {}): Promise<MemoryToolResult> {
    assertMemoryIds(params.memoryIds);
    const profile = await getProfile(params);
    const readings = await readMemories(profile, params.memoryIds, options);
    const entries = [...readings.entries()];
    const failed = entries.filter(
      (entry): entry is [string, { error: unknown }] => "error" in entry[1],
    );
    if (failed.length === entries.length) {
      const first = failed[0];
      /** A single-id total failure keeps memory_delete's flat error shape instead of a one-entry listing. */
      if (first && entries.length === 1) throw explainMissing(params, first[1].error);
      throw new Error(
        [
          `Every read in ${memoryTarget(params)} failed:`,
          ...failed.map(([id, { error }]) => `${id}: ${describeReadError(params, error)}`),
        ].join("\n"),
      );
    }
    const memories = entries.map(([id, reading]) =>
      "memory" in reading
        ? reading.memory
        : { id, error: describeReadError(params, reading.error) },
    );
    const header =
      failed.length === 0
        ? ""
        : `Read ${entries.length - failed.length} of ${entries.length} memories; error entries for: ${failed.map(([id]) => id).join(", ")}.\n`;
    return {
      content: [{ type: "text", text: `${header}${json(memories)}` }],
      details: { memories },
    };
  },

  async deleteMemory(params: MemoryParams, options: AbortOptions = {}): Promise<MemoryToolResult> {
    const profile = await getProfile(params);
    const result = await requireCapability(profile, "delete")(params.memoryId, options).catch(
      (error: unknown) => {
        throw explainMissing(params, error);
      },
    );
    return {
      content: [{ type: "text", text: json(result) }],
      details: result as unknown as Record<string, unknown>,
    };
  },

  async summary(params: SummaryParams, options: AbortOptions = {}): Promise<MemoryToolResult> {
    const profile = await getProfile(params);
    const result = await requireCapability(
      profile,
      "getSummary",
    )({
      sessionId: optionalString(params.sessionId),
      ...options,
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

  async deleteSession(
    params: SessionParams,
    options: AbortOptions = {},
  ): Promise<MemoryToolResult> {
    const profile = await getProfile(params);
    const removed = await countMemories(profile, options, params.sessionId);
    await requireCapability(profile, "deleteSession")(params.sessionId, options);
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

  async deleteProfile(
    params: ProfileParams,
    options: AbortOptions = {},
  ): Promise<MemoryToolResult> {
    const provider = await getProvider(params.namespace);
    if (!provider.deleteProfile) {
      throw new Error("Memory provider does not support deleteProfile");
    }
    const removed = await countMemories(await getProfile(params), options);
    await provider.deleteProfile(params.profile, options);
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

  async listNamespaces(
    params: NamespaceListParams,
    options: AbortOptions = {},
  ): Promise<MemoryToolResult> {
    const result = await (
      await getNamespaceClient()
    ).list({
      limit: params.limit,
      cursor: optionalString(params.cursor),
      order: params.order,
      direction: params.direction,
      ...options,
    });
    const page = paged(result);
    return {
      content: [{ type: "text", text: json(page) }],
      details: page,
    };
  },

  async createNamespace(
    params: NamespaceParams,
    options: AbortOptions = {},
  ): Promise<MemoryToolResult> {
    const namespace = await (await getNamespaceClient()).create(params.namespace, options);
    return {
      content: [{ type: "text", text: json(namespace) }],
      details: namespace as unknown as Record<string, unknown>,
    };
  },

  async deleteNamespace(
    params: NamespaceParams,
    options: AbortOptions = {},
  ): Promise<MemoryToolResult> {
    await (await getNamespaceClient()).delete(params.namespace, options);
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
