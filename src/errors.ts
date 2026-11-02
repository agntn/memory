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

export class MemoryAuthError extends MemoryHttpError {}
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
export class UnknownProviderError extends MemoryError {}

export function normalizeMemoryError(error: unknown, provider: string): MemoryError {
  if (error instanceof MemoryError) return error;
  if (error instanceof Error) return new MemoryError(error.message, { provider, cause: error });
  return new MemoryError("Unknown memory provider error", { provider, cause: error });
}
