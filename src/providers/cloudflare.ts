import {
  MemoryAuthError,
  MemoryHttpError,
  MemoryInputError,
  MemoryNotFoundError,
  MemoryRateLimitError,
  MemoryServerError,
  MemoryNetworkError,
  normalizeMemoryError,
} from "../errors.ts";
import { MemoryProfile, MemoryProvider } from "../memory.ts";
import { isUnknownRecord } from "../type-guards.ts";
import type {
  AbortOptions,
  IngestOptions,
  ListOptions,
  ListResult,
  Memory,
  MemoryCapabilities,
  MemoryListEntry,
  MemoryMessage,
  MemoryType,
  RecallCandidate,
  RecallOptions,
  RecallResult,
  RememberInput,
  SummaryOptions,
  SummaryResult,
} from "../types.ts";

/** Options as a binding sees them, with the adapter's cancellation removed. */
type BindingOptions<T extends AbortOptions> = Omit<T, "signal">;

/**
 * The Workers binding as Cloudflare exposes it.
 *
 * None of these calls take a signal, so the adapter strips cancellation before
 * delegating and decides on its own whether the call starts.
 */
export interface AgentMemoryProfileBinding {
  ingest(
    messages: Iterable<Readonly<MemoryMessage>>,
    options?: BindingOptions<IngestOptions>,
  ): Promise<void>;
  remember(memory: RememberInput): Promise<Memory>;
  recall(query: string, options?: BindingOptions<Readonly<RecallOptions>>): Promise<RecallResult>;
  list(options?: BindingOptions<ListOptions>): Promise<ListResult>;
  get(memoryId: string): Promise<Memory>;
  delete(memoryId: string): Promise<Memory>;
  deleteSession(sessionId: string): Promise<void>;
  getSummary(options?: BindingOptions<SummaryOptions>): Promise<SummaryResult>;
}

export interface AgentMemoryNamespaceBinding {
  getProfile(profileName: string): Promise<AgentMemoryProfileBinding>;
  deleteProfile(profileName: string): Promise<void>;
}

export interface CloudflareMemoryProfile extends MemoryProfile {
  ingest(messages: Iterable<Readonly<MemoryMessage>>, options?: IngestOptions): Promise<void>;
  remember(memory: RememberInput, options?: AbortOptions): Promise<Memory>;
  recall(query: string, options?: RecallOptions): Promise<RecallResult>;
  list(options?: ListOptions): Promise<ListResult>;
  get(memoryId: string, options?: AbortOptions): Promise<Memory>;
  delete(memoryId: string, options?: AbortOptions): Promise<Memory>;
  deleteSession(sessionId: string, options?: AbortOptions): Promise<void>;
  getSummary(options?: SummaryOptions): Promise<SummaryResult>;
}

export interface CloudflareBindingOptions {
  binding: AgentMemoryNamespaceBinding;
}

export interface CloudflareAccountOptions {
  accountId: string;
  apiToken: string;
  fetch?: typeof globalThis.fetch;
}

export interface CloudflareHttpOptions extends CloudflareAccountOptions {
  namespace: string;
}

