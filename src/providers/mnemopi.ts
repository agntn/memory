import { MemoryProfile, MemoryProvider } from "../memory.ts";
import {
  MemoryError,
  MemoryInputError,
  MemoryNotFoundError,
  normalizeMemoryError,
} from "../errors.ts";
import { isUnknownRecord } from "../type-guards.ts";
import type {
  AbortOptions,
  Memory,
  MemoryCapabilities,
  RecallCandidate,
  RecallOptions,
  RecallResult,
  RememberInput,
} from "../types.ts";

const PROVIDER_NAME = "mnemopi";
const MAX_BANK_NAME_CHARACTERS = 64;
const BANK_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

const capabilities = Object.freeze<MemoryCapabilities>({
  ingest: false,
  remember: true,
  recall: true,
  list: false,
  get: true,
  delete: false,
  deleteSession: false,
  summary: false,
  deleteProfile: false,
  listProfiles: true,
});

/**
 * Structural subset of the Bun-native Mnemopi client used by the adapter.
 *
 * Applications provide this client so `@agntn/memory` does not take a runtime
 * dependency on `@oh-my-pi/pi-mnemopi`.
 */
export interface MnemopiClient {
  /** Bank represented by this client. It must match the requested profile name. */
  readonly bank: string;
  /** Fixed Mnemopi session used for writes and recall visibility. */
  readonly sessionId: string;
  /** Stores a working memory and returns its generated ID. */
  remember(
    memory: {
      content: string;
      session_id?: string;
      memory_type?: string;
    },
    options?: { source?: string },
  ): string;
  /** Returns raw Mnemopi recall rows for the fixed session. */
  recall(query: string, topK?: number, options?: { query_time?: string }): Promise<unknown[]>;
  /** Resolves a raw working, episodic, or fact row by ID. */
  get(memoryId: string): unknown | null;
  /** Waits for pending asynchronous extraction work, when configured. */
  flushExtractions?(): Promise<void>;
  /** Closes the underlying Mnemopi database connection. */
  close(): void;
}

/**
 * Hooks that connect the runtime-agnostic provider to a Mnemopi installation.
 */
export interface MnemopiMemoryOptions {
  /** Creates a client for one bank. The provider owns and closes the returned client. */
  createClient(profileName: string): MnemopiClient;
  /** Enumerates available bank names. */
  listProfiles(): readonly string[] | Promise<readonly string[]>;
  /** Source label attached to remembered entries. Defaults to `@agntn/memory`. */
  source?: string;
}

function assertOptions(options: MnemopiMemoryOptions): void {
  if (
    !isUnknownRecord(options) ||
    typeof options.createClient !== "function" ||
    typeof options.listProfiles !== "function" ||
    (options.source !== undefined &&
      (typeof options.source !== "string" || options.source.length === 0))
  ) {
    throw new MemoryInputError("Mnemopi provider options are invalid", {
      provider: PROVIDER_NAME,
    });
  }
}

function assertProfileName(profileName: string): void {
  if (
    typeof profileName !== "string" ||
    profileName.length === 0 ||
    profileName.length > MAX_BANK_NAME_CHARACTERS ||
    !BANK_NAME_PATTERN.test(profileName)
  ) {
    throw new MemoryInputError(
      "Mnemopi profile name must be 1-64 alphanumeric, hyphen, or underscore characters",
      { provider: PROVIDER_NAME },
    );
  }
}

function assertClient(client: MnemopiClient): void {
  if (
    !isUnknownRecord(client) ||
    typeof client.bank !== "string" ||
    typeof client.sessionId !== "string" ||
    typeof client.remember !== "function" ||
    typeof client.recall !== "function" ||
    typeof client.get !== "function" ||
    (client.flushExtractions !== undefined && typeof client.flushExtractions !== "function") ||
    typeof client.close !== "function"
  ) {
    throw new MemoryInputError("Mnemopi client is invalid", { provider: PROVIDER_NAME });
  }
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new MemoryError(`Invalid Mnemopi memory: ${key}`);
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new MemoryError(`Invalid Mnemopi memory: ${key}`);
  return value;
}

