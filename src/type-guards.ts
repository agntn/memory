/**
 * Return whether a value is a non-array object with string keys.
 *
 * @param value - Unknown boundary value to inspect.
 * @returns {boolean} Whether the value can be read as a string-keyed record.
 */
export function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