export interface CloudflareNamespace {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CloudflareNamespaceListOptions extends AbortOptions {
  limit?: number;
  cursor?: string;
  order?: "id" | "name";
  direction?: "asc" | "desc";
}

export interface CloudflareNamespaceListResult {
  namespaces: CloudflareNamespace[];
  cursor?: string;
}

/** One profile of a namespace, as the profile listing reports it. */
export interface CloudflareProfile {
  name: string;
  /** When the profile was first recorded in the namespace index. */
  createdAt: Date;
}

export interface CloudflareProfileListOptions extends AbortOptions {
  limit?: number;
  cursor?: string;
}

export interface CloudflareProfileListResult {
  profiles: CloudflareProfile[];
  cursor?: string;
}

export type CloudflareMemoryOptions = CloudflareBindingOptions | CloudflareHttpOptions;

const CLOUDFLARE_API_URL = "https://api.cloudflare.com/client/v4";
const MAX_INGEST_MESSAGES = 500;
const MAX_MESSAGE_BYTES = 32_768;
/** Measured live on 2026-09-18: `remember` answers 32,769 bytes with 400 "content must not exceed 32768 bytes". The limits page names only the message cap. */
const MAX_MEMORY_CONTENT_BYTES = 32_768;
const MAX_QUERY_BYTES = 1_024;
const MAX_SESSION_ID_CHARACTERS = 64;
const MAX_PROFILE_NAME_CHARACTERS = 100;
const MAX_NAMESPACE_NAME_CHARACTERS = 32;
const NAMESPACE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const MAX_BINDING_LIST_LIMIT = 500;
/** The memories endpoint answers `per_page=501` with 400 "per_page must be at most 500". */
const MAX_HTTP_LIST_LIMIT = 500;
/** The namespaces endpoint takes twice that, and answers 1001 with 400. The two caps are separate. */
const MAX_NAMESPACE_LIST_LIMIT = 1000;
/** The profiles endpoint shares the memories cap and answers 501 with the same 400. */
const MAX_PROFILE_LIST_LIMIT = 500;
/** A read gets three tries, 250 ms and then 500 ms apart, before its failure reaches the caller. */
const READ_ATTEMPTS = 3;
const READ_RETRY_DELAY_MS = 250;
const READ_RETRY_STATUSES: readonly number[] = [500, 502, 503, 504];
/** An unknown memory id answers 500, so a read by id retries only the gateway codes. */
const READ_BY_ID_RETRY_STATUSES: readonly number[] = [502, 503, 504];

/** Input limits this provider enforces, so tool schemas can publish the same bounds. */
export const cloudflareMemoryLimits = Object.freeze({
  ingestMessages: MAX_INGEST_MESSAGES,
  messageBytes: MAX_MESSAGE_BYTES,
  /** Size of one remembered memory, which the service caps like one ingested message. */
  memoryContentBytes: MAX_MEMORY_CONTENT_BYTES,
  queryBytes: MAX_QUERY_BYTES,
  sessionIdCharacters: MAX_SESSION_ID_CHARACTERS,
  profileNameCharacters: MAX_PROFILE_NAME_CHARACTERS,
  namespaceNameCharacters: MAX_NAMESPACE_NAME_CHARACTERS,
  /** Namespaces and profiles share one charset rule. */
  namePattern: NAMESPACE_NAME_PATTERN.source,
  /** Page size for a listing of memories. */
  httpListLimit: MAX_HTTP_LIST_LIMIT,
  /** Page size for a listing of namespaces, which the service caps higher. */
  namespaceListLimit: MAX_NAMESPACE_LIST_LIMIT,
  /** Page size for a listing of profiles. */
  profileListLimit: MAX_PROFILE_LIST_LIMIT,
});

const bindingCapabilities: Readonly<MemoryCapabilities> = Object.freeze({
  ingest: true,
  remember: true,
  recall: true,
  list: true,
  get: true,
  delete: true,
  deleteSession: true,
  summary: true,
  deleteProfile: true,
  listProfiles: false,
});

/** The HTTP API lists the profiles of a namespace; the Workers binding has no such call. */
const httpCapabilities: Readonly<MemoryCapabilities> = Object.freeze({
  ...bindingCapabilities,
  listProfiles: true,
});

/*
 * Drop cancellation from the options a call forwards.
 *
 * A binding gets the rest as its own options, and an HTTP body gets them as
 * JSON. Neither may carry an `AbortSignal`: the binding has no use for one and
 * `JSON.stringify` would post it upstream as an empty object.
 */
function withoutSignal<T extends AbortOptions>(options: T): BindingOptions<T> {
  const { signal: _signal, ...rest } = options;
  return rest;
}

function isBindingOptions(options: CloudflareMemoryOptions): options is CloudflareBindingOptions {
  return isUnknownRecord(options) && "binding" in options;
}

/*
 * Encode one path segment, refusing values that would leave their position.
 *
 * `encodeURIComponent` does not escape dots, so an id of `..` survives into the
 * URL and the WHATWG parser then drops the segment above it: a delete aimed at
 * one memory would arrive at the profile endpoint instead.
 */
function encodePath(value: string): string {
  if (value === "" || value === "." || value === "..") {
    throw new MemoryInputError(`Path segment must not be "${value}"`, { provider: "cloudflare" });
  }
  return encodeURIComponent(value);
}

function characterCount(value: string): number {
  let count = 0;
  for (const _character of value) count += 1;
  return count;
}

function assertString(value: string, label: string, maximumCharacters?: number): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new MemoryInputError(`${label} must be a non-empty string`, { provider: "cloudflare" });
  }
  if (maximumCharacters !== undefined && characterCount(value) > maximumCharacters) {
    throw new MemoryInputError(`${label} must not exceed ${maximumCharacters} characters`, {
      provider: "cloudflare",
    });
  }
}

/* The service measures text in UTF-8 bytes, so a character count is not enough here. */
function assertByteLength(value: string, label: string, maximumBytes: number): void {
  if (new TextEncoder().encode(value).byteLength > maximumBytes) {
    throw new MemoryInputError(`${label} must not exceed ${maximumBytes} UTF-8 bytes`, {
      provider: "cloudflare",
    });
  }
}

function assertMemoryContent(content: string): void {
  assertString(content, "Memory content");
  assertByteLength(content, "Memory content", MAX_MEMORY_CONTENT_BYTES);
}

function assertNamespaceName(namespace: string): void {
  assertString(namespace, "Namespace", MAX_NAMESPACE_NAME_CHARACTERS);
  if (!NAMESPACE_NAME_PATTERN.test(namespace)) {
    throw new MemoryInputError(
      "Namespace must contain lowercase letters, numbers, or internal hyphens",
      { provider: "cloudflare" },
    );
  }
}

/* Profile names carry the same charset rule as namespaces; the service rejects the rest with 400. */
function assertProfileName(profileName: string): void {
  assertString(profileName, "Profile name", MAX_PROFILE_NAME_CHARACTERS);
  if (!NAMESPACE_NAME_PATTERN.test(profileName)) {
    throw new MemoryInputError(
      "Profile name must contain lowercase letters, numbers, or internal hyphens",
      { provider: "cloudflare" },
    );
  }
}

