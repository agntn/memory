/** Crockford base32 as a ULID spells it: digits and uppercase letters without I, L, O and U. */
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** No memory predates the service, so a time part before this names something else. */
export const EARLIEST_MEMORY_MS = Date.UTC(2025, 0, 1);
/** Room for a service clock that runs ahead of the host's. */
export const MEMORY_ID_CLOCK_SKEW_MS = 24 * 60 * 60 * 1_000;

/**
 * Decode the millisecond timestamp a ULID carries in its first ten characters.
 * @param id - A 26-character Crockford base32 identifier.
 * @returns {number} The 48-bit time part as milliseconds since the Unix epoch.
 */
export function ulidTime(id: string): number {
  let time = 0;
  for (const character of id.slice(0, 10)) {
    time = time * 32 + CROCKFORD_ALPHABET.indexOf(character);
  }
  return time;
}

/**
 * Whether a recall candidate id names a raw ingested message rather than a memory. A memory id is
 * a ULID minted at write time; a message id is derived from the content, so its time part is a
 * random instant that lands inside the service's lifetime for about one message in five thousand.
 * @param id - Candidate id as the recall response carries it.
 * @param now - Milliseconds since the Unix epoch treated as the present.
 * @returns {boolean} `true` for an id no memory could carry.
 */
export function isIngestedMessageId(id: string, now: number = Date.now()): boolean {
  if (!ULID_PATTERN.test(id)) return false;
  const time = ulidTime(id);
  return time < EARLIEST_MEMORY_MS || time > now + MEMORY_ID_CLOCK_SKEW_MS;
}
