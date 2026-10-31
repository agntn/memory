import { singleLineToolText } from "./terminal-text.ts";

const MAX_TOOL_ERROR_CHAIN_DEPTH = 8;

function errorMessagePart(value: unknown): string {
  if (value instanceof Error) return value.message;
  return typeof value === "string" ? value : "";
}

function aggregateMessages(value: unknown): string {
  if (!(value instanceof AggregateError)) return "";
  const errors = value.errors as readonly unknown[];
  return errors
    .map((inner) => errorMessagePart(inner))
    .filter((part) => part !== "")
    .join("; ");
}

function errorCode(value: unknown): string {
  if (!(value instanceof Error) || !("code" in value)) return "";
  return typeof value.code === "string" ? value.code : "";
}

function errorText(value: unknown): string {
  const own = errorMessagePart(value);
  const message = own === "" ? aggregateMessages(value) : own;
  const code = errorCode(value);
  if (code === "" || message.includes(code)) return message;
  return message === "" ? code : `${code}: ${message}`;
}

function asObject(value: unknown): object | undefined {
  return typeof value === "object" && value !== null ? value : undefined;
}

function isDistinctMessage(message: string, previous: string | undefined): boolean {
  return message !== "" && previous !== message;
}

function errorCause(value: unknown): unknown {
  return value instanceof Error ? value.cause : undefined;
}

/**
 * Keep the causes, codes and aggregated errors that say why a call failed, and no other error field.
 * @param error - Failure from a memory tool executor.
 * @returns {string} A sanitized message from at most eight causes.
 */
export function toolErrorMessage(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<object>();
  let current: unknown = error;

  for (let depth = 0; depth < MAX_TOOL_ERROR_CHAIN_DEPTH; depth += 1) {
    const currentObject = asObject(current);
    if (currentObject !== undefined && seen.has(currentObject)) break;
    if (currentObject !== undefined) seen.add(currentObject);
    const message = singleLineToolText(errorText(current)).trim();
    if (isDistinctMessage(message, messages.at(-1))) messages.push(message);
    const cause = errorCause(current);
    if (cause === undefined) break;
    current = cause;
  }

  if (messages.length > 0) return messages.join(": ");
  const fallback = singleLineToolText(errorMessagePart(error)).trim();
  return fallback === "" ? "Unknown error" : fallback;
}