function parseDate(value: string, field: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new MemoryError(`Invalid Mnemopi memory: ${field}`);
  return date;
}

function parseMemory(value: unknown): Memory {
  if (!isUnknownRecord(value)) throw new MemoryError("Invalid Mnemopi memory response");
  const content = requiredString(value, "content");
  const createdAtValue = optionalString(value, "created_at") ?? optionalString(value, "timestamp");
  if (createdAtValue === null) {
    throw new MemoryError("Invalid Mnemopi memory: created_at");
  }
  const createdAt = parseDate(createdAtValue, "created_at");
  const rawType = optionalString(value, "memory_type");
  const type =
    rawType === "event" || rawType === "instruction" || rawType === "task" ? rawType : "fact";

  return {
    id: requiredString(value, "id"),
    type,
    summary: content,
    content,
    sessionId: optionalString(value, "session_id"),
    createdAt,
    updatedAt: createdAt,
  };
}

function parseCandidate(value: unknown): RecallCandidate & { content: string } {
  if (!isUnknownRecord(value)) throw new MemoryError("Invalid Mnemopi recall response");
  const score = value.score;
  if (typeof score !== "number" || !Number.isFinite(score)) {
    throw new MemoryError("Invalid Mnemopi recall response: score");
  }
  const content = requiredString(value, "content");
  return {
    id: requiredString(value, "id"),
    summary: content,
    content,
    sessionId: optionalString(value, "session_id"),
    score,
  };
}

/**
 * Memory operations for one Mnemopi bank and its fixed session.
 */
export class MnemopiMemoryProfile extends MemoryProfile {
  private readonly client: MnemopiClient;
  private readonly source: string;

  constructor(client: MnemopiClient, source: string) {
    super();
    this.client = client;
    this.source = source;
  }
  /**
   * Stores a working memory in the client's session.
   *
   * A supplied session ID must match the fixed session of the client.
   */
  override async remember(input: RememberInput, options: AbortOptions = {}): Promise<Memory> {
    try {
      options.signal?.throwIfAborted();
      if (input.sessionId != null && input.sessionId !== this.client.sessionId) {
        throw new MemoryInputError(
          `Mnemopi profile uses session ${this.client.sessionId}, not ${input.sessionId}`,
          { provider: PROVIDER_NAME },
        );
      }
      const id = this.client.remember(
        {
          content: input.content,
          session_id: this.client.sessionId,
        },
        { source: this.source },
      );
      const memory = this.client.get(id);
      if (memory === null) throw new MemoryError(`Mnemopi did not return remembered memory: ${id}`);
      return parseMemory(memory);
    } catch (error) {
      throw normalizeMemoryError(error, PROVIDER_NAME);
    }
  }

  /**
   * Recalls up to five candidates and joins their content into the unified answer.
   *
   * `referenceDate` is forwarded to Mnemopi as its temporal query time.
   */
  override async recall(query: string, options: RecallOptions = {}): Promise<RecallResult> {
    try {
      const referenceDate =
        options.referenceDate === undefined ? undefined : new Date(options.referenceDate);
      if (referenceDate !== undefined && Number.isNaN(referenceDate.getTime())) {
        throw new MemoryInputError("Invalid Mnemopi recall referenceDate", {
          provider: PROVIDER_NAME,
        });
      }
      options.signal?.throwIfAborted();
      const results = await this.client.recall(
        query,
        5,
        referenceDate === undefined ? undefined : { query_time: referenceDate.toISOString() },
      );
      options.signal?.throwIfAborted();
      const candidates = results.map(parseCandidate);
      return {
        count: candidates.length,
        answer: candidates.map((candidate) => candidate.content).join("\n\n"),
        candidates: candidates.map(({ content: _content, ...candidate }) => candidate),
      };
    } catch (error) {
      throw normalizeMemoryError(error, PROVIDER_NAME);
    }
  }