function assertAccountOptions(options: CloudflareAccountOptions): void {
  assertString(options.accountId, "Account ID");
  assertString(options.apiToken, "API token");
  if (options.fetch !== undefined && typeof options.fetch !== "function") {
    throw new MemoryInputError("Fetch must be a function", { provider: "cloudflare" });
  }
}

function assertNamespaceListOptions(options: CloudflareNamespaceListOptions): void {
  assertListLimit(options.limit, MAX_NAMESPACE_LIST_LIMIT);
  if (options.cursor !== undefined) assertString(options.cursor, "Namespace cursor");
  if (options.order !== undefined && options.order !== "id" && options.order !== "name") {
    throw new MemoryInputError("Namespace order must be id or name", { provider: "cloudflare" });
  }
  if (
    options.direction !== undefined &&
    options.direction !== "asc" &&
    options.direction !== "desc"
  ) {
    throw new MemoryInputError("Namespace direction must be asc or desc", {
      provider: "cloudflare",
    });
  }
}

function assertProfileListOptions(options: CloudflareProfileListOptions): void {
  assertListLimit(options.limit, MAX_PROFILE_LIST_LIMIT);
  if (options.cursor !== undefined) assertString(options.cursor, "Profile cursor");
}

function assertSessionId(sessionId: string | null | undefined): void {
  if (sessionId === undefined || sessionId === null) return;
  assertString(sessionId, "Session ID", MAX_SESSION_ID_CHARACTERS);
}

function assertListLimit(limit: number | undefined, maximum: number): void {
  if (limit === undefined) return;
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum) {
    throw new MemoryInputError(`List limit must be an integer between 1 and ${maximum}`, {
      provider: "cloudflare",
    });
  }
}

function assertListOptions(options: ListOptions, maximum: number): void {
  assertListLimit(options.limit, maximum);
  assertSessionId(options.sessionId);
  if (
    options.type !== undefined &&
    options.type !== "fact" &&
    options.type !== "event" &&
    options.type !== "instruction" &&
    options.type !== "task"
  ) {
    throw new MemoryInputError("Memory type must be fact, event, instruction, or task", {
      provider: "cloudflare",
    });
  }
}

function assertRecall(query: string, options: RecallOptions): void {
  assertString(query, "Recall query");
  assertByteLength(query, "Recall query", MAX_QUERY_BYTES);
  if (
    options.thinkingLevel !== undefined &&
    !["low", "medium", "high"].includes(options.thinkingLevel)
  ) {
    throw new MemoryInputError("Recall thinking level must be low, medium, or high", {
      provider: "cloudflare",
    });
  }
  if (
    options.responseLength !== undefined &&
    !["short", "medium", "long"].includes(options.responseLength)
  ) {
    throw new MemoryInputError("Recall response length must be short, medium, or long", {
      provider: "cloudflare",
    });
  }
  if (options.referenceDate !== undefined) {
    const referenceDate =
      options.referenceDate instanceof Date
        ? options.referenceDate
        : new Date(options.referenceDate);
    if (Number.isNaN(referenceDate.getTime())) {
      throw new MemoryInputError("Reference date must be valid", { provider: "cloudflare" });
    }
  }
}

function assertMessage(message: Readonly<MemoryMessage>): void {
  if (!isUnknownRecord(message)) {
    throw new MemoryInputError("Each message must be an object", { provider: "cloudflare" });
  }
  if (message.role !== "system" && message.role !== "user" && message.role !== "assistant") {
    throw new MemoryInputError("Message role must be system, user, or assistant", {
      provider: "cloudflare",
    });
  }
  assertString(message.content, "Message content");
  assertByteLength(message.content, "Message content", MAX_MESSAGE_BYTES);
  if (
    message.timestamp !== undefined &&
    (!(message.timestamp instanceof Date) || Number.isNaN(message.timestamp.getTime()))
  ) {
    throw new MemoryInputError("Message timestamp must be a valid Date", {
      provider: "cloudflare",
    });
  }
}

function collectMessages(messages: Iterable<Readonly<MemoryMessage>>): MemoryMessage[] {
  const collected: MemoryMessage[] = [];
  for (const message of messages) {
    if (collected.length === MAX_INGEST_MESSAGES) {
      throw new MemoryInputError(`Ingest accepts at most ${MAX_INGEST_MESSAGES} messages`, {
        provider: "cloudflare",
      });
    }
    assertMessage(message);
    collected.push({ ...message });
  }
  return collected;
}

async function withCloudflareError<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw normalizeMemoryError(error, "cloudflare");
  }
}

function responseError(message: string, statusCode = 200, cause?: unknown): MemoryHttpError {
  return new MemoryHttpError(message, statusCode, { provider: "cloudflare", cause });
}

function parseString(value: unknown, field: string): string {
  if (typeof value !== "string") throw responseError(`Invalid Cloudflare response: ${field}`);
  return value;
}

function parseNullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return parseString(value, field);
}

function parseDate(value: unknown, field: string): Date {
  const date = new Date(parseString(value, field));
  if (Number.isNaN(date.getTime())) throw responseError(`Invalid Cloudflare response: ${field}`);
  return date;
}

