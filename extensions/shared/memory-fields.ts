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
 * Append the fields after a blank line, unless the content already ends with them.
 *
 * @param content - Memory content the model sent.
 * @param fields - The host's fields.
 * @returns {string} The content the service gets.
 * @throws {ToolInputError} When the fields would push the content past the service's byte cap.
 */
export function stampMemoryContent(content: string, fields: MemoryFields): string {
  const block = `\n\n${Object.entries(fields)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n")}`;
  if (content.endsWith(block)) return content;
  const encoder = new TextEncoder();
  const bytes = encoder.encode(content + block).length;
  if (bytes > MAX_TOOL_MEMORY_CONTENT_CHARACTERS) {
    throw new ToolInputError([
      `Fields from the host add ${encoder.encode(block).length} bytes, taking the content to ${bytes} of ${MAX_TOOL_MEMORY_CONTENT_CHARACTERS} UTF-8 bytes; shorten the content`,
    ]);
  }
  return content + block;
}
