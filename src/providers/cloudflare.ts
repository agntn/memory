import {
  MemoryAuthError,
  MemoryHttpError,
  MemoryInputError,
  MemoryNotFoundError,
  MemoryRateLimitError,
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
  ingest(messages: Iterable<MemoryMessage>, options?: BindingOptions<IngestOptions>): Promise<void>;
  remember(memory: RememberInput): Promise<Memory>;
  recall(query: string, options?: BindingOptions<RecallOptions>): Promise<RecallResult>;
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
  ingest(messages: Iterable<MemoryMessage>, options?: IngestOptions): Promise<void>;
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

export type CloudflareMemoryOptions = CloudflareBindingOptions | CloudflareHttpOptions;

const CLOUDFLARE_API_URL = "https://api.cloudflare.com/client/v4";
const MAX_INGEST_MESSAGES = 500;
const MAX_MESSAGE_BYTES = 32_768;
const MAX_QUERY_BYTES = 1_024;
const MAX_SESSION_ID_CHARACTERS = 64;
const MAX_PROFILE_NAME_CHARACTERS = 100;
const MAX_NAMESPACE_NAME_CHARACTERS = 32;
const NAMESPACE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const MAX_BINDING_LIST_LIMIT = 500;
// The limits page documents 1000, but the API schema and the service both cap per_page at 500.
const MAX_HTTP_LIST_LIMIT = 500;

/** Input limits this provider enforces, so tool schemas can publish the same bounds. */
export const cloudflareMemoryLimits = Object.freeze({
  ingestMessages: MAX_INGEST_MESSAGES,
  messageBytes: MAX_MESSAGE_BYTES,
  queryBytes: MAX_QUERY_BYTES,
  sessionIdCharacters: MAX_SESSION_ID_CHARACTERS,
  profileNameCharacters: MAX_PROFILE_NAME_CHARACTERS,
  namespaceNameCharacters: MAX_NAMESPACE_NAME_CHARACTERS,
  /** Namespaces and profiles share one charset rule. */
  namePattern: NAMESPACE_NAME_PATTERN.source,
  httpListLimit: MAX_HTTP_LIST_LIMIT,
});

const capabilities: Readonly<MemoryCapabilities> = Object.freeze({
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

/**
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

/**
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

function assertNamespaceName(namespace: string): void {
  assertString(namespace, "Namespace", MAX_NAMESPACE_NAME_CHARACTERS);
  if (!NAMESPACE_NAME_PATTERN.test(namespace)) {
    throw new MemoryInputError(
      "Namespace must contain lowercase letters, numbers, or internal hyphens",
      { provider: "cloudflare" },
    );
  }
}

/** Profile names carry the same charset rule as namespaces; the service rejects the rest with 400. */
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
  assertListLimit(options.limit, MAX_HTTP_LIST_LIMIT);
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
  if (new TextEncoder().encode(query).byteLength > MAX_QUERY_BYTES) {
    throw new MemoryInputError(`Recall query must not exceed ${MAX_QUERY_BYTES} UTF-8 bytes`, {
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

function collectMessages(messages: Iterable<MemoryMessage>): MemoryMessage[] {
  const collected: MemoryMessage[] = [];
  for (const message of messages) {
    if (collected.length === MAX_INGEST_MESSAGES) {
      throw new MemoryInputError(`Ingest accepts at most ${MAX_INGEST_MESSAGES} messages`, {
        provider: "cloudflare",
      });
    }
    if (!isUnknownRecord(message)) {
      throw new MemoryInputError("Each message must be an object", { provider: "cloudflare" });
    }
    if (message.role !== "system" && message.role !== "user" && message.role !== "assistant") {
      throw new MemoryInputError("Message role must be system, user, or assistant", {
        provider: "cloudflare",
      });
    }
    assertString(message.content, "Message content");
    if (new TextEncoder().encode(message.content).byteLength > MAX_MESSAGE_BYTES) {
      throw new MemoryInputError(
        `Message content must not exceed ${MAX_MESSAGE_BYTES} UTF-8 bytes`,
        { provider: "cloudflare" },
      );
    }
    if (
      message.timestamp !== undefined &&
      (!(message.timestamp instanceof Date) || Number.isNaN(message.timestamp.getTime()))
    ) {
      throw new MemoryInputError("Message timestamp must be a valid Date", {
        provider: "cloudflare",
      });
    }
    collected.push(message);
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
    answer: parseString(value.answer, "recall answer"),
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

function parseNull(value: unknown): null {
  if (value !== null) throw responseError("Invalid Cloudflare response: expected null result");
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

class CloudflareHttpClient {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly apiToken: string;
  private readonly baseURL: string;

  constructor(options: CloudflareAccountOptions, path: string) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.apiToken = options.apiToken;
    this.baseURL = `${CLOUDFLARE_API_URL}/accounts/${encodePath(options.accountId)}/agent-memory${path}`;
  }

  async request<T>(
    path: string,
    parseResult: (value: unknown) => T,
    init: RequestInit = {},
  ): Promise<{ result: T; cursor?: string }> {
    return withCloudflareError(async () => {
      const response = await this.fetcher(`${this.baseURL}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...init.headers,
        },
      });

      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        throw responseError(
          `Cloudflare Agent Memory returned invalid JSON (${response.status})`,
          response.status,
          error,
        );
      }

      if (!isUnknownRecord(body) || typeof body.success !== "boolean") {
        throw responseError(
          "Cloudflare Agent Memory returned an invalid response envelope",
          response.status,
        );
      }
      if (!response.ok || !body.success) {
        const messages = Array.isArray(body.errors)
          ? body.errors.flatMap((error) =>
              isUnknownRecord(error) && typeof error.message === "string" ? [error.message] : [],
            )
          : [];
        const message =
          messages.join("; ") || `Cloudflare Agent Memory request failed (${response.status})`;
        if (response.status === 401 || response.status === 403) {
          throw new MemoryAuthError(message, response.status, { provider: "cloudflare" });
        }
        if (response.status === 404) {
          throw new MemoryNotFoundError(message, response.status, { provider: "cloudflare" });
        }
        if (response.status === 429) {
          throw new MemoryRateLimitError(message, response.status, { provider: "cloudflare" });
        }
        throw new MemoryHttpError(message, response.status, { provider: "cloudflare" });
      }

      const result = parseResult(body.result);
      const cursor =
        isUnknownRecord(body.result_info) && typeof body.result_info.cursor === "string"
          ? body.result_info.cursor
          : undefined;
      return { result, ...(cursor === undefined ? {} : { cursor }) };
    });
  }
}

function profilePath(namespace: string, profileName: string): string {
  return `/namespaces/${encodePath(namespace)}/profiles/${encodePath(profileName)}`;
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

  override ingest(messages: Iterable<MemoryMessage>, options: IngestOptions = {}): Promise<void> {
    const collected = collectMessages(messages);
    assertSessionId(options.sessionId);
    return withCloudflareError(() => {
      options.signal?.throwIfAborted();
      return this.profile.ingest(collected, withoutSignal(options));
    });
  }

  override remember(memory: RememberInput, options: AbortOptions = {}): Promise<Memory> {
    assertString(memory.content, "Memory content");
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
    messages: Iterable<MemoryMessage>,
    options: IngestOptions = {},
  ): Promise<void> {
    const collected = collectMessages(messages);
    assertSessionId(options.sessionId);
    await this.client.request("/ingest", parseNull, {
      method: "POST",
      body: JSON.stringify({ messages: collected, ...withoutSignal(options) }),
      signal: options.signal,
    });
  }

  override async remember(memory: RememberInput, options: AbortOptions = {}): Promise<Memory> {
    assertString(memory.content, "Memory content");
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
      await this.client.request("/recall", parseRecallResult, {
        method: "POST",
        body: JSON.stringify({ query, ...withoutSignal(options) }),
        signal: options.signal,
      })
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
    const response = await this.client.request(`/memories${suffix}`, parseMemoryList, {
      signal: options.signal,
    });
    return {
      memories: response.result,
      ...(response.cursor === undefined ? {} : { cursor: response.cursor }),
    };
  }

  override async get(memoryId: string, options: AbortOptions = {}): Promise<Memory> {
    assertString(memoryId, "Memory ID");
    return (
      await this.client.request(`/memories/${encodePath(memoryId)}`, parseMemory, {
        signal: options.signal,
      })
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
    await this.client.request(`/sessions/${encodePath(sessionId)}`, parseNull, {
      method: "DELETE",
      signal: options.signal,
    });
  }

  override async getSummary(options: SummaryOptions = {}): Promise<SummaryResult> {
    assertSessionId(options.sessionId);
    return (
      await this.client.request("/summary", parseSummary, {
        method: "POST",
        body: JSON.stringify(withoutSignal(options)),
        signal: options.signal,
      })
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

  /** Lists the account's Agent Memory namespaces. */
  async list(options: CloudflareNamespaceListOptions = {}): Promise<CloudflareNamespaceListResult> {
    assertNamespaceListOptions(options);
    const query = new URLSearchParams();
    if (options.limit !== undefined) query.set("per_page", String(options.limit));
    if (options.cursor !== undefined) query.set("cursor", options.cursor);
    if (options.order !== undefined) query.set("order", options.order);
    if (options.direction !== undefined) query.set("direction", options.direction);
    const suffix = query.size === 0 ? "" : `?${query}`;
    const response = await this.client.request(suffix, parseNamespaces, {
      signal: options.signal,
    });
    return {
      namespaces: response.result,
      ...(response.cursor === undefined ? {} : { cursor: response.cursor }),
    };
  }

  /** Creates an Agent Memory namespace. */
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

  /** Permanently deletes an Agent Memory namespace and all of its contents. */
  async delete(name: string, options: AbortOptions = {}): Promise<void> {
    assertNamespaceName(name);
    await this.client.request(`/${encodePath(name)}`, parseNull, {
      method: "DELETE",
      signal: options.signal,
    });
  }
}

export class CloudflareMemoryProvider extends MemoryProvider {
  override readonly name = "cloudflare";
  override readonly capabilities = capabilities;
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
      parseNull,
      {
        method: "DELETE",
        signal: abort.signal,
      },
    );
  }
}

export const cloudflareMemoryFactory = (options: CloudflareMemoryOptions): MemoryProvider =>
  new CloudflareMemoryProvider(options);