function parseMemoryType(value: unknown): MemoryType {
  if (value !== "fact" && value !== "event" && value !== "instruction" && value !== "task") {
    throw responseError("Invalid Cloudflare response: memory type");
  }
  return value;
}

function parseMemoryBase(value: unknown): MemoryListEntry {
  if (!isUnknownRecord(value)) throw responseError("Invalid Cloudflare response: memory");
  return {
    id: parseString(value.id, "memory id"),
    type: parseMemoryType(value.type),
    summary: parseString(value.summary, "memory summary"),
    sessionId: parseNullableString(value.sessionId, "memory sessionId"),
    createdAt: parseDate(value.createdAt, "memory createdAt"),
    updatedAt: parseDate(value.updatedAt, "memory updatedAt"),
  };
}

function parseMemory(value: unknown): Memory {
  if (!isUnknownRecord(value)) throw responseError("Invalid Cloudflare response: memory");
  return { ...parseMemoryBase(value), content: parseString(value.content, "memory content") };
}

function parseRecallCandidate(value: unknown): RecallCandidate {
  if (!isUnknownRecord(value) || typeof value.score !== "number" || !Number.isFinite(value.score)) {
    throw responseError("Invalid Cloudflare response: recall candidate");
  }
  return {
    id: parseString(value.id, "candidate id"),
    summary: parseString(value.summary, "candidate summary"),
    sessionId: parseNullableString(value.sessionId, "candidate sessionId"),
    score: value.score,
  };
}

/*
 * Read a recall response, whose answer the service may leave out.
 *
 * Only `count` and `candidates` are promised. The answer is documented as
 * omitted when synthesis is skipped, and requiring it would throw away the
 * candidates that came with it.
 */
function parseRecallResult(value: unknown): RecallResult {
  if (
    !isUnknownRecord(value) ||
    typeof value.count !== "number" ||
    !Number.isInteger(value.count) ||
    !Array.isArray(value.candidates)
  ) {
    throw responseError("Invalid Cloudflare response: recall result");
  }
  return {
    count: value.count,
    ...(value.answer === undefined ? {} : { answer: parseString(value.answer, "recall answer") }),
    candidates: value.candidates.map(parseRecallCandidate),
  };
}

function parseMemoryList(value: unknown): MemoryListEntry[] {
  if (!Array.isArray(value)) throw responseError("Invalid Cloudflare response: memory list");
  return value.map(parseMemoryBase);
}

function parseSummary(value: unknown): SummaryResult {
  if (!isUnknownRecord(value)) throw responseError("Invalid Cloudflare response: summary");
  return { summary: parseString(value.summary, "summary") };
}

/*
 * Read the result of a call that carries no data back.
 *
 * Ingest and the deletions answer with a nullable object holding no fields, so
 * `null` and an empty object say the same thing. Accepting only `null` would
 * report a deletion that already happened as a failed one, and the caller has
 * nothing left to undo.
 */
function parseEmpty(value: unknown): null {
  if (value !== null && !isUnknownRecord(value)) {
    throw responseError("Invalid Cloudflare response: expected an empty result");
  }
  return null;
}

function parseNamespace(value: unknown): CloudflareNamespace {
  if (!isUnknownRecord(value)) throw responseError("Invalid Cloudflare response: namespace");
  return {
    id: parseString(value.id, "namespace id"),
    name: parseString(value.name, "namespace name"),
    createdAt: parseDate(value.created_at, "namespace created_at"),
    updatedAt: parseDate(value.updated_at, "namespace updated_at"),
  };
}

function parseNamespaces(value: unknown): CloudflareNamespace[] {
  if (!Array.isArray(value)) throw responseError("Invalid Cloudflare response: namespace list");
  return value.map(parseNamespace);
}

function parseProfile(value: unknown): CloudflareProfile {
  if (!isUnknownRecord(value)) throw responseError("Invalid Cloudflare response: profile");
  return {
    name: parseString(value.name, "profile name"),
    createdAt: parseDate(value.createdAt, "profile createdAt"),
  };
}

function parseProfiles(value: unknown): CloudflareProfile[] {
  if (!Array.isArray(value)) throw responseError("Invalid Cloudflare response: profile list");
  return value.map(parseProfile);
}

async function cloudflareResponseBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (!response.ok && error instanceof SyntaxError) return null;
    throw responseError(
      `Cloudflare Agent Memory returned invalid JSON (${response.status})`,
      response.status,
      error,
    );
  }
}

function responseMessage(value: unknown): string | undefined {
  return isUnknownRecord(value) && typeof value.message === "string" ? value.message : undefined;
}

/** How many tries a request got, and whether it was a read the client may repeat. */
interface RequestAttempts {
  count: number;
  read: boolean;
}

const WRITE_FAILURE_NOTE =
  "a write that fails this way may still have landed, so repeat it only once a read shows it did not";

const PASSING_FAILURE_NOTE = "which usually passes, so try the call again later";

