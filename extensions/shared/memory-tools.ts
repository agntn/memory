import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  AbortOptions,
  AgentMemoryNamespaceBinding,
  CloudflareMemoryOptions,
  Memory,
  MemoryMessage,
  MemoryProfile,
  MemoryProvider,
  RecallCandidate,
  RecallResult,
  RememberInput,
} from "@agntn/memory";
import { isStampedContent } from "./memory-fields.ts";
import { isIngestedMessageId, ulidAt, ulidTime } from "./memory-ids.ts";
import {
  type MemoryRelation,
  parseRelations,
  relationsIn,
  withRelationLines,
} from "./memory-relations.ts";
import { validateMemoryScope } from "./memory-scope.ts";
import { configuredRedactionShapes, loadRedactor } from "./redaction.ts";
import { singleLineToolText, TOOL_TEXT_CONTROL_PATTERN } from "./terminal-text.ts";
import { MAX_TOOL_ERROR_CHAIN_DEPTH, toolErrorMessage } from "./tool-errors.ts";
import {
  MAX_TOOL_LIST_LIMIT,
  MEMORY_ID_PATTERN,
  ISO_INSTANT_PATTERN,
  MAX_TOOL_QUERY_CHARACTERS,
  MAX_TOOL_RECALL_VISIBILITY_TIMEOUT_SECONDS,
  SERVICE_GENERATED_UNTRUSTED,
  MAX_TOOL_EXPAND,
  MAX_TOOL_MEMORY_COPIES,
  MAX_TOOL_MEMORY_CONTENT_CHARACTERS,
  MEMORY_ID_CHARACTERS,
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
  SupersedeCopyParams,
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

const memoryIdPattern = new RegExp(MEMORY_ID_PATTERN);
const isoInstantPattern = new RegExp(ISO_INSTANT_PATTERN);
const MAX_RECALL_VISIBILITY_POLL_INTERVAL_MS = 10_000;

declare global {
  interface ImportMeta {
    /** Set by the build: a bundle has no checkout to go hunting for. */
    readonly bundled?: true;
  }
}

/**
 * Live `src/` for a checkout's `.ts` copy, the package core anywhere else.
 * @returns {Promise<MemoryModule>} The memory module, loaded once.
 */
function loadMemory(): Promise<MemoryModule> {
  if (!memoryModulePromise) {
    const sourceUrl = import.meta.bundled
      ? undefined
      : new URL("../../src/index.ts", import.meta.url);
    memoryModulePromise =
      sourceUrl && existsSync(fileURLToPath(sourceUrl))
        ? import(sourceUrl.href).then((memory) => memory as MemoryModule)
        : import("@agntn/memory").then((memory) => memory as unknown as MemoryModule);
  }
  return memoryModulePromise;
}

/**
 * Find a 401 anywhere in the cause chain. It reads fields, not the class: a checkout loads `src/` and a package loads `dist/`.
 * @param error - An executor's failure.
 * @returns {{ credentialSource?: unknown } | undefined} The 401, or nothing when the chain holds none.
 */
function refusal(error: unknown): { credentialSource?: unknown } | undefined {
  let current = error;
  for (let depth = 0; depth < MAX_TOOL_ERROR_CHAIN_DEPTH && current instanceof Error; depth += 1) {
    const refused = current as { statusCode?: unknown; credentialSource?: unknown };
    if (refused.statusCode === 401) return refused;
    current = current.cause;
  }
  return undefined;
}

/**
 * What the caller can do after a 401. The provider already gave a cf token its second try; no other source has a fresh one.
 * @param error - An executor's failure, causes included.
 * @returns {string} One sentence, or "" when the chain holds no 401.
 */
function credentialStep(error: unknown): string {
  const refused = refusal(error);
  if (refused === undefined) return "";
  if (refused.credentialSource === "cli") {
    return "cf was already asked for its token again and the one it handed over was refused too, so someone has to run cf auth login or set an account id this login can reach";
  }
  const token = refused.credentialSource === "env" ? "CLOUDFLARE_API_TOKEN" : "The same token";
  return `${token} goes out unchanged next time, so retrying will not help until someone replaces the token or fixes the account id`;
}

/**
 * Append the 401 step to a failure's text, once.
 * @param message - The failure as text, usually from `toolErrorMessage`.
 * @param error - The failure it was written from.
 * @returns {string} The text, with the step when the chain holds a 401.
 */
export function withCredentialStep(message: string, error: unknown): string {
  const step = credentialStep(error);
  if (step === "" || message.includes(step)) return message;
  return `${message}${/[.!?]$/.test(message) ? " " : ". "}${step}`;
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
  namespaceClientPromise ??= loadMemory().then((memory) => new memory.CloudflareNamespaceClient());
  return namespaceClientPromise;
}

/**
 * The app's Workers binding when it brought one, HTTP otherwise.
 * @param namespace - Namespace the call reaches.
 * @param binding - Workers binding, if any.
 * @returns {Promise<MemoryProvider>} The provider.
 */
async function getProvider(
  namespace: string,
  binding?: AgentMemoryNamespaceBinding,
): Promise<MemoryProvider> {
  if (binding !== undefined) {
    const memory = await loadMemory();
    memory.registerAll();
    return memory.create<CloudflareMemoryOptions>("cloudflare", { binding });
  }
  let providerPromise = providerPromises.get(namespace);
  if (!providerPromise) {
    providerPromise = loadMemory().then((memory) => {
      memory.registerAll();
      return memory.create<CloudflareMemoryOptions>("cloudflare", { namespace });
    });
    providerPromises.set(namespace, providerPromise);
  }
  return providerPromise;
}

async function getProfile(
  params: ProfileParams,
  binding?: AgentMemoryNamespaceBinding,
): Promise<MemoryProfile> {
  const profile = params.profile.trim();
  if (!profile) throw new Error("Profile cannot be empty");
  return (await getProvider(params.namespace, binding)).getProfile(profile);
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

/* Whether a record carries a summary the service wrote; message candidates and errors carry none. */
function hasSummary(value: unknown): boolean {
  return typeof (value as { summary?: unknown } | null)?.summary === "string";
}

/* Said once above the records, because a marker on every line read like distrust of the memory itself. */
const SUMMARY_TRUST_NOTE = `Summaries are the service's paraphrase (summaryTrust: "${SERVICE_GENERATED_UNTRUSTED}"); content is as stored.`;

const WRITTEN_CONTENT_NOTE =
  "Content that matches what this call passed is left out; memory_get reads it whole.";

/**
 * A stored record minus the content the caller passed; content the service changed stays.
 *
 * @param memory - The record the service answered with.
 * @param written - The content this call passed for it.
 * @returns {Record<string, unknown>} The record as the result text shows it.
 */
function writtenRecord(memory: Memory, written: string): Record<string, unknown> {
  if (memory.content !== written) return { ...memory };
  const { content: _content, ...rest } = memory;
  return rest;
}

/*
 * One compact JSON object per line, full content indented below its record:
 * inlined, a JSON string folds a long memory into one physical line MCP hosts
 * truncate into an ungreppable blob, and the indent keeps records alone at column zero.
 */
function recordLines(values: readonly unknown[]): string {
  const lines = values.map((value) => {
    if (!hasFullContent(value)) return JSON.stringify(value, dateAsIso);
    const { content, ...rest } = value;
    return `${JSON.stringify(rest, dateAsIso)}\n${indentToolText(content)}`;
  });
  return (values.some(hasSummary) ? [SUMMARY_TRUST_NOTE, ...lines] : lines).join("\n");
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
  const message = withCredentialStep(toolErrorMessage(error), error);
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
  contentMatches: (stored: string, content: string) => boolean,
): Promise<{ memory: Memory; visibility: RecallVisibility }> {
  if (replacementMemoryId === params.oldMemoryId) {
    throw new Error("Replacement reused the old memory id");
  }
  const memory = await requireCapability(profile, "get")(replacementMemoryId, options);
  if (memory.id !== replacementMemoryId || !contentMatches(memory.content, params.content)) {
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

/** Once the replacement exists, supersede and resume differ only in wording. */
interface SupersessionStep {
  readonly profile: MemoryProfile;
  readonly params: Readonly<SupersedeParams | ResumeSupersessionParams>;
  readonly replacementMemoryId: string;
  readonly verifyFailure: string;
  readonly done: string;
  /** Resume accepts field lines another host stamped; supersede checks the bytes it just wrote. */
  readonly contentMatches?: (stored: string, content: string) => boolean;
  /** What the replacement's own write superseded, when asked. */
  readonly superseded?: SupersessionReport;
}

async function completeSupersession(
  step: SupersessionStep,
  options: AbortOptions,
): Promise<MemoryToolResult> {
  const { profile, params, replacementMemoryId } = step;
  let verified: { memory: Memory; visibility: RecallVisibility };
  try {
    verified = await verifyReplacement(
      profile,
      replacementMemoryId,
      params,
      options,
      step.contentMatches ?? ((stored, content) => stored === content),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${step.verifyFailure}: ${quoteToolText(message)}. The old memory was not deleted; keep both ids for cleanup.`,
      { cause: error },
    );
  }
  try {
    await requireCapability(profile, "delete")(params.oldMemoryId, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Replacement memory ${quoteToolText(replacementMemoryId)} is stored and verified, but deleting old memory ${quoteToolText(params.oldMemoryId)} failed: ${quoteToolText(message)}. The deletion outcome is unknown; keep the replacement and read the old id exactly before any cleanup.`,
      { cause: error },
    );
  }
  const details = {
    oldMemoryId: params.oldMemoryId,
    newMemory: verified.memory,
    ...verified.visibility,
    ...(step.superseded === undefined ? {} : { superseded: step.superseded }),
  };
  return {
    content: [
      {
        type: "text",
        text: `${step.done} in ${memoryTarget(params)} after ${verified.visibility.waitMilliseconds} ms and ${attemptsText(verified.visibility.attempts)}. ${WRITTEN_CONTENT_NOTE}${step.superseded === undefined ? "" : SUPERSEDED_REPLACED_NOTE} ${SUMMARY_TRUST_NOTE}\n${json({ ...details, newMemory: writtenRecord(verified.memory, params.content) })}`,
      },
    ],
    details,
  };
}

/** What one reported write superseded, or why nobody knows. */
type SupersessionReport =
  | { readonly ids: readonly string[]; readonly checked: number; readonly unread?: number }
  | { readonly unchecked: string };

/** Recall's ranking before a write, or why it's missing. */
type SupersessionRanking = { readonly ranked: readonly string[] } | { readonly unchecked: string };

const SUPERSEDED_NOTE =
  " superseded.ids: checked recall candidates whose updatedAt moved to this record's createdAt. Unranked ones aren't listed.";

/** After a plain write every listed id is still there. */
const SUPERSEDED_READABLE_NOTE = `${SUPERSEDED_NOTE} memory_get still reads them.`;

/** memory_supersede deletes the old id, which the list may name. */
const SUPERSEDED_REPLACED_NOTE = `${SUPERSEDED_NOTE} memory_get still reads them, except the old id this call deleted.`;

/**
 * Content cut to the recall byte cap, on a whole character.
 *
 * @param content - Content about to be written.
 * @returns {string} Its start, as a recall query.
 */
function supersessionQuery(content: string): string {
  const { read } = new TextEncoder().encodeInto(content, new Uint8Array(MAX_TOOL_QUERY_CHARACTERS));
  return content.slice(0, read);
}

/**
 * Rank what a write may supersede. A failed recall never stops the write.
 *
 * @param profile - Profile about to be written.
 * @param call - Content and abort signal.
 * @returns {Promise<SupersessionRanking>} Memory ids, best first.
 */
async function supersessionCandidates(
  profile: MemoryProfile,
  call: Readonly<{ content: string }> & AbortOptions,
): Promise<SupersessionRanking> {
  try {
    const result = await requireCapability(profile, "recall")(supersessionQuery(call.content), {
      thinkingLevel: "low",
      responseLength: "short",
      signal: call.signal,
    });
    const ranked = rankByScore(result.candidates)
      .filter((candidate) => candidateKind(candidate) === "memory")
      .slice(0, MAX_TOOL_EXPAND)
      .map((candidate) => candidate.id);
    return { ranked };
  } catch (error) {
    return { unchecked: `recall before the write failed: ${toolErrorMessage(error)}` };
  }
}

/**
 * Whether a memory was superseded at that instant. One written in the same millisecond wasn't.
 *
 * @param memory - A record read after the write.
 * @param moved - `createdAt` of the stored record, in milliseconds.
 * @returns {boolean} `true` when its `updatedAt` moved there.
 */
function isSupersededAt(memory: Memory, moved: number): boolean {
  return memory.updatedAt.getTime() === moved && memory.createdAt.getTime() < moved;
}

/**
 * Keep the ranked ids the stored record superseded. Never throws: the record is stored.
 *
 * @param profile - Profile that was written.
 * @param call - Ranked ids, stored record and abort signal.
 * @returns {Promise<SupersessionReport>} The report for that record.
 */
async function supersededBy(
  profile: MemoryProfile,
  call: Readonly<{ ranked: readonly string[]; stored: Memory }> & AbortOptions,
): Promise<SupersessionReport> {
  const ranked = call.ranked.filter((id) => id !== call.stored.id);
  if (ranked.length === 0) return { ids: [], checked: 0 };
  try {
    const readings = [...(await readMemories(profile, ranked, { signal: call.signal }))];
    const read = readings.flatMap(([, reading]) => ("memory" in reading ? [reading.memory] : []));
    const moved = call.stored.createdAt.getTime();
    const ids = read.filter((memory) => isSupersededAt(memory, moved)).map(({ id }) => id);
    const unread = readings.length - read.length;
    return { ids, checked: read.length, ...(unread === 0 ? {} : { unread }) };
  } catch (error) {
    return { unchecked: `reading the candidates back failed: ${toolErrorMessage(error)}` };
  }
}

/**
 * Store one memory, reporting what it superseded when asked.
 *
 * @param profile - Profile to write.
 * @param call - The write, the report flag and abort signal.
 * @returns {Promise<{ memory: Memory; superseded?: SupersessionReport }>} Record and report.
 */
async function storeMemory(
  profile: MemoryProfile,
  call: Readonly<{ write: RememberInput; report: boolean }> & AbortOptions,
): Promise<{ memory: Memory; superseded?: SupersessionReport }> {
  const remember = requireCapability(profile, "remember");
  const options = { signal: call.signal };
  if (!call.report) return { memory: await remember(call.write, options) };
  const ranking = await supersessionCandidates(profile, { ...call.write, ...options });
  const memory = await remember(call.write, options);
  if ("unchecked" in ranking) return { memory, superseded: ranking };
  return {
    memory,
    superseded: await supersededBy(profile, { ...ranking, stored: memory, ...options }),
  };
}

/** What superseded one record, or why nobody knows. */
type SuccessorReport = { readonly ids: readonly string[] } | { readonly unchecked: string };

/** Ids are minted up to 30 s before createdAt, so listing starts a minute early. */
const SUCCESSOR_LEAD_MS = 60_000;

/** Listing pages one supersession instant may cost before the lookup gives up. */
const MAX_SUCCESSOR_PAGES = 5;

const SUCCESSOR_NOTE =
  "successor.ids: listed memories created the moment each record was superseded. An empty list means the successor was deleted or superseded since.";

/**
 * Whether the service moved a record's updatedAt, which only supersession does.
 *
 * @param memory - A record read by id.
 * @returns {boolean} `true` for a superseded record.
 */
function isSuperseded(memory: Memory): boolean {
  return memory.updatedAt.getTime() > memory.createdAt.getTime();
}

/**
 * List the memories created at one instant, from a cursor a minute before it.
 *
 * @param list - The profile's listing.
 * @param call - Instant in milliseconds and abort signal.
 * @returns {Promise<SuccessorReport>} Their ids, or why the pages ran out first.
 */
async function createdAt(
  list: NonNullable<MemoryProfile["list"]>,
  call: Readonly<{ moved: number }> & AbortOptions,
): Promise<SuccessorReport> {
  const ids: string[] = [];
  let cursor = ulidAt(Math.max(0, call.moved - SUCCESSOR_LEAD_MS));
  for (let page = 0; page < MAX_SUCCESSOR_PAGES; page += 1) {
    const result = await list({ limit: MAX_TOOL_LIST_LIMIT, cursor, signal: call.signal });
    for (const memory of result.memories) {
      if (memory.createdAt.getTime() === call.moved) ids.push(memory.id);
    }
    const last = result.memories.at(-1);
    if (result.cursor === undefined || last === undefined || ulidTime(last.id) > call.moved) {
      return { ids };
    }
    cursor = result.cursor;
  }
  return {
    unchecked: `more than ${MAX_SUCCESSOR_PAGES * MAX_TOOL_LIST_LIMIT} memories were written in the minute before it`,
  };
}

/**
 * Find each superseded record's successor, one listing per instant. A failed listing never throws.
 *
 * @param profile - Profile the records were read from.
 * @param memories - The records read.
 * @param options - Request cancellation.
 * @returns {Promise<Map<number, SuccessorReport>>} Reports keyed by supersession instant.
 */
async function successorsOf(
  profile: MemoryProfile,
  memories: readonly Memory[],
  options: AbortOptions,
): Promise<Map<number, SuccessorReport>> {
  const instants = new Set(
    memories.filter(isSuperseded).map((memory) => memory.updatedAt.getTime()),
  );
  const list = profile.list?.bind(profile);
  const reports = await Promise.all(
    [...instants].map(async (moved): Promise<[number, SuccessorReport]> => {
      if (list === undefined) return [moved, { unchecked: "this provider lists no memories" }];
      try {
        return [moved, await createdAt(list, { moved, signal: options.signal })];
      } catch (error) {
        return [moved, { unchecked: `listing failed: ${toolErrorMessage(error)}` }];
      }
    }),
  );
  options.signal?.throwIfAborted();
  return new Map(reports);
}

/**
 * A read record with its successor report, when one was asked for and it was superseded.
 *
 * @param memory - A record read by id.
 * @param successors - Reports by instant, absent without reportSuccessor.
 * @returns {Memory | (Memory & { successor: SuccessorReport })} The record as the result shows it.
 */
function withSuccessor(
  memory: Memory,
  successors: ReadonlyMap<number, SuccessorReport> | undefined,
): Memory | (Memory & { successor: SuccessorReport }) {
  const successor = successors?.get(memory.updatedAt.getTime());
  return successor === undefined || !isSuperseded(memory) ? memory : { ...memory, successor };
}

/** Memories whose relates: lines name one record, or why nobody knows. */
type RelationsReport =
  | {
      readonly from: readonly (Omit<MemoryRelation, "id"> & { readonly by: string })[];
      readonly checked: number;
      readonly unread?: number;
    }
  | { readonly unchecked: string };

const RELATIONS_NOTE =
  "relatedBy.from: checked recall candidates whose relates: lines name this record, as by, rel and point. Unranked ones aren't listed.";

/**
 * Rank the memories that may name one record; a failed recall only skips the report.
 *
 * @param profile - Profile the record was read from.
 * @param call - The record's id and abort signal.
 * @returns {Promise<SupersessionRanking>} Memory ids, best first.
 */
async function relationCandidates(
  profile: MemoryProfile,
  call: Readonly<{ id: string }> & AbortOptions,
): Promise<SupersessionRanking> {
  try {
    const result = await requireCapability(profile, "recall")(call.id, {
      thinkingLevel: "low",
      responseLength: "short",
      signal: call.signal,
    });
    const ranked = rankByScore(result.candidates)
      .filter((candidate) => candidate.id !== call.id && candidateKind(candidate) === "memory")
      .slice(0, MAX_TOOL_EXPAND)
      .map((candidate) => candidate.id);
    return { ranked };
  } catch (error) {
    return { unchecked: `recall for the id failed: ${toolErrorMessage(error)}` };
  }
}

/**
 * Keep the ranked memories whose relates: lines name the record.
 *
 * @param id - The record's id.
 * @param ranked - Candidate ids from recall.
 * @param readings - Every candidate read, shared across records.
 * @returns {RelationsReport} The report for that record.
 */
function relationsReport(
  id: string,
  ranked: readonly string[],
  readings: ReadonlyMap<string, MemoryReading>,
): RelationsReport {
  const read = ranked.flatMap((candidate) => {
    const reading = readings.get(candidate);
    return reading !== undefined && "memory" in reading ? [reading.memory] : [];
  });
  const from = read.flatMap((memory) =>
    relationsIn(memory.content)
      .filter((relation) => relation.id === id)
      .map(({ id: _id, ...relation }) => ({ by: memory.id, ...relation })),
  );
  const unread = ranked.length - read.length;
  return { from, checked: read.length, ...(unread === 0 ? {} : { unread }) };
}

/**
 * Find the memories that name each record, one recall per record.
 *
 * @param profile - Profile the records were read from.
 * @param memories - The records read.
 * @param options - Request cancellation.
 * @returns {Promise<Map<string, RelationsReport>>} Reports by record id.
 */
async function relationsOf(
  profile: MemoryProfile,
  memories: readonly Memory[],
  options: AbortOptions,
): Promise<Map<string, RelationsReport>> {
  const rankings = await Promise.all(
    memories.map(
      async ({ id }) => [id, await relationCandidates(profile, { id, ...options })] as const,
    ),
  );
  const ids = rankings.flatMap(([, ranking]) => ("ranked" in ranking ? ranking.ranked : []));
  let readings: ReadonlyMap<string, MemoryReading>;
  try {
    readings = await readMemories(profile, ids, options);
  } catch (error) {
    options.signal?.throwIfAborted();
    const unchecked = `reading the candidates failed: ${toolErrorMessage(error)}`;
    return new Map(rankings.map(([id]) => [id, { unchecked }]));
  }
  return new Map(
    rankings.map(([id, ranking]) => [
      id,
      "ranked" in ranking ? relationsReport(id, ranking.ranked, readings) : ranking,
    ]),
  );
}

/**
 * Read every related memory before the write, so a typo stores nothing.
 *
 * @param profile - Profile about to be written.
 * @param params - The remember call, for its profile name.
 * @param relations - Checked relations.
 * @param options - Request cancellation.
 * @throws {Error} Naming each id that couldn't be read.
 */
async function assertRelatedMemories(
  profile: MemoryProfile,
  params: Readonly<RememberParams>,
  relations: readonly MemoryRelation[],
  options: AbortOptions,
): Promise<void> {
  const readings = await readMemories(
    profile,
    relations.map(({ id }) => id),
    options,
  );
  const failed = [...readings].flatMap(([id, reading]) =>
    "error" in reading
      ? [`${quoteToolText(id)}: ${describeReadError(params, id, reading.error)}`]
      : [],
  );
  if (failed.length > 0) {
    throw new Error(
      `Nothing was written: related memories must be read in this profile first, and ${failed.join("; ")}`,
    );
  }
}

/**
 * The content a remember call stores: as sent, then one relates: line per relation.
 *
 * @param params - The remember call.
 * @returns {object} The content and the checked relations, empty without relates.
 * @throws {Error} On a bad relation or content past the cap.
 */
function relatedContent(params: Readonly<RememberParams>): {
  content: string;
  relations: MemoryRelation[];
} {
  if (params.relates === undefined) return { content: params.content, relations: [] };
  const relations = parseRelations(params.relates);
  return { content: withRelationLines(params.content, relations), relations };
}

/**
 * Run the reports a get asked for, side by side.
 *
 * @param profile - Profile the records were read from.
 * @param params - The get call and its flags.
 * @param readings - The records read.
 * @param options - Request cancellation.
 * @returns {Promise<object>} Successor and relation reports, each absent unless asked for.
 */
async function readReports(
  profile: MemoryProfile,
  params: GetParams,
  readings: ReadonlyMap<string, MemoryReading>,
  options: AbortOptions,
): Promise<{
  successors?: Map<number, SuccessorReport>;
  relations?: Map<string, RelationsReport>;
}> {
  const read = [...readings.values()].flatMap((reading) =>
    "memory" in reading ? [reading.memory] : [],
  );
  const [successors, relations] = await Promise.all([
    params.reportSuccessor === true ? successorsOf(profile, read, options) : undefined,
    params.reportRelations === true ? relationsOf(profile, read, options) : undefined,
  ]);
  return { successors, relations };
}

/**
 * A read record with the memories that name it, when they were asked for.
 *
 * @param memory - A record as the result shows it.
 * @param relations - Reports by id, absent without reportRelations.
 * @returns {object} The record, with relatedBy when there is a report.
 */
function withRelations<T extends Memory>(
  memory: T,
  relations: ReadonlyMap<string, RelationsReport> | undefined,
): T | (T & { relatedBy: RelationsReport }) {
  const relatedBy = relations?.get(memory.id);
  return relatedBy === undefined ? memory : { ...memory, relatedBy };
}

function attemptsText(attempts: number): string {
  return `${attempts} ${attempts === 1 ? "attempt" : "attempts"}`;
}

function emptyCascade(removed: RemovedCount): boolean {
  return removed?.count === 0 && !removed.atLeast;
}

/**
 * Check the copies before the first write, since the schema guards only tool callers.
 *
 * @param params - The remember call, main profile included.
 * @param copies - The extra profiles it names.
 * @throws {Error} On a bad count, a bad name, or a profile named twice.
 */
function assertCopies(params: Readonly<ProfileParams>, copies: readonly ProfileParams[]): void {
  const count = Array.isArray(copies as unknown) ? copies.length : 0;
  if (count < 1 || count > MAX_TOOL_MEMORY_COPIES) {
    throw new Error(`Copies must be a list of 1 to ${MAX_TOOL_MEMORY_COPIES} profiles`);
  }
  const targets = new Set([memoryTarget(params)]);
  for (const copy of copies) {
    const target = memoryTarget(validateMemoryScope(copy.namespace, copy.profile, "Each copy"));
    if (targets.has(target)) {
      throw new Error(`Copies name ${quoteToolText(target)} twice; each profile gets one record`);
    }
    targets.add(target);
  }
}

/**
 * The line copySource appends to every copy.
 *
 * @param source - Profile the first record landed in.
 * @param id - Id of the first record.
 * @returns {string} Text that follows the copied content.
 */
function copySourceLine(source: string, id: string): string {
  return `\n\nCopied from memory ${JSON.stringify(id)} in ${source}.`;
}

/**
 * Refuse copySource before the first write when it has nothing to annotate or no room left.
 *
 * @param params - The call that asked for copySource.
 * @throws {Error} Without copies, or past the size cap.
 */
function assertCopySource(
  params: Readonly<ProfileParams & { content: string; copies?: readonly ProfileParams[] }>,
): void {
  if (params.copies === undefined) {
    throw new Error("copySource needs copies; it annotates copies, not the main record");
  }
  const encoder = new TextEncoder();
  const line = copySourceLine(memoryTarget(params), "0".repeat(MEMORY_ID_CHARACTERS));
  const bytes = encoder.encode(params.content + line).length;
  if (bytes > MAX_TOOL_MEMORY_CONTENT_CHARACTERS) {
    throw new Error(
      `copySource adds ${encoder.encode(line).length} bytes to each copy, taking it to ${bytes} of ${MAX_TOOL_MEMORY_CONTENT_CHARACTERS} UTF-8 bytes; shorten the content or leave copySource out`,
    );
  }
}

interface StoredCopy {
  readonly target: string;
  readonly memory: Memory;
  readonly superseded?: SupersessionReport;
}

interface CopyWrite {
  readonly content: string;
  readonly sessionId?: string;
  /** The line each copy ends with, under copySource. */
  readonly sourceLine?: string;
  /** Report what each copy superseded. */
  readonly report?: boolean;
}

/**
 * One line per stored record, content only where the service changed it.
 *
 * @param stored - Every record the call wrote, main profile first.
 * @param write - Content sent to the main profile and the line copies end with, if any.
 * @returns {string} The result text.
 */
function storedCopiesText(stored: readonly StoredCopy[], write: Readonly<CopyWrite>): string {
  const copied = `${write.content}${write.sourceLine ?? ""}`;
  const records = stored.map(({ target, memory, superseded }, index) => ({
    target,
    ...writtenRecord(memory, index === 0 ? write.content : copied),
    ...(superseded === undefined ? {} : { superseded }),
  }));
  const sourceNote =
    write.sourceLine === undefined
      ? ""
      : ` Each copy ends with a blank line and ${write.sourceLine.trim()}`;
  const supersededNote = write.report === true ? SUPERSEDED_READABLE_NOTE : "";
  return `Stored the same memory in ${stored.length} profiles.${sourceNote} ${WRITTEN_CONTENT_NOTE}${supersededNote}\n${recordLines(records)}`;
}

/**
 * Name what landed and what did not, so a retry goes only to the missing profiles.
 *
 * @param stored - Records written before or beside the failed copies.
 * @param failed - Each failed copy with its reason.
 * @param sourceLine - The line copies end with, if any.
 * @returns {Error} One error for the whole call.
 */
function failedCopiesError(
  stored: readonly StoredCopy[],
  failed: readonly { readonly target: string; readonly reason: unknown }[],
  sourceLine?: string,
): Error {
  const storedText = stored
    .map(
      ({ target, memory, superseded }) =>
        `${target} ${quoteToolText(memory.id)}${superseded === undefined ? "" : ` (superseded ${JSON.stringify(superseded)})`}`,
    )
    .join(", ");
  const failedText = failed
    .map(
      ({ target, reason }) => `${target}: ${withCredentialStep(toolErrorMessage(reason), reason)}`,
    )
    .join("; ");
  return new Error(
    `Stored memory in ${storedText}, but ${failed.length} of ${stored.length + failed.length - 1} copies failed. ${failedText}. Check memory_list in each failed profile before retrying, since a failed write may have landed anyway, and retry only the profiles that lack the memory, each as its own memory_remember without copies. Repeating this call would store the main record again.${sourceLine === undefined ? "" : ` Give a retried copy content that ends with ${JSON.stringify(sourceLine)}, as the stored ones do.`}`,
  );
}

/**
 * Write the same memory into every copy at once, after the main record is stored.
 *
 * @param main - The record already in the main profile.
 * @param copies - Profiles that get the same content.
 * @param write - Content and session of the main record, and the source line for copySource.
 * @param options - Abort signal shared by every write.
 * @param binding - Workers binding the copies go through, if any.
 * @returns {Promise<MemoryToolResult>} One line per record, or an error naming the gaps.
 */
async function rememberCopies(
  main: StoredCopy,
  copies: readonly ProfileParams[],
  write: CopyWrite,
  options: AbortOptions,
  binding?: AgentMemoryNamespaceBinding,
): Promise<MemoryToolResult> {
  const copy = {
    content: `${write.content}${write.sourceLine ?? ""}`,
    sessionId: write.sessionId,
  };
  const settled = await Promise.allSettled(
    copies.map(async (scope) =>
      storeMemory(await getProfile(scope, binding), {
        write: copy,
        report: write.report === true,
        ...options,
      }),
    ),
  );
  const stored: StoredCopy[] = [main];
  const failed: { target: string; reason: unknown }[] = [];
  settled.forEach((outcome, index) => {
    const target = memoryTarget(copies[index] as ProfileParams);
    if (outcome.status === "fulfilled") stored.push({ target, ...outcome.value });
    else failed.push({ target, reason: outcome.reason });
  });
  if (failed.length > 0) throw failedCopiesError(stored, failed, write.sourceLine);
  return {
    content: [{ type: "text", text: storedCopiesText(stored, write) }],
    details: {
      records: stored.map(({ target, memory, superseded }) => ({
        target,
        ...memory,
        ...(superseded === undefined ? {} : { superseded }),
      })),
    },
  };
}

/** An old copy found before any write, and where it lives. */
interface OldCopy {
  readonly scope: Readonly<ProfileParams>;
  readonly profile: MemoryProfile;
  readonly oldMemoryId: string;
}

/**
 * Read a named copy id, so a typo stops the call before any write.
 *
 * @param copy - The copy and its id.
 * @param options - Request cancellation.
 * @param binding - Workers binding, if any.
 * @returns {Promise<OldCopy>} The copy, ready to replace.
 * @throws {Error} When the id can't be read.
 */
async function namedOldCopy(
  copy: Readonly<SupersedeCopyParams> & { readonly oldMemoryId: string },
  options: AbortOptions,
  binding?: AgentMemoryNamespaceBinding,
): Promise<OldCopy> {
  const profile = await getProfile(copy, binding);
  try {
    await requireCapability(profile, "get")(copy.oldMemoryId, options);
  } catch (error) {
    throw new Error(
      `Old copy ${quoteToolText(copy.oldMemoryId)} could not be read: ${describeReadError(copy, copy.oldMemoryId, error)}`,
      { cause: error },
    );
  }
  return { scope: copy, profile, oldMemoryId: copy.oldMemoryId };
}

/**
 * Ids of the ranked memories that end with the old record's copy line.
 *
 * @param profile - The copy's profile.
 * @param call - Recall query, the line to match and abort signal.
 * @returns {Promise<{ ids: string[]; checked: number; unread: number }>} Matches and read counts.
 */
async function copiesEndingWith(
  profile: MemoryProfile,
  call: Readonly<{ query: string; line: string }> & AbortOptions,
): Promise<{ ids: string[]; checked: number; unread: number }> {
  const options = { signal: call.signal };
  const result = await requireCapability(profile, "recall")(call.query, {
    thinkingLevel: "low",
    responseLength: "short",
    ...options,
  });
  const ranked = rankByScore(result.candidates)
    .filter((candidate) => candidateKind(candidate) === "memory")
    .slice(0, MAX_TOOL_EXPAND)
    .map(({ id }) => id);
  const readings = [...(await readMemories(profile, ranked, options)).values()];
  const ids = readings.flatMap((reading) =>
    "memory" in reading && reading.memory.content.endsWith(call.line) ? [reading.memory.id] : [],
  );
  const unread = readings.filter((reading) => !("memory" in reading)).length;
  return { ids, checked: readings.length, unread };
}

/**
 * Find a copy by its Copied from memory line, through one recall.
 *
 * @param copy - Where the copy lives.
 * @param old - The old main record and its profile.
 * @param options - Request cancellation.
 * @param binding - Workers binding, if any.
 * @returns {Promise<OldCopy>} The one copy carrying that line.
 * @throws {Error} When no memory or more than one carries it.
 */
async function sourcedOldCopy(
  copy: Readonly<ProfileParams>,
  old: Readonly<{ memory: Memory; target: string }>,
  options: AbortOptions,
  binding?: AgentMemoryNamespaceBinding,
): Promise<OldCopy> {
  const target = memoryTarget(copy);
  const line = copySourceLine(old.target, old.memory.id);
  const profile = await getProfile(copy, binding);
  let found: { ids: string[]; checked: number; unread: number };
  try {
    found = await copiesEndingWith(profile, {
      query: supersessionQuery(old.memory.content),
      line,
      ...options,
    });
  } catch (error) {
    throw new Error(`Looking for the copy in ${target} failed: ${toolErrorMessage(error)}`, {
      cause: error,
    });
  }
  const [oldMemoryId, ...others] = found.ids;
  if (others.length === 0 && found.unread > 0) {
    throw new Error(
      `${found.unread} of the ${found.checked} memories recall ranked couldn't be read, so another copy may end with that line; pass that copy's oldMemoryId`,
    );
  }
  if (oldMemoryId !== undefined && others.length === 0)
    return { scope: copy, profile, oldMemoryId };
  const where = `${target} ending with ${JSON.stringify(line.trim())}`;
  throw new Error(
    oldMemoryId === undefined
      ? `Found no memory in ${where} among the ${found.checked} that recall ranked; pass that copy's oldMemoryId`
      : `Found ${found.ids.length} memories in ${where}: ${found.ids.map((id) => quoteToolText(id)).join(", ")}; pass the one to replace as oldMemoryId`,
  );
}

/**
 * Read the old main record before any write, since its delete would fail after them.
 *
 * @param params - The supersede call.
 * @param options - Request cancellation.
 * @param binding - Workers binding, if any.
 * @returns {Promise<Memory>} The old record.
 * @throws {Error} When it can't be read. Nothing is written by then.
 */
async function readOldMemory(
  params: Readonly<SupersedeParams>,
  options: AbortOptions,
  binding?: AgentMemoryNamespaceBinding,
): Promise<Memory> {
  const profile = await getProfile(params, binding);
  try {
    return await requireCapability(profile, "get")(params.oldMemoryId, options);
  } catch (error) {
    throw new Error(
      `Nothing was written: old memory ${quoteToolText(params.oldMemoryId)} could not be read: ${describeReadError(params, params.oldMemoryId, error)}`,
      { cause: error },
    );
  }
}

/**
 * Find every old copy before the first write, so a missing one changes nothing.
 *
 * @param params - The supersede call with its copies.
 * @param copies - The copies it names.
 * @param options - Request cancellation.
 * @param binding - Workers binding, if any.
 * @returns {Promise<OldCopy[]>} Each copy with the id to delete.
 * @throws {Error} When a copy isn't found, before any write.
 */
async function findOldCopies(
  params: Readonly<SupersedeParams>,
  copies: readonly Readonly<SupersedeCopyParams>[],
  options: AbortOptions,
  binding?: AgentMemoryNamespaceBinding,
): Promise<OldCopy[]> {
  const old = {
    memory: await readOldMemory(params, options, binding),
    target: memoryTarget(params),
  };
  const settled = await Promise.allSettled(
    copies.map(async (copy) => {
      const { oldMemoryId } = copy;
      if (oldMemoryId !== undefined)
        return namedOldCopy({ ...copy, oldMemoryId }, options, binding);
      return sourcedOldCopy(copy, old, options, binding);
    }),
  );
  options.signal?.throwIfAborted();
  const failed = settled.flatMap((outcome, index) =>
    outcome.status === "rejected"
      ? [`${memoryTarget(copies[index] as ProfileParams)}: ${toolErrorMessage(outcome.reason)}`]
      : [],
  );
  if (failed.length > 0) {
    throw new Error(
      `Nothing was written: ${failed.length} of ${copies.length} old copies weren't found. ${failed.join("; ")}`,
    );
  }
  return settled.flatMap((outcome) => (outcome.status === "fulfilled" ? [outcome.value] : []));
}

/** One finished supersession, as the result lists it. */
interface ReplacedRecord {
  readonly target: string;
  readonly written: string;
  readonly details: Readonly<Record<string, unknown>>;
}

/**
 * One result line, content only where the service changed it.
 *
 * @param record - The step's target, written content and details.
 * @returns {Record<string, unknown>} The line's fields.
 */
function replacedLine(record: Readonly<ReplacedRecord>): Record<string, unknown> {
  const { newMemory, ...rest } = record.details as { newMemory: Memory };
  return { target: record.target, ...rest, ...writtenRecord(newMemory, record.written) };
}

/**
 * Replace one old copy the way the main record was replaced.
 *
 * @param copy - The old copy found before any write.
 * @param call - The supersede call, the copy content and the report flag.
 * @param options - Request cancellation.
 * @returns {Promise<ReplacedRecord>} The finished step.
 */
async function supersedeCopy(
  copy: Readonly<OldCopy>,
  call: Readonly<{ params: SupersedeParams; content: string }>,
  options: AbortOptions,
): Promise<ReplacedRecord> {
  const { params, content } = call;
  const scoped = { ...params, ...copy.scope, oldMemoryId: copy.oldMemoryId, content };
  const { memory, superseded } = await storeMemory(copy.profile, {
    write: { content, sessionId: optionalString(params.sessionId) },
    report: params.reportSuperseded === true,
    ...options,
  });
  const done = await completeSupersession(
    {
      profile: copy.profile,
      params: scoped,
      superseded,
      replacementMemoryId: memory.id,
      verifyFailure: `Stored replacement copy ${quoteToolText(memory.id)} for old copy ${quoteToolText(copy.oldMemoryId)}, but verification failed`,
      done: "",
    },
    options,
  );
  return { target: memoryTarget(copy.scope), written: content, details: done.details };
}

/**
 * Replace the old copies after the main record, naming every gap.
 *
 * @param main - The finished main step and the call.
 * @param copies - The old copies found before the first write.
 * @param options - Request cancellation.
 * @returns {Promise<MemoryToolResult>} One line per replaced record, main first.
 * @throws {Error} Naming what was replaced and how to finish each failed copy.
 */
async function supersedeCopies(
  main: Readonly<{ params: SupersedeParams; record: ReplacedRecord; sourceLine?: string }>,
  copies: readonly Readonly<OldCopy>[],
  options: AbortOptions,
): Promise<MemoryToolResult> {
  const content = `${main.params.content}${main.sourceLine ?? ""}`;
  const settled = await Promise.allSettled(
    copies.map((copy) => supersedeCopy(copy, { params: main.params, content }, options)),
  );
  const replaced = [main.record];
  const failed: string[] = [];
  settled.forEach((outcome, index) => {
    if (outcome.status === "fulfilled") replaced.push(outcome.value);
    else
      failed.push(
        `${memoryTarget((copies[index] as OldCopy).scope)} ${quoteToolText((copies[index] as OldCopy).oldMemoryId)}: ${withCredentialStep(toolErrorMessage(outcome.reason), outcome.reason)}`,
      );
  });
  const lines = replaced.map((record) => replacedLine(record));
  if (failed.length > 0) {
    const done = lines.map(({ target, oldMemoryId, id }) =>
      [target, quoteToolText(String(oldMemoryId)), "->", quoteToolText(String(id))].join(" "),
    );
    throw new Error(
      `Replaced the memory in ${done.join(", ")}, but ${failed.length} of ${copies.length} copies failed. ${failed.join("; ")}. Finish each failed copy on its own: memory_supersession_resume with the ids its failure names when the replacement copy is stored, memory_supersede without copies when it isn't. Repeating this call would replace the main record again.${main.sourceLine === undefined ? "" : ` Resume a copy with content that ends with ${JSON.stringify(main.sourceLine)}, as the stored ones do.`}`,
    );
  }
  const sourceNote =
    main.sourceLine === undefined
      ? ""
      : ` Each copy ends with a blank line and ${main.sourceLine.trim()}`;
  const report = main.params.reportSuperseded === true ? SUPERSEDED_REPLACED_NOTE : "";
  return {
    content: [
      {
        type: "text",
        text: `Superseded the memory in ${replaced.length} profiles: each new record was read back and found by recall before its old id was deleted.${sourceNote} ${WRITTEN_CONTENT_NOTE}${report}\n${recordLines(lines)}`,
      },
    ],
    details: { records: lines },
  };
}

/**
 * Check a supersede call's copies before any read or write.
 *
 * @param params - The supersede call.
 * @throws {Error} On a bad copy list, a malformed copy id, or a copy line past the cap.
 */
function assertSupersedeCopies(params: Readonly<SupersedeParams>): void {
  if (params.copies !== undefined) {
    assertCopies(params, params.copies);
    if (
      params.copies.some(
        ({ oldMemoryId }) => oldMemoryId !== undefined && !validMemoryId(oldMemoryId),
      )
    ) {
      throw new Error("Old copy memory id is invalid");
    }
  }
  if (params.copySource === true) assertCopySource(params);
}

/**
 * The messages as they go upstream: modelled fields only, secrets struck.
 *
 * @param messages - Validated ingest messages.
 * @returns {Promise<object>} The messages and the matches per shape.
 */
async function redactedMessages(
  messages: readonly Readonly<IngestParams["messages"][number]>[],
): Promise<{ messages: MemoryMessage[]; counts: Record<string, number> }> {
  const redact = await loadRedactor(configuredRedactionShapes());
  const counts: Record<string, number> = {};
  const copied = messages.map((message) => {
    const timestamp = optionalString(message.timestamp);
    const redacted = redact(message.content);
    for (const [name, count] of Object.entries(redacted.counts)) {
      counts[name] = (counts[name] ?? 0) + count;
    }
    return {
      role: message.role,
      content: redacted.text,
      ...(timestamp === undefined ? {} : { timestamp: messageTimestamp(timestamp) }),
    };
  });
  return { messages: copied, counts };
}

/**
 * What the ingest struck before sending.
 *
 * @param counts - Matches per shape.
 * @returns {string} One sentence, or nothing when nothing matched.
 */
function redactionNote(counts: Readonly<Record<string, number>>): string {
  const entries = Object.entries(counts);
  if (entries.length === 0) return "";
  const list = entries.map(([name, count]) => `${name}=${count}`).join(", ");
  return ` Secrets were replaced with [redacted:<shape>] before sending: ${list}.`;
}

export const memoryToolExecutors = {
  async remember(
    params: RememberParams,
    options: AbortOptions = {},
    binding?: AgentMemoryNamespaceBinding,
  ): Promise<MemoryToolResult> {
    if (params.copies !== undefined) assertCopies(params, params.copies);
    const { content, relations } = relatedContent(params);
    if (params.copySource === true) assertCopySource({ ...params, content });
    const profile = await getProfile(params, binding);
    if (relations.length > 0) await assertRelatedMemories(profile, params, relations, options);
    const write = { content, sessionId: optionalString(params.sessionId) };
    const report = params.reportSuperseded === true;
    const { memory, superseded } = await storeMemory(profile, { write, report, ...options });
    if (params.copies !== undefined) {
      const target = memoryTarget(params);
      return rememberCopies(
        { target, memory, superseded },
        params.copies,
        params.copySource === true
          ? { ...write, report, sourceLine: copySourceLine(target, memory.id) }
          : { ...write, report },
        options,
        binding,
      );
    }
    const reported = superseded === undefined ? {} : { superseded };
    const record = recordLines([{ ...writtenRecord(memory, write.content), ...reported }]);
    return {
      content: [
        {
          type: "text",
          text: `Stored memory in ${memoryTarget(params)}. ${WRITTEN_CONTENT_NOTE}${report ? SUPERSEDED_READABLE_NOTE : ""}\n${record}`,
        },
      ],
      details: { ...memory, ...reported },
    };
  },

  async supersede(
    params: SupersedeParams,
    options: AbortOptions = {},
    binding?: AgentMemoryNamespaceBinding,
  ): Promise<MemoryToolResult> {
    assertRecallVisibility({
      ...params,
      memoryId: params.oldMemoryId,
    });
    assertSupersedeCopies(params);
    const copies =
      params.copies === undefined
        ? undefined
        : await findOldCopies(params, params.copies, options, binding);
    const profile = await getProfile(params, binding);
    const { memory: replacement, superseded } = await storeMemory(profile, {
      write: { content: params.content, sessionId: optionalString(params.sessionId) },
      report: params.reportSuperseded === true,
      ...options,
    });
    const untouched = copies === undefined ? "" : " No copy was touched.";
    let done: MemoryToolResult;
    try {
      done = await completeSupersession(
        {
          profile,
          params,
          superseded,
          replacementMemoryId: replacement.id,
          verifyFailure: `Stored replacement memory ${quoteToolText(replacement.id)} for old memory ${quoteToolText(params.oldMemoryId)}, but verification failed`,
          done: `Superseded memory ${quoteToolText(params.oldMemoryId)} with ${quoteToolText(replacement.id)}`,
        },
        options,
      );
    } catch (error) {
      if (untouched === "" || !(error instanceof Error)) throw error;
      throw new Error(`${error.message}${untouched}`, { cause: error.cause });
    }
    if (copies === undefined) return done;
    const target = memoryTarget(params);
    return supersedeCopies(
      {
        params,
        record: { target, written: params.content, details: done.details },
        ...(params.copySource === true
          ? { sourceLine: copySourceLine(target, replacement.id) }
          : {}),
      },
      copies,
      options,
    );
  },

  async resumeSupersession(
    params: Readonly<ResumeSupersessionParams>,
    options: AbortOptions = {},
    binding?: AgentMemoryNamespaceBinding,
  ): Promise<MemoryToolResult> {
    assertRecallVisibility({ ...params, memoryId: params.oldMemoryId });
    assertRecallVisibility({ ...params, memoryId: params.replacementMemoryId });
    return completeSupersession(
      {
        profile: await getProfile(params, binding),
        params,
        replacementMemoryId: params.replacementMemoryId,
        verifyFailure: `Replacement memory ${quoteToolText(params.replacementMemoryId)} for old memory ${quoteToolText(params.oldMemoryId)} failed verification`,
        done: `Resumed supersession of memory ${quoteToolText(params.oldMemoryId)} with replacement ${quoteToolText(params.replacementMemoryId)}`,
        contentMatches: isStampedContent,
      },
      options,
    );
  },

  async waitForRecall(
    params: RecallVisibilityParams,
    options: AbortOptions = {},
    binding?: AgentMemoryNamespaceBinding,
  ): Promise<MemoryToolResult> {
    const profile = await getProfile(params, binding);
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
          text: `Memory ${quoteToolText(params.memoryId)} reached recall in ${memoryTarget(params)} after ${waitMilliseconds} ms and ${attemptsText(attempts)}.`,
        },
      ],
      details,
    };
  },

  async ingest(
    params: IngestParams,
    options: AbortOptions = {},
    binding?: AgentMemoryNamespaceBinding,
  ): Promise<MemoryToolResult> {
    const profile = await getProfile(params, binding);
    const { messages, counts } = await redactedMessages(params.messages);
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
          text: `Submitted ${messages.length} messages for ingestion into ${memoryTarget(params)}${session}.${redactionNote(counts)} Extraction runs asynchronously: memories appear in memory_list and memory_recall once it finishes, and the service decides how many memories the messages produce.`,
        },
      ],
      details: {
        namespace: params.namespace,
        profile: params.profile,
        messageCount: messages.length,
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(Object.keys(counts).length === 0 ? {} : { redactions: counts }),
      },
    };
  },

  /**
   * Answer a recall query, trimming and expanding the candidates on request.
   *
   * @param params - Validated recall arguments.
   * @param options - Request cancellation.
   * @param binding - Workers binding the call goes through, if any.
   * @returns {Promise<MemoryToolResult>} The serialized answer and normalized result details.
   */
  async recall(
    params: RecallParams,
    options: AbortOptions = {},
    binding?: AgentMemoryNamespaceBinding,
  ): Promise<MemoryToolResult> {
    assertCount(params.candidates, "Candidates");
    assertCount(params.expand, "Expand");
    const referenceDate = optionalString(params.referenceDate);
    if (referenceDate !== undefined && !hasValidCalendarDate(referenceDate)) {
      throw new Error("Recall reference date must contain a valid calendar date");
    }
    const profile = await getProfile(params, binding);
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
   * @param binding - Workers binding the call goes through, if any.
   * @returns {Promise<MemoryToolResult>} The serialized page and normalized pagination details.
   */
  async list(
    params: ListParams,
    options: AbortOptions = {},
    binding?: AgentMemoryNamespaceBinding,
  ): Promise<MemoryToolResult> {
    assertCount(params.expand, "Expand");
    const profile = await getProfile(params, binding);
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
   * @param binding - Workers binding the call goes through, if any.
   * @returns {Promise<MemoryToolResult>} The serialized records with per-id failures where applicable.
   */
  async get(
    params: GetParams,
    options: AbortOptions = {},
    binding?: AgentMemoryNamespaceBinding,
  ): Promise<MemoryToolResult> {
    assertMemoryIds(params.memoryIds);
    const profile = await getProfile(params, binding);
    const readings = await readMemories(profile, params.memoryIds, options);
    const { successors, relations } = await readReports(profile, params, readings, options);
    const entries = [...readings.entries()];
    const failed = entries.filter(
      (entry): entry is [string, { error: unknown }] => "error" in entry[1],
    );
    if (failed.length === entries.length) {
      const first = failed[0];
      /** A single-id total failure keeps memory_delete's flat error shape instead of a one-entry listing. */
      if (first && entries.length === 1) throw explainMissing(params, first[0], first[1].error);
      const reasons = failed.map(
        ([id, { error }]) => `${quoteToolText(id)}: ${describeReadError(params, id, error)}`,
      );
      /** Every surface flattens a newline to a space, so entries get a separator that survives it. */
      throw new Error(`Every read in ${memoryTarget(params)} failed: ${reasons.join("; ")}`);
    }
    const memories = entries.map(([id, reading]) =>
      "memory" in reading
        ? withRelations(withSuccessor(reading.memory, successors), relations)
        : { id, error: describeReadError(params, id, reading.error) },
    );
    const failures =
      failed.length === 0
        ? ""
        : `Read ${entries.length - failed.length} of ${entries.length} memories; error entries for: ${failed.map(([id]) => singleLineToolText(id)).join(", ")}.\n`;
    const notes = [
      ...(memories.some((memory) => "successor" in memory) ? [SUCCESSOR_NOTE] : []),
      ...(relations === undefined ? [] : [RELATIONS_NOTE]),
    ];
    const header = `${failures}${notes.map((note) => `${note}\n`).join("")}`;
    return {
      content: [{ type: "text", text: `${header}${recordLines(memories)}` }],
      details: { memories },
    };
  },

  async deleteMemory(
    params: MemoryParams,
    options: AbortOptions = {},
    binding?: AgentMemoryNamespaceBinding,
  ): Promise<MemoryToolResult> {
    const profile = await getProfile(params, binding);
    const result = await requireCapability(profile, "delete")(params.memoryId, options).catch(
      (error: unknown) => {
        throw explainMissing(params, params.memoryId, error);
      },
    );
    return {
      content: [{ type: "text", text: recordLines([result]) }],
      details: result as unknown as Record<string, unknown>,
    };
  },

  async summary(
    params: SummaryParams,
    options: AbortOptions = {},
    binding?: AgentMemoryNamespaceBinding,
  ): Promise<MemoryToolResult> {
    const profile = await getProfile(params, binding);
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
    binding?: AgentMemoryNamespaceBinding,
  ): Promise<MemoryToolResult> {
    const profile = await getProfile(params, binding);
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
    binding?: AgentMemoryNamespaceBinding,
  ): Promise<MemoryToolResult> {
    const provider = await getProvider(params.namespace, binding);
    if (!provider.deleteProfile) {
      throw new Error("Memory provider does not support deleteProfile");
    }
    const removed = await countMemories(await getProfile(params, binding), options);
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
