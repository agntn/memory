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
import { type CloudflareCredentials, getCloudflareCredentials } from "./cloudflare-credentials.ts";
import { isIngestedMessageId } from "./memory-ids.ts";
import { singleLineToolText, TOOL_TEXT_CONTROL_PATTERN } from "./terminal-text.ts";
import { toolErrorMessage } from "./tool-errors.ts";
import {
  MAX_TOOL_LIST_LIMIT,
  MEMORY_ID_PATTERN,
  ISO_INSTANT_PATTERN,
  MAX_TOOL_QUERY_CHARACTERS,
  MAX_TOOL_RECALL_VISIBILITY_TIMEOUT_SECONDS,
  SERVICE_GENERATED_UNTRUSTED,
  MAX_TOOL_EXPAND,
  DEFAULT_TOOL_RECALL_CANDIDATES,
  RECALL_RELEVANCE_FLOOR,
  RECALL_RELEVANCE_FLOOR_TEXT,
  RECALL_SCORE_DIGITS,
} from "./memory-tool-contract.ts";
import type {
  GetParams,
  IngestParams,
  ListParams,
  MemoryModule,
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

export { singleLineToolText };
export {
  MAX_TOOL_LIST_LIMIT,
  MAX_TOOL_PROFILE_CHARACTERS,
  MAX_TOOL_NAMESPACE_CHARACTERS,
  MAX_TOOL_SESSION_ID_CHARACTERS,
  MEMORY_NAME_PATTERN,
  MEMORY_ID_PATTERN,
  ISO_INSTANT_PATTERN,
  MAX_TOOL_QUERY_CHARACTERS,
  MAX_TOOL_RECALL_VISIBILITY_TIMEOUT_SECONDS,
  MAX_TOOL_MESSAGE_CHARACTERS,
  MAX_TOOL_MEMORY_CONTENT_CHARACTERS,
  MAX_TOOL_INGEST_MESSAGES,
  MAX_TOOL_EXPAND,
  DEFAULT_TOOL_RECALL_CANDIDATES,
  memoryToolMeta,
  memoryToolProgress,
  memoryFieldDescriptions,
} from "./memory-tool-contract.ts";

let memoryModulePromise: Promise<MemoryModule> | undefined;
let namespaceClientPromise:
  | Promise<InstanceType<MemoryModule["CloudflareNamespaceClient"]>>
  | undefined;
const providerPromises = new Map<string, Promise<MemoryProvider>>();
let credentialsKey: string | undefined;

const memoryIdPattern = new RegExp(MEMORY_ID_PATTERN);
const isoInstantPattern = new RegExp(ISO_INSTANT_PATTERN);
const MAX_RECALL_VISIBILITY_POLL_INTERVAL_MS = 10_000;

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

/**
 * Resolve credentials and drop clients built for a token that is gone.
 *
 * A cf OAuth token rotates while the process lives, and every cached client
 * carries the token it was built with.
 * @returns {Promise<CloudflareCredentials>} Credentials for the next request.
 */
async function getCredentials(): Promise<CloudflareCredentials> {
  const credentials = await getCloudflareCredentials();
  const key = `${credentials.accountId}\n${credentials.apiToken}`;
  if (key !== credentialsKey) {
    credentialsKey = key;
    namespaceClientPromise = undefined;
    providerPromises.clear();
  }
  return credentials;
}

function optionalString(value: string | undefined): string | undefined {
  return value === "" ? undefined : value;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leapYear ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function hasValidCalendarDate(value: string): boolean {
  const date = /^(\d{4})-(\d{2})-(\d{2})(?:T|$)/.exec(value);
  if (!date) return true;
  const year = Number(date[1]);
  const month = Number(date[2]);
  const day = Number(date[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

/**
 * Parses an instant without letting Date silently move an impossible source day.
 * @param value - Timestamp text from a tool call.
 * @returns {Date} The exact represented instant.
 */
function messageTimestamp(value: string): Date {
  const timestamp = new Date(value);
  if (
    !isoInstantPattern.test(value) ||
    !hasValidCalendarDate(value) ||
    Number.isNaN(timestamp.getTime())
  ) {
    throw new Error(
      "Message timestamp must be an ISO-8601 instant with an explicit offset and valid calendar date",
    );
  }
  return timestamp;
}

async function getNamespaceClient(): Promise<
  InstanceType<MemoryModule["CloudflareNamespaceClient"]>
> {
  const credentials = await getCredentials();
  namespaceClientPromise ??= loadMemory().then(
    (memory) => new memory.CloudflareNamespaceClient(credentials),
  );
  return namespaceClientPromise;
}

async function getProvider(namespace: string): Promise<MemoryProvider> {
  const credentials = await getCredentials();
  let providerPromise = providerPromises.get(namespace);
  if (!providerPromise) {
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
    throw new TypeError(`Memory provider does not support ${String(capability)}`);
  }
  return operation.bind(profile) as NonNullable<MemoryProfile[K]>;
}

function json(value: unknown): string {
  return JSON.stringify(value, dateAsIso, 2);
}

function quoteToolText(value: string): string {
  return JSON.stringify(singleLineToolText(value));
}

/* Keep untrusted multiline text visibly below its owning record or header. */
function indentToolText(value: string): string {
  return `  ${value.replaceAll(TOOL_TEXT_CONTROL_PATTERN, (character) =>
    character === "\n" ? "\n  " : " ",
  )}`;
}

function dateAsIso(_key: string, item: unknown): unknown {
  return item instanceof Date ? item.toISOString() : item;
}

/* Whether a record carries full content to indent; one rule for the renderer and the headers. */
function hasFullContent(value: unknown): value is Record<string, unknown> & { content: string } {
  return typeof (value as { content?: unknown } | null)?.content === "string";
}

/* Mark a summary generated by the service without changing records that carry none. */
function withSummaryTrust(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  if (typeof (value as { summary?: unknown }).summary !== "string") return value;
  return { ...value, summaryTrust: SERVICE_GENERATED_UNTRUSTED };
}

/*
 * One compact JSON object per line, full content indented below its record:
 * inlined, a JSON string folds a long memory into one physical line MCP hosts
 * truncate into an ungreppable blob, and the indent keeps records alone at column zero.
 */
function recordLines(values: readonly unknown[]): string {
  return values
    .map((value) => {
      const marked = withSummaryTrust(value);
      if (!hasFullContent(marked)) return JSON.stringify(marked, dateAsIso);
      const { content, ...rest } = marked;
      return `${JSON.stringify(rest, dateAsIso)}\n${indentToolText(content)}`;
    })
    .join("\n");
}

export function memoryTarget(params: ProfileParams): string {
  return `${params.namespace}/${params.profile}`;
}

/*
 * Restate a page result with an explicit end-of-pages marker.
 *
 * A missing cursor key reads as an unimplemented feature; `hasMore: false` says
 * the page was the last one.
 */
function paged<T extends { cursor?: string }>(result: T): Record<string, unknown> {
  return { ...result, cursor: result.cursor ?? null, hasMore: result.cursor !== undefined };
}

/*
 * Check a count parameter's bounds before any round-trip is paid.
 *
 * Schemas enforce them for tool callers, but the executors are exported, and
 * handed in directly a negative count would silently slice from the wrong end
 * while an oversized one would step over the published cap.
 */
function assertCount(value: number | undefined, label: string): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 1 || value > MAX_TOOL_EXPAND) {
    throw new Error(`${label} must be an integer between 1 and ${MAX_TOOL_EXPAND}`);
  }
}

type MemoryReading = { memory: Memory } | { error: unknown };

/*
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
  /**
   * A cancelled batch is cancelled, not partially read.
   *
   * The settle-per-id policy above cannot tell an abort from a missing record,
   * so without this check the reads that were still in flight would come back
   * as per-id errors, or as `content: null` through the expansion paths, and a
   * caller who cancelled would receive a result that looks complete.
   */
  options.signal?.throwIfAborted();
  return new Map(readings);
}

/*
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

/* Best score first; a stable sort keeps the service's order between equal scores. */
function rankByScore(candidates: readonly RecallCandidate[]): readonly RecallCandidate[] {
  return candidates.slice().sort((a, b) => b.score - a.score);
}

/** What a recall candidate is: an extracted memory, or a raw message ingest stored next to them. */
type CandidateKind = "memory" | "message";

/* Tell a message from a memory by the id alone; the other three fields look the same on both. */
function candidateKind(candidate: RecallCandidate): CandidateKind {
  return isIngestedMessageId(candidate.id) ? "message" : "memory";
}

/*
 * The cap a recall keeps: the caller's, else the default widened until the lines hold the memory
 * candidates an explicit expand reads, because the messages ranked among them take lines too.
 */
function keptCandidates(params: RecallParams, candidates: readonly RecallCandidate[]): number {
  if (params.candidates !== undefined) return params.candidates;
  const expand = params.expand ?? 0;
  let memories = 0;
  let lines = 0;
  for (const [index, candidate] of rankByScore(candidates).entries()) {
    if (memories === expand) break;
    if (candidateKind(candidate) !== "memory") continue;
    memories += 1;
    lines = index + 1;
  }
  return Math.max(DEFAULT_TOOL_RECALL_CANDIDATES, lines);
}

/*
 * Drop the candidates that score orders of magnitude under the best one.
 *
 * Cloudflare ranks its whole candidate set, so a profile answers every recall
 * with the same number of lines whether or not it holds anything on the topic.
 * The fused score is not calibrated, which rules out a fixed threshold, but the
 * best score of the same call is a usable scale: a candidate that reaches less
 * than `RECALL_RELEVANCE_FLOOR` of it never carried the answer in the measured
 * responses and costs a line to read. An empty set and a zero top score leave
 * the candidates alone: there is no scale to measure them against.
 */
function relevantCandidates(candidates: readonly RecallCandidate[]): readonly RecallCandidate[] {
  const top = rankByScore(candidates)[0]?.score ?? 0;
  if (!(top > 0)) return candidates;
  const floor = top * RECALL_RELEVANCE_FLOOR;
  return candidates.filter((candidate) => candidate.score >= floor);
}

/*
 * Keep the best-scoring candidates, in the order the service ranked them.
 *
 * The service takes no candidate cap itself, so a busy profile answers every
 * recall with its full candidate set, tail scores included. The selection
 * follows the same rule as expand, by score, and the kept candidates stay in
 * service order.
 */
function trimCandidates(
  candidates: readonly RecallCandidate[],
  limit: number,
): readonly RecallCandidate[] {
  if (candidates.length <= limit) return candidates;
  const kept = new Set(
    rankByScore(candidates)
      .slice(0, limit)
      .map((candidate) => candidate.id),
  );
  return candidates.filter((candidate) => kept.has(candidate.id));
}

/* Read the full content behind the best-scoring memory candidates; a message has no record. */
function expandCandidates(
  profile: MemoryProfile,
  candidates: readonly RecallCandidate[],
  expand: number | undefined,
  options: AbortOptions = {},
): Promise<Map<string, string | null>> {
  if (expand === undefined) return Promise.resolve(new Map<string, string | null>());
  const top = rankByScore(candidates)
    .filter((candidate) => candidateKind(candidate) === "memory")
    .slice(0, expand);
  return readContents(
    profile,
    top.map((candidate) => candidate.id),
    options,
  );
}

/*
 * One result line per candidate, the score shortened. A message hands its text over as content,
 * so it goes indented under the line with its newlines intact and takes no summary trust marker.
 */
function candidateRecord(
  candidate: RecallCandidate,
  expanded: ReadonlyMap<string, string | null>,
): Record<string, unknown> {
  const score = Number(candidate.score.toPrecision(RECALL_SCORE_DIGITS));
  if (candidateKind(candidate) === "message") {
    return {
      id: candidate.id,
      kind: "message",
      sessionId: candidate.sessionId,
      score,
      content: candidate.summary,
    };
  }
  return {
    ...candidate,
    score,
    ...(expanded.has(candidate.id) ? { content: expanded.get(candidate.id) ?? null } : {}),
  };
}

/*
 * Say how many candidates the result kept and, when it dropped any, why.
 *
 * The two reasons answer different questions: a candidate below the relevance
 * floor scored too far under the best one to be worth reading, and a trimmed
 * one lost the cap to better candidates. A caller who wants either back passes
 * candidates, so the header has to tell them apart.
 */
function candidateCount(total: number, relevant: number, shown: number): string {
  const irrelevant = total - relevant;
  const trimmed = relevant - shown;
  if (irrelevant === 0 && trimmed === 0) return `${shown}`;
  const reasons = [
    ...(irrelevant === 0 ? [] : [`the ${irrelevant} scoring below ${RECALL_RELEVANCE_FLOOR_TEXT}`]),
    ...(trimmed === 0 ? [] : [`the ${trimmed} lowest-scoring`]),
  ];
  return `${shown} of ${total}, ${reasons.join(" and ")} trimmed`;
}

/*
 * Put the trust marker before the answer; returned candidates carry no claim mapping. The lines
 * run best score first, so the order is the ranking and the score can go out short; the header
 * names the profile once and counts the message candidates, because only their lines say so.
 */
function recallText(
  params: ProfileParams,
  result: RecallResult,
  relevant: readonly RecallCandidate[],
  shown: readonly RecallCandidate[],
  expanded: ReadonlyMap<string, string | null>,
): string {
  const answer = result.answer
    ? `Answer (answerTrust: "${SERVICE_GENERATED_UNTRUSTED}". The service does not identify which candidate IDs support the answer; verify claims against full candidate content):\n${indentToolText(result.answer)}`
    : "No answer returned.";
  const header = `Recall from ${memoryTarget(params)}:`;
  if (result.candidates.length === 0) return `${header}\n\n${answer}`;
  const records = rankByScore(shown).map((candidate) => candidateRecord(candidate, expanded));
  const count = candidateCount(result.candidates.length, relevant.length, shown.length);
  const messages = shown.filter((candidate) => candidateKind(candidate) === "message").length;
  const messageNote =
    messages === 0
      ? ""
      : `, ${messages} of them raw ingested ${messages === 1 ? "message" : "messages"} (kind: message) with the message text indented below`;
  const failed = [...expanded.values()].some((content) => content === null);
  const expansion =
    expanded.size === 0
      ? ""
      : `, full content indented under the ${expanded.size} best-scoring ${expanded.size === 1 ? "memory" : "memories"}${failed ? " (null where the read failed)" : ""}`;
  return `${header}\n\n${answer}\n\nCandidates (${count}), best score first, one JSON object per line${messageNote}${expansion}:\n${recordLines(records)}`;
}

/*
 * Render a page of memories, naming where it came from and what follows it.
 *
 * The records go out one per line, so the header is the only place left to say
 * whether another page waits. Dropping that would leave a caller unable to tell
 * a finished listing from a truncated one. The header also says the page runs
 * oldest first: the service pages by id upward and takes no order, so without
 * that word the first page of a busy profile reads as its newest memories.
 */
function listText(
  params: ProfileParams,
  memories: readonly unknown[],
  cursor: string | undefined,
): string {
  const target = memoryTarget(params);
  const cursorText = cursor === undefined ? undefined : singleLineToolText(cursor);
  if (memories.length === 0) {
    return cursorText === undefined
      ? `No memories in ${target}.`
      : `No memories on this page of ${target}; more pages behind cursor ${cursorText}.`;
  }
  const following =
    cursorText === undefined ? "last page" : `more pages behind cursor ${cursorText}`;
  const expanded = memories.filter(hasFullContent).length;
  const contentNote = expanded === 0 ? "" : `, full content indented under ${expanded} of them`;
  const header = `Memories in ${target} (${memories.length}), oldest first, ${following}, one JSON object per line${contentNote}:`;
  return `${header}\n${recordLines(memories)}`;
}

/** How much the listing showed before a cascade delete, or `undefined` when it could not be read. */
type RemovedCount = { count: number; atLeast: boolean } | undefined;

/*
 * Count the memories a cascade delete is about to remove.
 *
 * Cloudflare accepts a delete for a session that holds nothing and answers it
 * exactly like a real one, so without this the caller cannot tell a typo from a
 * successful removal. One page is enough to make that distinction, and a failed
 * read must never stop the delete the caller actually asked for. The listing
 * leaves superseded memories out while the delete removes them too, so the
 * count is of listed memories and an empty page does not prove nothing went.
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
  if (removed.atLeast) return `at least ${removed.count} listed memories`;
  return removed.count === 1 ? "1 listed memory" : `${removed.count} listed memories`;
}

/* Whether a failure could mean the addressed memory simply is not there. */
function mayMeanMissing(error: unknown): boolean {
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === "number" && (status === 404 || status >= 500);
}

/*
 * Render one failed read, including its causes, and name the missing-id
 * ambiguity when it applies. A partial result and an all-failed get keep this
 * string, so a cause left on the object never arrives. Cloudflare answers an
 * unknown id with a generic server error, and a raw ingested message id fails
 * the same way, so an id no memory could carry gets the message reading first
 * and the missing one beside it.
 */
function describeReadError(params: ProfileParams, id: string, error: unknown): string {
  const message = toolErrorMessage(error);
  if (!mayMeanMissing(error)) return message;
  if (isIngestedMessageId(id)) {
    return `${message} (no memory carries an id of this shape; memory_recall gives it to a raw ingested message, whose text is on the candidate line, which nothing reads or deletes by id, and which memory_session_delete removes with its session; an id that does not exist fails this way too)`;
  }
  return `${message} (an id that does not exist in ${memoryTarget(params)} fails this way too; confirm it with memory_list)`;
}

/*
 * Restate a missing-id failure. The message already carries the cause chain,
 * and attaching the original error would print that chain a second time.
 */
function explainMissing(params: ProfileParams, id: string, error: unknown): unknown {
  if (!mayMeanMissing(error)) return error;
  return new Error(describeReadError(params, id, error));
}

/*
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

function validMemoryId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && memoryIdPattern.test(value);
}

function validRecallQuery(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TOOL_QUERY_CHARACTERS;
}

function validRecallTimeout(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_TOOL_RECALL_VISIBILITY_TIMEOUT_SECONDS
  );
}

/* Validate the polling contract before paying for the first recall. */
function assertRecallVisibility(params: RecallVisibilityParams): void {
  if (!validMemoryId(params.memoryId)) {
    throw new Error("Recall visibility memory id is invalid");
  }
  if (!validRecallQuery(params.query)) {
    throw new Error(
      `Recall visibility query must contain 1 to ${MAX_TOOL_QUERY_CHARACTERS} characters`,
    );
  }
  if (new TextEncoder().encode(params.query).byteLength > MAX_TOOL_QUERY_CHARACTERS) {
    throw new Error(
      `Recall visibility query must not exceed ${MAX_TOOL_QUERY_CHARACTERS} UTF-8 bytes`,
    );
  }
  if (!validRecallTimeout(params.timeoutSeconds)) {
    throw new Error(
      `Recall visibility timeout must be an integer between 1 and ${MAX_TOOL_RECALL_VISIBILITY_TIMEOUT_SECONDS} seconds`,
    );
  }
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

/* Wait without leaving a timer or abort listener behind. */
function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    function onAbort(): void {
      clearTimeout(timer);
      reject(abortError(signal));
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

interface RecallVisibility {
  attempts: number;
  waitMilliseconds: number;
}

function recallVisibilitySignal(
  external: AbortSignal | undefined,
  timeout: AbortSignal,
): AbortSignal {
  return external ? AbortSignal.any([external, timeout]) : timeout;
}

function candidateIsVisible(
  result: RecallResult,
  memoryId: string,
  elapsed: number,
  timeout: number,
): boolean {
  return elapsed <= timeout && result.candidates.some((candidate) => candidate.id === memoryId);
}

function rethrowRecallFailure(
  error: unknown,
  externalSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
  startedAt: number,
  memoryId: string,
): void {
  if (externalSignal?.aborted) throw error;
  if (timeoutSignal.aborted) return;
  const elapsed = Math.round(performance.now() - startedAt);
  const message = error instanceof Error ? error.message : String(error);
  throw new Error(
    `Recall visibility check for memory ${quoteToolText(memoryId)} failed after ${elapsed} ms: ${quoteToolText(message)}.`,
    { cause: error },
  );
}

/*
 * Read one id exactly before recall is polled for it.
 *
 * A failed read comes back as a value so the caller can report it apart from a
 * recall failure. Cancellation and the deadline still throw. Without a reader
 * the caller has already read the id.
 */
async function exactReadFailure(
  get: MemoryProfile["get"],
  memoryId: string,
  signal: AbortSignal,
): Promise<{ error: unknown } | undefined> {
  if (get === undefined) return undefined;
  try {
    await get(memoryId, { signal });
    return undefined;
  } catch (error) {
    if (signal.aborted) throw error;
    return { error };
  }
}

async function pollRecall(
  recall: NonNullable<MemoryProfile["recall"]>,
  params: RecallVisibilityParams,
  signal: AbortSignal,
  clock: Readonly<{ startedAt: number; timeoutMilliseconds: number }>,
  nextAttempt: () => number,
): Promise<RecallVisibility | undefined> {
  while (true) {
    signal.throwIfAborted();
    const attempts = nextAttempt();
    const result = await recall(params.query, {
      thinkingLevel: "low",
      responseLength: "short",
      signal,
    });
    signal.throwIfAborted();
    const waitMilliseconds = Math.round(performance.now() - clock.startedAt);
    if (candidateIsVisible(result, params.memoryId, waitMilliseconds, clock.timeoutMilliseconds)) {
      return { attempts, waitMilliseconds };
    }
    const remaining = clock.timeoutMilliseconds - waitMilliseconds;
    if (remaining <= 0) return undefined;
    const backoff = Math.min(attempts * 2_000, MAX_RECALL_VISIBILITY_POLL_INTERVAL_MS);
    await delay(Math.min(backoff, remaining), signal);
  }
}

/*
 * Poll recall until one exact id comes back for the caller's query.
 *
 * A miss only says the query did not return the id, so the id is read first
 * unless the caller already read it. A read that fails ends the wait before any
 * recall is paid, and a timeout on a stored record names the query, not the
 * record, as what came up empty.
 */
async function waitForRecallCandidate(
  profile: MemoryProfile,
  params: RecallVisibilityParams,
  options: AbortOptions = {},
  stored = false,
): Promise<RecallVisibility> {
  assertRecallVisibility(params);
  const recall = requireCapability(profile, "recall");
  const get = stored ? undefined : requireCapability(profile, "get");
  const timeoutMilliseconds = params.timeoutSeconds * 1_000;
  const clock = { startedAt: performance.now(), timeoutMilliseconds };
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), timeoutMilliseconds);
  const signal = recallVisibilitySignal(options.signal, timeoutController.signal);
  let attempts = 0;
  let failure: { error: unknown } | undefined;

  try {
    failure = await exactReadFailure(get, params.memoryId, signal);
    const visibility =
      failure === undefined
        ? await pollRecall(recall, params, signal, clock, () => (attempts += 1))
        : undefined;
    if (visibility !== undefined) return visibility;
  } catch (error) {
    rethrowRecallFailure(
      error,
      options.signal,
      timeoutController.signal,
      clock.startedAt,
      params.memoryId,
    );
  } finally {
    clearTimeout(timeout);
  }

  const memory = quoteToolText(params.memoryId);
  if (failure !== undefined) {
    throw new Error(
      `Memory ${memory} could not be read by id, so recall was not polled: ${describeReadError(params, params.memoryId, failure.error)}.`,
    );
  }
  if (attempts === 0) {
    throw new Error(
      `Memory ${memory} was not read back by id within ${timeoutMilliseconds} ms, so recall was not polled.`,
    );
  }
  throw new Error(
    `Memory ${memory} is stored, but recall for this query did not return it within ${timeoutMilliseconds} ms after ${attemptsText(attempts)}. The exact read found the record, so the query does not retrieve it, a newer memory on its topic superseded it, or recall has not caught up with the write yet.`,
  );
}

async function verifyReplacement(
  profile: MemoryProfile,
  replacementMemoryId: string,
  params: Readonly<SupersedeParams | ResumeSupersessionParams>,
  options: AbortOptions,
): Promise<{ memory: Memory; visibility: RecallVisibility }> {
  if (replacementMemoryId === params.oldMemoryId) {
    throw new Error("Replacement reused the old memory id");
  }
  const memory = await requireCapability(profile, "get")(replacementMemoryId, options);
  if (memory.id !== replacementMemoryId || memory.content !== params.content) {
    throw new Error("Exact replacement read did not match the stored id and content");
  }
  const visibility = await waitForRecallCandidate(
    profile,
    {
      namespace: params.namespace,
      profile: params.profile,
      memoryId: replacementMemoryId,
      query: params.query,
      timeoutSeconds: params.timeoutSeconds,
    },
    options,
    true,
  );
  return { memory, visibility };
}

function attemptsText(attempts: number): string {
  return `${attempts} ${attempts === 1 ? "attempt" : "attempts"}`;
}

function emptyCascade(removed: RemovedCount): boolean {
  return removed?.count === 0 && !removed.atLeast;
}

export const memoryToolExecutors = {
  async remember(params: RememberParams, options: AbortOptions = {}): Promise<MemoryToolResult> {
    const profile = await getProfile(params);
    const memory = await requireCapability(profile, "remember")(
      { content: params.content, sessionId: optionalString(params.sessionId) },
      options,
    );
    return {
      content: [{ type: "text", text: json(withSummaryTrust(memory)) }],
      details: memory as unknown as Record<string, unknown>,
    };
  },

  async supersede(params: SupersedeParams, options: AbortOptions = {}): Promise<MemoryToolResult> {
    assertRecallVisibility({
      ...params,
      memoryId: params.oldMemoryId,
    });
    const profile = await getProfile(params);
    const replacement = await requireCapability(profile, "remember")(
      { content: params.content, sessionId: optionalString(params.sessionId) },
      options,
    );
    let verified: { memory: Memory; visibility: RecallVisibility };
    try {
      verified = await verifyReplacement(profile, replacement.id, params, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Stored replacement memory ${quoteToolText(replacement.id)} for old memory ${quoteToolText(params.oldMemoryId)}, but verification failed: ${quoteToolText(message)}. The old memory was not deleted; keep both ids for cleanup.`,
        { cause: error },
      );
    }
    try {
      await requireCapability(profile, "delete")(params.oldMemoryId, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Replacement memory ${quoteToolText(replacement.id)} is stored and verified, but deleting old memory ${quoteToolText(params.oldMemoryId)} failed: ${quoteToolText(message)}. The deletion outcome is unknown; keep the replacement and read the old id exactly before any cleanup.`,
        { cause: error },
      );
    }
    const details = {
      oldMemoryId: params.oldMemoryId,
      newMemory: verified.memory,
      ...verified.visibility,
    };
    return {
      content: [
        {
          type: "text",
          text: `Superseded memory ${quoteToolText(params.oldMemoryId)} with ${quoteToolText(replacement.id)} in ${memoryTarget(params)} after ${verified.visibility.waitMilliseconds} ms and ${attemptsText(verified.visibility.attempts)}.\n${json({ ...details, newMemory: withSummaryTrust(verified.memory) })}`,
        },
      ],
      details,
    };
  },

  async resumeSupersession(
    params: Readonly<ResumeSupersessionParams>,
    options: AbortOptions = {},
  ): Promise<MemoryToolResult> {
    assertRecallVisibility({ ...params, memoryId: params.oldMemoryId });
    assertRecallVisibility({ ...params, memoryId: params.replacementMemoryId });
    const profile = await getProfile(params);
    let verified: { memory: Memory; visibility: RecallVisibility };
    try {
      verified = await verifyReplacement(profile, params.replacementMemoryId, params, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Replacement memory ${quoteToolText(params.replacementMemoryId)} for old memory ${quoteToolText(params.oldMemoryId)} failed verification: ${quoteToolText(message)}. The old memory was not deleted; keep both ids for cleanup.`,
        { cause: error },
      );
    }
    try {
      await requireCapability(profile, "delete")(params.oldMemoryId, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Replacement memory ${quoteToolText(params.replacementMemoryId)} is stored and verified, but deleting old memory ${quoteToolText(params.oldMemoryId)} failed: ${quoteToolText(message)}. The deletion outcome is unknown; keep the replacement and read the old id exactly before any cleanup.`,
        { cause: error },
      );
    }
    const details = {
      oldMemoryId: params.oldMemoryId,
      newMemory: verified.memory,
      ...verified.visibility,
    };
    return {
      content: [
        {
          type: "text",
          text: `Resumed supersession of memory ${quoteToolText(params.oldMemoryId)} with replacement ${quoteToolText(params.replacementMemoryId)} in ${memoryTarget(params)} after ${verified.visibility.waitMilliseconds} ms and ${attemptsText(verified.visibility.attempts)}.\n${json({ ...details, newMemory: withSummaryTrust(verified.memory) })}`,
        },
      ],
      details,
    };
  },

  async waitForRecall(
    params: RecallVisibilityParams,
    options: AbortOptions = {},
  ): Promise<MemoryToolResult> {
    const profile = await getProfile(params);
    let visibility: RecallVisibility;
    try {
      visibility = await waitForRecallCandidate(profile, params, options);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message} No memory was changed.`, { cause: error });
    }
    const { attempts, waitMilliseconds } = visibility;
    const details = {
      id: params.memoryId,
      namespace: params.namespace,
      profile: params.profile,
      attempts,
      waitMilliseconds,
    };
    return {
      content: [
        {
          type: "text",
          text: `Memory ${quoteToolText(params.memoryId)} reached recall in ${memoryTarget(params)} after ${waitMilliseconds} ms and ${attempts} ${attempts === 1 ? "attempt" : "attempts"}.`,
        },
      ],
      details,
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
        ...(timestamp === undefined ? {} : { timestamp: messageTimestamp(timestamp) }),
      };
    });
    await requireCapability(profile, "ingest")(messages, {
      sessionId: optionalString(params.sessionId),
      ...options,
    });
    const sessionId = optionalString(params.sessionId);
    /** The service answers with no session, so the text names the one it will derive when the caller passed none. */
    const session =
      sessionId === undefined
        ? " with no session id; the service derives one from the message content, and memory_list shows it on the extracted memories as an id under the hash- prefix"
        : ` in session ${singleLineToolText(sessionId)}`;
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

  /**
   * Answer a recall query, trimming and expanding the candidates on request.
   *
   * @param params - Validated recall arguments.
   * @param options - Request cancellation.
   * @returns {Promise<MemoryToolResult>} The serialized answer and normalized result details.
   */
  async recall(params: RecallParams, options: AbortOptions = {}): Promise<MemoryToolResult> {
    assertCount(params.candidates, "Candidates");
    assertCount(params.expand, "Expand");
    const referenceDate = optionalString(params.referenceDate);
    if (referenceDate !== undefined && !hasValidCalendarDate(referenceDate)) {
      throw new Error("Recall reference date must contain a valid calendar date");
    }
    const profile = await getProfile(params);
    const result = await requireCapability(profile, "recall")(params.query, {
      thinkingLevel: params.thinkingLevel,
      responseLength: params.responseLength,
      referenceDate,
      ...options,
    });
    /* A caller who names a cap ranks the tail themselves; otherwise the near-zero tail never reaches the result. */
    const relevant =
      params.candidates === undefined ? relevantCandidates(result.candidates) : result.candidates;
    const shown = trimCandidates(relevant, keptCandidates(params, relevant));
    const expanded = await expandCandidates(profile, shown, params.expand, options);
    return {
      content: [{ type: "text", text: recallText(params, result, relevant, shown, expanded) }],
      details: {
        ...result,
        ...(result.answer ? { answerTrust: SERVICE_GENERATED_UNTRUSTED } : {}),
        candidates: shown.map((candidate) =>
          candidateKind(candidate) === "message" ? { ...candidate, kind: "message" } : candidate,
        ),
      },
    };
  },

  /**
   * List a page of memories, expanding the first entries on request.
   *
   * @param params - Validated listing and expansion arguments.
   * @param options - Request cancellation.
   * @returns {Promise<MemoryToolResult>} The serialized page and normalized pagination details.
   */
  async list(params: ListParams, options: AbortOptions = {}): Promise<MemoryToolResult> {
    assertCount(params.expand, "Expand");
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
      content: [{ type: "text", text: listText(params, memories, result.cursor) }],
      details: page,
    };
  },

  /**
   * Read every requested memory, keeping first-seen order and per-id failures.
   *
   * When every read fails the call itself fails: a result that is nothing but
   * error entries would hide the failure from clients that only check isError.
   *
   * @param params - Validated memory identifiers and profile scope.
   * @param options - Request cancellation.
   * @returns {Promise<MemoryToolResult>} The serialized records with per-id failures where applicable.
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
      if (first && entries.length === 1) throw explainMissing(params, first[0], first[1].error);
      throw new Error(
        [
          `Every read in ${memoryTarget(params)} failed:`,
          ...failed.map(
            ([id, { error }]) =>
              `${singleLineToolText(id)}: ${describeReadError(params, id, error)}`,
          ),
        ].join("\n"),
      );
    }
    const memories = entries.map(([id, reading]) =>
      "memory" in reading
        ? reading.memory
        : { id, error: describeReadError(params, id, reading.error) },
    );
    const header =
      failed.length === 0
        ? ""
        : `Read ${entries.length - failed.length} of ${entries.length} memories; error entries for: ${failed.map(([id]) => singleLineToolText(id)).join(", ")}.\n`;
    return {
      content: [{ type: "text", text: `${header}${recordLines(memories)}` }],
      details: { memories },
    };
  },

  async deleteMemory(params: MemoryParams, options: AbortOptions = {}): Promise<MemoryToolResult> {
    const profile = await getProfile(params);
    const result = await requireCapability(profile, "delete")(params.memoryId, options).catch(
      (error: unknown) => {
        throw explainMissing(params, params.memoryId, error);
      },
    );
    return {
      content: [{ type: "text", text: json(withSummaryTrust(result)) }],
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
    /** The service never narrows a summary to one session, so the header says which session it names instead. */
    const scope =
      sessionId === undefined
        ? `Summary of ${memoryTarget(params)}, whole profile, current session chosen by the service:`
        : `Summary of ${memoryTarget(params)}, whole profile, current session ${quoteToolText(sessionId)}:`;
    const trust = `Summary (summaryTrust: "${SERVICE_GENERATED_UNTRUSTED}"; supporting memory ids unavailable, verify with memory_list or memory_recall)`;
    return {
      content: [{ type: "text", text: `${scope}\n\n${trust}:\n${indentToolText(result.summary)}` }],
      details: { ...result, summaryTrust: SERVICE_GENERATED_UNTRUSTED },
    };
  },

  async deleteSession(
    params: SessionParams,
    options: AbortOptions = {},
  ): Promise<MemoryToolResult> {
    const profile = await getProfile(params);
    const removed = await countMemories(profile, options, params.sessionId);
    await requireCapability(profile, "deleteSession")(params.sessionId, options);
    const sessionId = singleLineToolText(params.sessionId);
    const text = emptyCascade(removed)
      ? `No listed memory in ${memoryTarget(params)} carried session ${sessionId}; the delete removed only superseded memories tagged with it, if there were any. Check the session id against memory_list.`
      : `Deleted session ${sessionId} in ${memoryTarget(params)}, holding ${removedText(removed)}.`;
    return {
      content: [{ type: "text", text }],
      details: {
        namespace: params.namespace,
        profile: params.profile,
        sessionId: params.sessionId,
        listedMemories: removed?.count ?? null,
        listedAtLeast: removed?.atLeast ?? null,
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
    const text = emptyCascade(removed)
      ? `Deleted profile ${memoryTarget(params)}, which held no listed memories; superseded ones, if there were any, went with it. A profile name that was never written to reports the same result.`
      : `Deleted profile ${memoryTarget(params)}, holding ${removedText(removed)}.`;
    return {
      content: [{ type: "text", text }],
      details: {
        namespace: params.namespace,
        profile: params.profile,
        listedMemories: removed?.count ?? null,
        listedAtLeast: removed?.atLeast ?? null,
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

  /**
   * List one page of the profiles a namespace holds.
   *
   * @param params - Validated namespace and pagination arguments.
   * @param options - Request cancellation.
   * @returns {Promise<MemoryToolResult>} The serialized page, naming its namespace and whether another page waits.
   */
  async listProfiles(
    params: ProfileListParams,
    options: AbortOptions = {},
  ): Promise<MemoryToolResult> {
    const result = await (
      await getNamespaceClient()
    ).listProfiles(params.namespace, {
      limit: params.limit,
      cursor: optionalString(params.cursor),
      ...options,
    });
    const page = paged({ namespace: params.namespace, ...result });
    return {
      content: [{ type: "text", text: json(page) }],
      details: page,
    };
  },

  async getNamespace(
    params: NamespaceParams,
    options: AbortOptions = {},
  ): Promise<MemoryToolResult> {
    const namespace = await (await getNamespaceClient()).get(params.namespace, options);
    return {
      content: [{ type: "text", text: json(namespace) }],
      details: namespace as unknown as Record<string, unknown>,
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