function serverFailureText(status: number, attempts: Readonly<RequestAttempts>): string {
  const failed = `Cloudflare Agent Memory failed with ${status}`;
  if (!attempts.read) return `${failed}, and ${WRITE_FAILURE_NOTE}`;
  if (attempts.count === 1) return failed;
  return `${failed} on all ${attempts.count} attempts, ${PASSING_FAILURE_NOTE}`;
}

function networkFailureText(attempts: Readonly<RequestAttempts>): string {
  const failed = "Cloudflare Agent Memory could not be reached";
  if (!attempts.read) return `${failed}, and ${WRITE_FAILURE_NOTE}`;
  if (attempts.count === 1) return failed;
  return `${failed} on all ${attempts.count} attempts, ${PASSING_FAILURE_NOTE}`;
}

function responseMessages(body: unknown): string[] {
  const errors: unknown[] = isUnknownRecord(body) && Array.isArray(body.errors) ? body.errors : [];
  return errors.flatMap((error) => {
    const message = responseMessage(error);
    return message === undefined ? [] : [message];
  });
}

function throwCloudflareResponseError(
  body: unknown,
  response: Response,
  attempts: Readonly<RequestAttempts>,
): never {
  const messages = responseMessages(body);
  const options = { provider: "cloudflare" };
  if (response.status >= 500) {
    const text = serverFailureText(response.status, attempts);
    const message = messages.length === 0 ? text : `${text}: ${messages.join("; ")}`;
    throw new MemoryServerError(message, response.status, options);
  }
  const message =
    messages.join("; ") || `Cloudflare Agent Memory request failed (${response.status})`;
  if (response.status === 401 || response.status === 403) {
    throw new MemoryAuthError(message, response.status, options);
  }
  if (response.status === 404) {
    throw new MemoryNotFoundError(message, response.status, options);
  }
  if (response.status === 429) {
    throw new MemoryRateLimitError(message, response.status, options);
  }
  throw new MemoryHttpError(message, response.status, options);
}

function requireCloudflareEnvelope(
  value: unknown,
  response: Response,
  attempts: Readonly<RequestAttempts>,
): Record<string, unknown> {
  if (!response.ok) throwCloudflareResponseError(value, response, attempts);
  if (!isUnknownRecord(value) || typeof value.success !== "boolean") {
    throw responseError(
      "Cloudflare Agent Memory returned an invalid response envelope",
      response.status,
    );
  }
  if (!value.success) throwCloudflareResponseError(value, response, attempts);
  return value;
}

/**
 * Wait between two tries of a read, and stop waiting the moment the caller aborts.
 * @param milliseconds - How long to wait.
 * @param signal - The caller's signal, if it passed one.
 * @returns {Promise<void>} Resolves after the wait and rejects with the abort reason.
 */
