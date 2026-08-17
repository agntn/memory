export class MemoryError extends Error {
  readonly provider?: string;
  override readonly cause?: unknown;

  constructor(message: string, options: { provider?: string; cause?: unknown } = {}) {
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
    options: { provider?: string; cause?: unknown } = {},
  ) {
    super(message, options);
    this.statusCode = statusCode;
  }
}

export class MemoryAuthError extends MemoryHttpError {}
export class MemoryNotFoundError extends MemoryHttpError {}
export class MemoryRateLimitError extends MemoryHttpError {}
export class MemoryInputError extends MemoryError {}
export class UnknownProviderError extends MemoryError {}

export function normalizeMemoryError(error: unknown, provider: string): MemoryError {
  if (error instanceof MemoryError) return error;
  if (error instanceof Error) return new MemoryError(error.message, { provider, cause: error });
  return new MemoryError("Unknown memory provider error", { provider, cause: error });
}
