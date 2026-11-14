import { ToolInputError } from "@agntn/tools";
import {
  MAX_TOOL_MEMORY_CONTENT_CHARACTERS,
  MEMORY_FIELD_KEY_PATTERN,
} from "./memory-tool-contract.ts";

export const MEMORY_FIELDS_ENV = "AGNTN_MEMORY_FIELDS";

/** Key and value lines a host appends to every memory it writes. */
export type MemoryFields = Readonly<Record<string, string>>;

const fieldKeyPattern = new RegExp(MEMORY_FIELD_KEY_PATTERN, "u");
/* Control characters and line breaks, so a value can't forge a second field. */
const unprintablePattern = /[\p{Cc}\u2028\u2029]/u;
/* A block of field lines after the blank line, as any host's fields stamp it. */
const stampedBlockPattern = new RegExp(
  `^(?:\\n${MEMORY_FIELD_KEY_PATTERN.slice(1, -1)}: [^\\n]+)+$`,
  "u",
);
/* The line copySource ends a copy with, which a retried copy carries after the fields. */
const copySourceSuffix = /\n\nCopied from memory "[^"\n]*" in [a-z0-9-]+\/[a-z0-9-]+\.$/u;

/**
 * Check one field, so a stamped line always reads back as the same key and value.
 *
 * @param key - Field name.
 * @param value - Field value as configured.
 * @returns {string} The value without surrounding whitespace.
 * @throws {Error} When the key or the value can't be written as one line.
 */
function parseMemoryField(key: string, value: unknown): string {
  if (!fieldKeyPattern.test(key)) {
    throw new Error(`Memory field key ${JSON.stringify(key)} must match ${fieldKeyPattern.source}`);
  }
  const label = `Memory field ${JSON.stringify(key)}`;
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  if (unprintablePattern.test(value)) {
    throw new Error(`${label} must be one line without control characters`);
  }
  const trimmed = value.trim();
  if (trimmed === "") throw new Error(`${label} must not be blank`);
  return trimmed;
}

/**
 * Parse the fields a host stamps on its writes.
 *
 * @param value - Fields from code or the environment.
 * @param source - Where they came from, named in the error.
 * @returns {MemoryFields | undefined} The checked fields, or nothing when there are none.
 * @throws {Error} When the value isn't an object of one-line strings under plain keys.
 */
export function parseMemoryFields(value: unknown, source: string): MemoryFields | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${source} must be an object of strings`);
  }
  const entries = Object.entries(value).map(([key, field]): [string, string] => [
    key,
    parseMemoryField(key, field),
  ]);
  return entries.length === 0 ? undefined : Object.freeze(Object.fromEntries(entries));
}

/**
 * Read the host's fields from `AGNTN_MEMORY_FIELDS`, a JSON object.
 *
 * @param env - Environment that may carry the variable.
 * @returns {MemoryFields | undefined} The fields, or nothing when the variable is unset or empty.
 * @throws {Error} When the variable holds something other than a JSON object of one-line strings.
 */
export function configuredMemoryFields(
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): MemoryFields | undefined {
  const source = env[MEMORY_FIELDS_ENV]?.trim();
  if (!source) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error(`${MEMORY_FIELDS_ENV} must be a JSON object`);
  }
  return parseMemoryFields(value, MEMORY_FIELDS_ENV);
}

/**
 * Whether stored content is the given content, bare or with field lines some host stamped on it.
 *
 * @param stored - Content the service holds.
 * @param content - Content the caller expects.
 * @returns {boolean} True for the exact text, or for it followed by a blank line and field lines.
 */
export function isStampedContent(stored: string, content: string): boolean {
  if (stored === content) return true;
  if (!stored.startsWith(`${content}\n`)) return false;
  return stampedBlockPattern.test(stored.slice(content.length + 1));
}

/** The harness that writes, and the app running it when there is one, like OpenBot over Pi. */
export type MemoryHost = string | Readonly<{ harness: string; app?: string }>;

/**
 * The host's fields from `AGNTN_MEMORY_FIELDS`, after the harness and app the host knows it runs in.
 *
 * @param host - Harness, or harness and app, or nothing when the host can't tell.
 * @param env - Environment that may carry the variable.
 * @returns {MemoryFields | undefined} The fields, keys in the variable winning.
 * @throws {Error} When the variable is malformed.
 */
export function hostMemoryFields(
  host: MemoryHost | undefined,
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): MemoryFields | undefined {
  const configured = configuredMemoryFields(env);
  if (host === undefined) return configured;
  const { harness, app } = typeof host === "string" ? { harness: host, app: undefined } : host;
  return Object.freeze({ harness, ...(app === undefined ? {} : { app }), ...configured });
}

/**
 * The lines fields add to content: a blank line, then one `key: value` line each.
 *
 * @param fields - Fields in the order they're written.
 * @returns {string} The block, starting with the blank line.
 */
export function memoryFieldBlock(fields: MemoryFields): string {
  return `\n\n${Object.entries(fields)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n")}`;
}

/**
 * Append the fields after a blank line, unless they already end the content or precede its copy line.
 *
 * @param content - Memory content the model sent.
 * @param fields - The host's fields.
 * @returns {string} The content the service gets.
 * @throws {ToolInputError} When the fields would push the content past the service's byte cap.
 */
export function stampMemoryContent(content: string, fields: MemoryFields): string {
  const block = memoryFieldBlock(fields);
  if (content.replace(copySourceSuffix, "").endsWith(block)) return content;
  const encoder = new TextEncoder();
  const bytes = encoder.encode(content + block).length;
  if (bytes > MAX_TOOL_MEMORY_CONTENT_CHARACTERS) {
    throw new ToolInputError([
      `Fields from the host add ${encoder.encode(block).length} bytes, taking the content to ${bytes} of ${MAX_TOOL_MEMORY_CONTENT_CHARACTERS} UTF-8 bytes; shorten the content`,
    ]);
  }
  return content + block;
}