function pause(milliseconds: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    function onAbort(): void {
      clearTimeout(timer);
      reject(signal?.reason);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** One try ends with a response or with the error that left none. */
type AttemptOutcome = { response: Response } | { cause: unknown };

class CloudflareHttpClient {
  private readonly fetcher?: typeof globalThis.fetch;
  private readonly apiToken: string;
  private readonly baseURL: string;

  constructor(options: CloudflareAccountOptions, path: string) {
    this.fetcher = options.fetch;
    this.apiToken = options.apiToken;
    this.baseURL = `${CLOUDFLARE_API_URL}/accounts/${encodePath(options.accountId)}/agent-memory${path}`;
  }

  /**
   * Send a request and parse its envelope.
   * @param path - Path under the client's base URL.
   * @param parseResult - Parser for the envelope's `result`.
   * @param init - Fetch options; the client adds the token and the JSON content type.
   * @param retryStatuses - Statuses worth another try for a read. A write passes none.
   * @returns {Promise<{ result: T; cursor?: string }>} The parsed result and the next page's cursor.
   */
  async request<T>(
    path: string,
    parseResult: (value: unknown) => T,
    init: RequestInit = {},
    retryStatuses?: readonly number[],
  ): Promise<{ result: T; cursor?: string }> {
    return withCloudflareError(async () => {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${this.apiToken}`);
      if (init.body !== undefined && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
      }
      const { response, attempts } = await this.send(
        `${this.baseURL}${path}`,
        { ...init, headers },
        retryStatuses,
      );

      const body = requireCloudflareEnvelope(
        await cloudflareResponseBody(response),
        response,
        attempts,
      );
      const result = parseResult(body.result);
      const cursor =
        isUnknownRecord(body.result_info) && typeof body.result_info.cursor === "string"
          ? body.result_info.cursor
          : undefined;
      return { result, ...(cursor === undefined ? {} : { cursor }) };
    });
  }

  private async send(
    url: string,
    init: RequestInit,
    retryStatuses: readonly number[] | undefined,
  ): Promise<{ response: Response; attempts: RequestAttempts }> {
    const read = retryStatuses !== undefined;
    const limit = read ? READ_ATTEMPTS : 1;
    for (let count = 1; ; count += 1) {
      const outcome = await this.attempt(url, init);
      const attempts = { count, read };
      if ("response" in outcome) {
        const { response } = outcome;
        if (count >= limit || retryStatuses?.includes(response.status) !== true) {
          return { response, attempts };
        }
        await response.body?.cancel();
      } else if (count >= limit) {
        throw new MemoryNetworkError(networkFailureText(attempts), {
          provider: "cloudflare",
          cause: outcome.cause,
        });
      }
      await pause(READ_RETRY_DELAY_MS * 2 ** (count - 1), init.signal);
    }
  }

  /**
   * Reads the global fetch per call, so one installed after the client still applies.
   * @param url - Full request URL.
   * @param init - Fetch options, signal included.
   * @returns {Promise<AttemptOutcome>} The response, or the error a request with no answer threw.
   */
  private async attempt(url: string, init: RequestInit): Promise<AttemptOutcome> {
    try {
      return { response: await (this.fetcher ?? globalThis.fetch)(url, init) };
    } catch (error) {
      if (init.signal?.aborted === true) throw error;
      return { cause: error };
    }
  }
}

function profilesPath(namespace: string): string {
  return `/namespaces/${encodePath(namespace)}/profiles`;
}

function profilePath(namespace: string, profileName: string): string {
  return `${profilesPath(namespace)}/${encodePath(profileName)}`;
}

/*
 * Read one page of the profiles a namespace holds.
 *
 * The service orders the page by name and lists a profile once something has
 * been written to it, so an empty page from an existing namespace means nothing
 * was stored under it yet. A namespace that does not exist answers 404.
 */
async function requestProfilePage(
  client: CloudflareHttpClient,
  path: string,
  options: CloudflareProfileListOptions,
): Promise<CloudflareProfileListResult> {
  assertProfileListOptions(options);
  const query = new URLSearchParams();
  if (options.limit !== undefined) query.set("per_page", String(options.limit));
  if (options.cursor !== undefined) query.set("cursor", options.cursor);
  const suffix = query.size === 0 ? "" : `?${query}`;
  const response = await client.request(
    `${path}${suffix}`,
    parseProfiles,
    { signal: options.signal },
    READ_RETRY_STATUSES,
  );
  return {
    profiles: response.result,
    ...(response.cursor === undefined ? {} : { cursor: response.cursor }),
  };
}

/*
 * Enumerate every profile name in the namespace an HTTP provider is bound to.
 *
 * The contract returns names alone while the service pages at 500, so the pages
 * are drained here. A page that hands back the cursor it was asked with would
 * never end, so it is reported as a malformed response instead.
 */
async function listHttpProfiles(
  options: CloudflareHttpOptions,
  abort: AbortOptions,
): Promise<string[]> {
  const client = new CloudflareHttpClient(options, profilesPath(options.namespace));
  const names: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await requestProfilePage(client, "", {
      limit: MAX_PROFILE_LIST_LIMIT,
      ...(cursor === undefined ? {} : { cursor }),
      signal: abort.signal,
    });
    names.push(...page.profiles.map((profile) => profile.name));
    if (page.cursor !== undefined && page.cursor === cursor) {
      throw responseError("Invalid Cloudflare response: profile cursor repeated");
    }
    cursor = page.cursor;
  } while (cursor !== undefined);
  return names;
}

/**
 * Profile backed by a Workers binding.
 *
 * A binding call runs in process and cannot be interrupted, so cancellation
 * only decides whether it starts. The check sits inside the error wrapper so an
 * aborted call rejects like any other failure instead of throwing at the call
 * site, and the remaining options reach the binding untouched.
 */
class CloudflareBindingProfile extends MemoryProfile implements CloudflareMemoryProfile {
  private readonly profile: AgentMemoryProfileBinding;

  constructor(profile: AgentMemoryProfileBinding) {
    super();
    this.profile = profile;
  }

  override ingest(
    messages: Iterable<Readonly<MemoryMessage>>,
    options: IngestOptions = {},
  ): Promise<void> {
    const collected = collectMessages(messages);
    assertSessionId(options.sessionId);
    return withCloudflareError(() => {
      options.signal?.throwIfAborted();
      return this.profile.ingest(collected, withoutSignal(options));
    });
  }

  override remember(memory: RememberInput, options: AbortOptions = {}): Promise<Memory> {
    assertMemoryContent(memory.content);
    assertSessionId(memory.sessionId);
    return withCloudflareError(() => {
      options.signal?.throwIfAborted();
      return this.profile.remember(memory);
    });
  }

  override recall(query: string, options: RecallOptions = {}): Promise<RecallResult> {
    assertRecall(query, options);
    return withCloudflareError(() => {
      options.signal?.throwIfAborted();
      return this.profile.recall(query, withoutSignal(options));
    });
  }

  override list(options: ListOptions = {}): Promise<ListResult> {
    assertListOptions(options, MAX_BINDING_LIST_LIMIT);
    return withCloudflareError(() => {
      options.signal?.throwIfAborted();
      return this.profile.list(withoutSignal(options));
    });
  }

  override get(memoryId: string, options: AbortOptions = {}): Promise<Memory> {
    assertString(memoryId, "Memory ID");
    return withCloudflareError(() => {
      options.signal?.throwIfAborted();
      return this.profile.get(memoryId);
    });
  }

  override delete(memoryId: string, options: AbortOptions = {}): Promise<Memory> {
    assertString(memoryId, "Memory ID");
    return withCloudflareError(() => {
      options.signal?.throwIfAborted();
      return this.profile.delete(memoryId);
    });
  }

  override deleteSession(sessionId: string, options: AbortOptions = {}): Promise<void> {
    assertString(sessionId, "Session ID", MAX_SESSION_ID_CHARACTERS);
    return withCloudflareError(() => {
      options.signal?.throwIfAborted();
      return this.profile.deleteSession(sessionId);
    });
  }

  override getSummary(options: SummaryOptions = {}): Promise<SummaryResult> {
    assertSessionId(options.sessionId);
    return withCloudflareError(() => {
      options.signal?.throwIfAborted();
      return this.profile.getSummary(withoutSignal(options));
    });
  }
}

class CloudflareHttpProfile extends MemoryProfile implements CloudflareMemoryProfile {
  private readonly client: CloudflareHttpClient;

  constructor(client: CloudflareHttpClient) {
    super();
    this.client = client;
  }

  override async ingest(
    messages: Iterable<Readonly<MemoryMessage>>,
    options: IngestOptions = {},
  ): Promise<void> {
    const collected = collectMessages(messages);
    assertSessionId(options.sessionId);
    await this.client.request("/ingest", parseEmpty, {
      method: "POST",
      body: JSON.stringify({ messages: collected, ...withoutSignal(options) }),
      signal: options.signal,
    });
  }

  override async remember(memory: RememberInput, options: AbortOptions = {}): Promise<Memory> {
    assertMemoryContent(memory.content);
    assertSessionId(memory.sessionId);
    return (
      await this.client.request("/remember", parseMemory, {
        method: "POST",
        body: JSON.stringify(memory),
        signal: options.signal,
      })
    ).result;
  }

  override async recall(query: string, options: RecallOptions = {}): Promise<RecallResult> {
    assertRecall(query, options);
    return (
      await this.client.request(
        "/recall",
        parseRecallResult,
        {
          method: "POST",
          body: JSON.stringify({ query, ...withoutSignal(options) }),
          signal: options.signal,
        },
        READ_RETRY_STATUSES,
      )
    ).result;
  }

  override async list(options: ListOptions = {}): Promise<ListResult> {
    assertListOptions(options, MAX_HTTP_LIST_LIMIT);
    const query = new URLSearchParams();
    if (options.limit !== undefined) query.set("per_page", String(options.limit));
    if (options.cursor !== undefined) query.set("cursor", options.cursor);
    if (options.sessionId !== undefined) query.set("session_id", options.sessionId);
    if (options.type !== undefined) query.set("type", options.type);
    const suffix = query.size === 0 ? "" : `?${query}`;
    const response = await this.client.request(
      `/memories${suffix}`,
      parseMemoryList,
      { signal: options.signal },
      READ_RETRY_STATUSES,
    );
    return {
      memories: response.result,
      ...(response.cursor === undefined ? {} : { cursor: response.cursor }),
    };
  }

  override async get(memoryId: string, options: AbortOptions = {}): Promise<Memory> {
    assertString(memoryId, "Memory ID");
    return (
      await this.client.request(
        `/memories/${encodePath(memoryId)}`,
        parseMemory,
        { signal: options.signal },
        READ_BY_ID_RETRY_STATUSES,
      )
    ).result;
  }

  override async delete(memoryId: string, options: AbortOptions = {}): Promise<Memory> {
    assertString(memoryId, "Memory ID");
    return (
      await this.client.request(`/memories/${encodePath(memoryId)}`, parseMemory, {
        method: "DELETE",
        signal: options.signal,
      })
    ).result;
  }

  override async deleteSession(sessionId: string, options: AbortOptions = {}): Promise<void> {
    assertString(sessionId, "Session ID", MAX_SESSION_ID_CHARACTERS);
    await this.client.request(`/sessions/${encodePath(sessionId)}`, parseEmpty, {
      method: "DELETE",
      signal: options.signal,
    });
  }

  override async getSummary(options: SummaryOptions = {}): Promise<SummaryResult> {
    assertSessionId(options.sessionId);
    return (
      await this.client.request(
        "/summary",
        parseSummary,
        {
          method: "POST",
          body: JSON.stringify(withoutSignal(options)),
          signal: options.signal,
        },
        READ_RETRY_STATUSES,
      )
    ).result;
  }
}

/** Account-level Cloudflare Agent Memory namespace operations. */
export class CloudflareNamespaceClient {
  private readonly client: CloudflareHttpClient;

  constructor(options: CloudflareAccountOptions) {
    if (!isUnknownRecord(options)) {
      throw new MemoryInputError("Cloudflare account options must be an object", {
        provider: "cloudflare",
      });
    }
    assertAccountOptions(options);
    this.client = new CloudflareHttpClient(options, "/namespaces");
  }

  /**
   * List the account's Agent Memory namespaces.
   *
   * @param options - Pagination and ordering options plus cancellation.
   * @returns {Promise<CloudflareNamespaceListResult>} One normalized namespace page and optional cursor.
   */
  async list(options: CloudflareNamespaceListOptions = {}): Promise<CloudflareNamespaceListResult> {
    assertNamespaceListOptions(options);
    const query = new URLSearchParams();
    if (options.limit !== undefined) query.set("per_page", String(options.limit));
    if (options.cursor !== undefined) query.set("cursor", options.cursor);
    if (options.order !== undefined) query.set("order", options.order);
    if (options.direction !== undefined) query.set("direction", options.direction);
    const suffix = query.size === 0 ? "" : `?${query}`;
    const response = await this.client.request(
      suffix,
      parseNamespaces,
      { signal: options.signal },
      READ_RETRY_STATUSES,
    );
    return {
      namespaces: response.result,
      ...(response.cursor === undefined ? {} : { cursor: response.cursor }),
    };
  }

  /**
   * Read one Agent Memory namespace by name.
   *
   * @param name - Validated namespace name.
   * @param options - Request cancellation.
   * @returns {Promise<CloudflareNamespace>} The normalized namespace record.
   */
  async get(name: string, options: AbortOptions = {}): Promise<CloudflareNamespace> {
    assertNamespaceName(name);
    return (
      await this.client.request(
        `/${encodePath(name)}`,
        parseNamespace,
        { signal: options.signal },
        READ_RETRY_STATUSES,
      )
    ).result;
  }

  /**
   * List the profiles one Agent Memory namespace holds, ordered by name.
   *
   * @param name - Validated namespace name.
   * @param options - Pagination options plus cancellation.
   * @returns {Promise<CloudflareProfileListResult>} One page of profiles and the cursor to the next.
   */
  async listProfiles(
    name: string,
    options: CloudflareProfileListOptions = {},
  ): Promise<CloudflareProfileListResult> {
    assertNamespaceName(name);
    return await requestProfilePage(this.client, `/${encodePath(name)}/profiles`, options);
  }

  /**
   * Create an Agent Memory namespace.
   *
   * @param name - Validated namespace name.
   * @param options - Request cancellation.
   * @returns {Promise<CloudflareNamespace>} The newly created namespace record.
   */
  async create(name: string, options: AbortOptions = {}): Promise<CloudflareNamespace> {
    assertNamespaceName(name);
    return (
      await this.client.request("", parseNamespace, {
        method: "POST",
        body: JSON.stringify({ name }),
        signal: options.signal,
      })
    ).result;
  }

  /**
   * Permanently delete an Agent Memory namespace and all of its contents.
   *
   * @param name - Validated namespace name.
   * @param options - Request cancellation.
   * @returns {Promise<void>} A promise that settles after the service accepts the deletion.
   */
  async delete(name: string, options: AbortOptions = {}): Promise<void> {
    assertNamespaceName(name);
    await this.client.request(`/${encodePath(name)}`, parseEmpty, {
      method: "DELETE",
      signal: options.signal,
    });
  }
}

export class CloudflareMemoryProvider extends MemoryProvider {
  override readonly name = "cloudflare";
  override readonly capabilities: Readonly<MemoryCapabilities>;
  private readonly options: CloudflareMemoryOptions;

  constructor(options: CloudflareMemoryOptions) {
    super();
    if (!isUnknownRecord(options)) {
      throw new MemoryInputError("Cloudflare provider options must be an object", {
        provider: "cloudflare",
      });
    }
    if (isBindingOptions(options)) {
      if (
        !isUnknownRecord(options.binding) ||
        typeof options.binding.getProfile !== "function" ||
        typeof options.binding.deleteProfile !== "function"
      ) {
        throw new MemoryInputError("Cloudflare binding is invalid", { provider: "cloudflare" });
      }
    } else {
      assertAccountOptions(options);
      assertNamespaceName(options.namespace);
    }
    this.options = options;
    if (isBindingOptions(options)) {
      this.capabilities = bindingCapabilities;
    } else {
      this.capabilities = httpCapabilities;
      /*
       * The Workers binding has no profile listing, so the method is attached
       * to an HTTP provider only and stays absent on a binding-backed one
       * instead of failing at call time.
       */
      this.listProfiles = (abort = {}) => listHttpProfiles(options, abort);
    }
  }

  override async getProfile(profileName: string): Promise<CloudflareMemoryProfile> {
    assertProfileName(profileName);
    const options = this.options;
    if (isBindingOptions(options)) {
      const profile = await withCloudflareError(() => options.binding.getProfile(profileName));
      return new CloudflareBindingProfile(profile);
    }
    return new CloudflareHttpProfile(
      new CloudflareHttpClient(options, profilePath(options.namespace, profileName)),
    );
  }

  override async deleteProfile(profileName: string, abort: AbortOptions = {}): Promise<void> {
    assertProfileName(profileName);
    const options = this.options;
    if (isBindingOptions(options)) {
      abort.signal?.throwIfAborted();
      await withCloudflareError(() => options.binding.deleteProfile(profileName));
      return;
    }
    await new CloudflareHttpClient(options, profilePath(options.namespace, profileName)).request(
      "",
      parseEmpty,
      {
        method: "DELETE",
        signal: abort.signal,
      },
    );
  }
}

export const cloudflareMemoryFactory = (options: CloudflareMemoryOptions): MemoryProvider =>
  new CloudflareMemoryProvider(options);
