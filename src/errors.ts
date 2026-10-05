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
export class MemoryRateLimitError extends MemoryHttpError {}

/** Any 5xx. Cloudflare answers an unknown memory id with 500 too, so it isn't proof of a blip. */
export class MemoryServerError extends MemoryHttpError {}

/** No answer at all. The cause says whether DNS, the connection or TLS gave out. */
export class MemoryNetworkError extends MemoryError {}

export class MemoryInputError extends MemoryError {}
export class UnknownProviderError extends MemoryError {}

export function normalizeMemoryError(error: unknown, provider: string): MemoryError {
  if (error instanceof MemoryError) return error;
  if (error instanceof Error) return new MemoryError(error.message, { provider, cause: error });
  return new MemoryError("Unknown memory provider error", { provider, cause: error });
}