  /** Resolves a working, episodic, or fact record by ID within this bank's visibility. */
  override async get(memoryId: string, options: AbortOptions = {}): Promise<Memory> {
    try {
      options.signal?.throwIfAborted();
      const memory = this.client.get(memoryId);
      if (memory === null) {
        throw new MemoryNotFoundError(`Mnemopi memory not found: ${memoryId}`, 404, {
          provider: PROVIDER_NAME,
        });
      }
      return parseMemory(memory);
    } catch (error) {
      throw normalizeMemoryError(error, PROVIDER_NAME);
    }
  }
}

/**
 * Provider adapter that maps memory profiles to Mnemopi banks.
 *
 * Profile clients are created lazily, reused, and released by {@link close}.
 */
export class MnemopiMemoryProvider extends MemoryProvider {
  readonly name = PROVIDER_NAME;
  readonly capabilities = capabilities;
  private readonly options: MnemopiMemoryOptions;
  private readonly profiles = new Map<string, MnemopiMemoryProfile>();
  private readonly clients = new Set<MnemopiClient>();
  private closed = false;

  constructor(options: MnemopiMemoryOptions) {
    super();
    assertOptions(options);
    this.options = options;
  }
  /** Opens or reuses the profile backed by the named Mnemopi bank. */
  override async getProfile(profileName: string): Promise<MnemopiMemoryProfile> {
    try {
      assertProfileName(profileName);
      if (this.closed) throw new MemoryError("Mnemopi provider is closed");
      const existing = this.profiles.get(profileName);
      if (existing !== undefined) return existing;

      const client = this.options.createClient(profileName);
      try {
        assertClient(client);
      } catch (error) {
        try {
          if (isUnknownRecord(client) && typeof client.close === "function") {
            client.close.call(client);
          }
        } catch (closeError) {
          throw new MemoryError("Mnemopi client is invalid and could not be closed", {
            provider: PROVIDER_NAME,
            cause: closeError,
          });
        }
        throw error;
      }
      if (client.bank !== profileName) {
        client.close();
        throw new MemoryInputError(
          `Mnemopi client bank ${client.bank} does not match profile ${profileName}`,
          { provider: PROVIDER_NAME },
        );
      }
      const profile = new MnemopiMemoryProfile(client, this.options.source ?? "@agntn/memory");
      this.clients.add(client);
      this.profiles.set(profileName, profile);
      return profile;
    } catch (error) {
      throw normalizeMemoryError(error, PROVIDER_NAME);
    }
  }

  /** Lists validated, deduplicated bank names without creating profile clients. */
  override async listProfiles(options: AbortOptions = {}): Promise<string[]> {
    try {
      if (this.closed) throw new MemoryError("Mnemopi provider is closed");
      options.signal?.throwIfAborted();
      const profileNames = await this.options.listProfiles();
      options.signal?.throwIfAborted();
      if (!Array.isArray(profileNames)) {
        throw new MemoryError("Invalid Mnemopi profile list");
      }
      for (const profileName of profileNames) assertProfileName(profileName);
      return [...new Set(profileNames)];
    } catch (error) {
      throw normalizeMemoryError(error, PROVIDER_NAME);
    }
  }

  /** Flushes pending extractions and closes every client owned by the provider. */
  override async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const clients = [...this.clients];
    this.clients.clear();
    this.profiles.clear();
    const extractions = await Promise.allSettled(
      clients.map((client) => client.flushExtractions?.()),
    );
    let failure = extractions.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    )?.reason;
    for (const client of clients) {
      try {
        client.close();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw normalizeMemoryError(failure, PROVIDER_NAME);
  }
}

/** Creates a Mnemopi provider for registry-based construction. */
export function mnemopiMemoryFactory(options: MnemopiMemoryOptions): MnemopiMemoryProvider {
  return new MnemopiMemoryProvider(options);
}
