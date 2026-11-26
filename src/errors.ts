import type { CredentialSource } from "@agntn/credentials";
import type { MigratedMemory } from "./types.ts";

export class MemoryError extends Error {
  readonly provider?: string;
  override readonly cause?: unknown;

  constructor(message: string, options: Readonly<{ provider?: string; cause?: unknown }> = {}) {
    super(message);
    this.name = new.target.name;
    this.provider = options.provider;
    this.cause = options.cause;
  }
}

export class MemoryHttpError extends MemoryError {
  readonly statusCode: number;

  constructor(
    message: string,
    statusCode: number,
    options: Readonly<{ provider?: string; cause?: unknown }> = {},
  ) {
    super(message, options);
    this.statusCode = statusCode;
  }
}

/** A 401 or 403. `credentialSource` says where the refused token came from, when a provider knows. */
export class MemoryAuthError extends MemoryHttpError {
  readonly credentialSource?: CredentialSource;

  constructor(
    message: string,
    statusCode: number,
    options: Readonly<{
      provider?: string;
      cause?: unknown;
      credentialSource?: CredentialSource;
    }> = {},
  ) {
    super(message, statusCode, options);
    this.credentialSource = options.credentialSource;
  }
}
export class MemoryNotFoundError extends MemoryHttpError {}
/** A 429. `retryAfterSeconds` is set only when the service said how long to wait. */
export class MemoryRateLimitError extends MemoryHttpError {
  readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    statusCode: number,
    options: Readonly<{ provider?: string; cause?: unknown; retryAfterSeconds?: number }> = {},
  ) {
    super(message, statusCode, options);
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/** Any 5xx. Cloudflare answers an unknown memory id with 500 too, so it isn't proof of a blip. */
export class MemoryServerError extends MemoryHttpError {}

/** No complete answer. The cause says whether DNS, the connection, TLS or the body gave out. */
export class MemoryNetworkError extends MemoryError {}

export class MemoryInputError extends MemoryError {}

/** What a stopped migration got done, and why it stopped. */
export interface MemoryMigrationErrorOptions {
  readonly memoryId?: string;
  readonly memories: readonly MigratedMemory[];
  readonly deleted: number;
  readonly cause?: unknown;
}

/** A migration that stopped partway. The map says what landed, so the same call can finish it. */
export class MemoryMigrationError extends MemoryError {
  /** The record it stopped at, when one step failed on one record. */
  readonly memoryId?: string;
  /** Old id to new id for every record written or found before the stop. */
  readonly memories: readonly MigratedMemory[];
  /** Source records already deleted. */
  readonly deleted: number;

  constructor(message: string, options: MemoryMigrationErrorOptions) {
    super(message, { cause: options.cause });
    this.memoryId = options.memoryId;
    this.memories = options.memories;
    this.deleted = options.deleted;
  }
}
export class UnknownProviderError extends MemoryError {}

export function normalizeMemoryError(error: unknown, provider: string): MemoryError {
  if (error instanceof MemoryError) return error;
  if (error instanceof Error) return new MemoryError(error.message, { provider, cause: error });
  return new MemoryError("Unknown memory provider error", { provider, cause: error });
}
