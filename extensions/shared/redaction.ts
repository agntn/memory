/** Extra secret shapes every ingest strikes, as a JSON array of `{ name, pattern, ignoreCase }`. */
export const MEMORY_REDACT_ENV = "AGNTN_MEMORY_REDACT";

/** A secret shape the host adds; each match becomes `[redacted:<name>]`. */
export interface RedactionShape {
  readonly name: string;
  readonly pattern: string;
  readonly ignoreCase?: boolean;
}

/** Text with its secrets struck, and how many each shape took. */
export interface Redacted {
  readonly text: string;
  readonly counts: Readonly<Record<string, number>>;
}

/** Where one secret sits, as `slice` counts. */
interface Span {
  readonly start: number;
  readonly end: number;
}

/** One shape and how it finds its secrets. */
export interface Shape {
  readonly name: string;
  readonly find: (text: string) => readonly Span[] | Promise<readonly Span[]>;
}

/** Shapes a host configured, checked once at startup. */
export type RedactionShapes = readonly Shape[];

/** A pattern as `matchAll` takes it, without the mutable `lastIndex` of a shared `RegExp`. */
interface Pattern {
  readonly source: string;
  readonly flags: string;
}

const MAX_REDACTION_SHAPES = 32;
const SHAPE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const BASE58 = "1-9A-HJ-NP-Za-km-z";
const WIF_CHAINS = ["bitcoin", "litecoin", "dash", "dogecoin", "decred"] as const;
const WIF_NETWORKS = ["mainnet", "testnet"] as const;
const MNEMONIC_LENGTHS = [24, 21, 18, 15, 12] as const;

/** Armored keys, up to the end of the text when the paste lost its END line. */
const PEM_PRIVATE_KEY: Pattern =
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|$)/gu;
const EXTENDED_PRIVATE_KEY: Pattern = new RegExp(
  `(?<![${BASE58}])[tuvxyzUVYZ]prv[${BASE58}]{107}(?![${BASE58}])`,
  "gu",
);
const WIF_CANDIDATE: Pattern = new RegExp(
  `(?<![${BASE58}])[${BASE58}]{51,53}(?![${BASE58}])`,
  "gu",
);
/** Twelve or more words the English list could hold, the only runs worth a checksum. */
const WORD_RUN: Pattern = /(?<![\p{L}\p{N}])[a-z]{3,8}(?:\s+[a-z]{3,8}){11,}(?![\p{L}\p{N}])/giu;
const WORD: Pattern = /[a-z]+/giu;
/** Bare 64-digit hex is a txid or a hash far more often than a key, so it needs a label. */
const LABELED_HEX_KEY: Pattern =
  /(?<=\b(?:private[ _-]?key|privkey|priv|secret(?:[ _-]?key)?|seed)["'`]?(?:\s*[:=]\s*|\s+is\s+|\s+)["'`]?(?:0x)?)(?:[0-9a-f]{128}|[0-9a-f]{64})(?![0-9a-z])/giu;
const GITHUB_TOKEN: Pattern =
  /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})(?![A-Za-z0-9_])/gu;
const API_KEY: Pattern = /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}/gu;
const SLACK_TOKEN: Pattern = /(?<![A-Za-z0-9-])xox[abposr]-[A-Za-z0-9-]{17,}/gu;
const CLOUDFLARE_TOKEN: Pattern =
  /(?<![A-Za-z0-9_])(?:cf(?:k|ut|at)_[A-Za-z0-9_-]{40,}|cfoat_[A-Za-z0-9_.-]{20,})/gu;

/**
 * Every nonempty match of a global pattern.
 *
 * @param text - Text to search.
 * @param pattern - Source and flags, `g` among them.
 * @returns {Span[]} The matches in reading order.
 */
function spansOf(text: string, pattern: Pattern): Span[] {
  return Array.from(text.matchAll(new RegExp(pattern.source, pattern.flags)), (match) => ({
    start: match.index,
    end: match.index + match[0].length,
  })).filter(({ start, end }) => end > start);
}

/**
 * A shape that is one pattern.
 *
 * @param name - Name in the marker.
 * @param pattern - What it strikes.
 * @returns {Shape} The shape.
 */
function patternShape(name: string, pattern: Pattern): Shape {
  return { name, find: (text) => spansOf(text, pattern) };
}

/**
 * Whether one chain and network take the string as a private key, checksum and all.
 *
 * @param candidate - Base58 of WIF length.
 * @returns {Promise<boolean>} True for a real WIF.
 */
async function isWif(candidate: string): Promise<boolean> {
  const { decode } = await import("@agntn/keys/wif");
  return WIF_CHAINS.some((chain) =>
    WIF_NETWORKS.some((network) => {
      try {
        decode(candidate, { chain, network });
        return true;
      } catch {
        return false;
      }
    }),
  );
}

/**
 * Private keys in wallet import format; a lookalike with a bad checksum stays.
 *
 * @param text - Text to search.
 * @returns {Promise<Span[]>} Where the keys sit.
 */
async function wifSpans(text: string): Promise<Span[]> {
  const candidates = spansOf(text, WIF_CANDIDATE);
  if (candidates.length === 0) return [];
  const real = await Promise.all(candidates.map(({ start, end }) => isWif(text.slice(start, end))));
  return candidates.filter((_span, index) => real[index] === true);
}

/** One word of a run, lowercased, with where it sits. */
interface RunWord extends Span {
  readonly word: string;
}

/**
 * The longest checksummed phrase starting at one word.
 *
 * @param words - The run's words.
 * @param valid - Checks one phrase.
 * @returns {number} Its word count, or 0 when none starts there.
 */
function phraseAt(words: readonly RunWord[], valid: (phrase: string) => boolean): number {
  for (const length of MNEMONIC_LENGTHS) {
    const phrase = words.slice(0, length);
    if (phrase.length === length && valid(phrase.map(({ word }) => word).join(" "))) return length;
  }
  return 0;
}

/**
 * English BIP39 phrases whose checksum holds, so twelve plain words in a row stay.
 *
 * @param text - Text to search.
 * @returns {Promise<Span[]>} Where the phrases sit.
 */
async function mnemonicSpans(text: string): Promise<Span[]> {
  const runs = spansOf(text, WORD_RUN);
  if (runs.length === 0) return [];
  const { validateMnemonic, wordlist } = await import("@agntn/keys/bip39");
  const listed: Record<string, boolean> = Object.fromEntries(wordlist.map((word) => [word, true]));
  /** Repeated text checks each phrase once. */
  const checked = new Map<string, boolean>();
  const valid = (phrase: string) => {
    const known = checked.get(phrase);
    if (known !== undefined) return known;
    const result = validateMnemonic(phrase);
    checked.set(phrase, result);
    return result;
  };
  return runs.flatMap((run) =>
    listedRuns(wordsIn(text, run), listed).flatMap((words) => phrasesIn(words, valid)),
  );
}

/**
 * The words of one run, lowercased, with where each sits in the text.
 *
 * @param text - The whole text.
 * @param run - One run of letters and spaces.
 * @returns {RunWord[]} Its words.
 */
function wordsIn(text: string, run: Span): RunWord[] {
  return spansOf(text.slice(run.start, run.end), WORD).map(({ start, end }) => ({
    word: text.slice(run.start + start, run.start + end).toLowerCase(),
    start: run.start + start,
    end: run.start + end,
  }));
}

/**
 * Stretches of twelve or more words that are all on the list, so prose skips the checksum.
 *
 * @param words - One run's words.
 * @param listed - The English list.
 * @returns {RunWord[][]} The stretches.
 */
function listedRuns(
  words: readonly RunWord[],
  listed: Readonly<Record<string, boolean>>,
): RunWord[][] {
  const stretches: RunWord[][] = [[]];
  for (const word of words) {
    if (Object.hasOwn(listed, word.word)) stretches.at(-1)!.push(word);
    else stretches.push([]);
  }
  return stretches.filter((stretch) => stretch.length >= MNEMONIC_LENGTHS.at(-1)!);
}

/**
 * The checksummed phrases in one stretch, longest first at each word.
 *
 * @param words - Words that are all on the list.
 * @param valid - Checks one phrase.
 * @returns {Span[]} Where the phrases sit.
 */
function phrasesIn(words: readonly RunWord[], valid: (phrase: string) => boolean): Span[] {
  const spans: Span[] = [];
  for (let index = 0; index < words.length;) {
    const length = phraseAt(words.slice(index), valid);
    if (length === 0) {
      index += 1;
      continue;
    }
    spans.push({ start: words[index]!.start, end: words[index + length - 1]!.end });
    index += length;
  }
  return spans;
}

/** What every ingest strikes, armored keys first so their base64 goes whole. */
const BUILT_IN_SHAPES: readonly Shape[] = [
  patternShape("private-key", PEM_PRIVATE_KEY),
  patternShape("extended-private-key", EXTENDED_PRIVATE_KEY),
  { name: "wif", find: wifSpans },
  { name: "bip39", find: mnemonicSpans },
  patternShape("hex-private-key", LABELED_HEX_KEY),
  patternShape("github-token", GITHUB_TOKEN),
  patternShape("api-key", API_KEY),
  patternShape("slack-token", SLACK_TOKEN),
  patternShape("cloudflare-token", CLOUDFLARE_TOKEN),
];

/**
 * Check one configured shape and compile its pattern.
 *
 * @param value - One entry of the configured array.
 * @param label - Where it came from, for the error.
 * @returns {Shape} The shape.
 * @throws {Error} When the entry has no valid name or pattern.
 */
function parseShape(value: unknown, label: string): Shape {
  const { name, pattern, ignoreCase } = (value ?? {}) as Partial<
    Record<keyof RedactionShape, unknown>
  >;
  if (typeof name !== "string" || !SHAPE_NAME.test(name)) {
    throw new Error(`${label} needs a name matching ${SHAPE_NAME.source}`);
  }
  if (typeof pattern !== "string" || pattern === "") {
    throw new Error(`${label} needs a nonempty pattern`);
  }
  return compiledShape({ name, pattern, ignoreCase: ignoreFlag(ignoreCase, label) }, label);
}

/**
 * Read `ignoreCase` strictly.
 *
 * @param ignoreCase - The option as configured.
 * @param label - Where it came from, for the error.
 * @returns {boolean} Whether the pattern ignores case.
 * @throws {TypeError} When it isn't a boolean.
 */
function ignoreFlag(ignoreCase: unknown, label: string): boolean {
  if (ignoreCase === undefined) return false;
  if (typeof ignoreCase !== "boolean")
    throw new TypeError(`${label} takes ignoreCase as a boolean`);
  return ignoreCase;
}

/**
 * Compile one configured pattern.
 *
 * @param shape - Name, source and case flag, already checked.
 * @param label - Where it came from, for the error.
 * @returns {Shape} The shape.
 * @throws {Error} When the pattern doesn't compile.
 */
function compiledShape(shape: Required<RedactionShape>, label: string): Shape {
  const { name, pattern, ignoreCase } = shape;
  try {
    return patternShape(name, new RegExp(pattern, ignoreCase ? "giu" : "gu"));
  } catch (error) {
    throw new Error(`${label} has an invalid pattern: ${(error as Error).message}`, {
      cause: error,
    });
  }
}

/**
 * Check the shapes a host adds, before any message goes out.
 *
 * @param value - The configured array, or nothing.
 * @param source - Where it came from, named in the error.
 * @returns {RedactionShapes | undefined} The shapes, or nothing when there are none.
 * @throws {Error} On a malformed entry, a repeated or built-in name, or too many shapes.
 */
export function parseRedactionShapes(value: unknown, source: string): RedactionShapes | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError(`${source} must be an array of shapes`);
  if (value.length > MAX_REDACTION_SHAPES) {
    throw new Error(`${source} takes at most ${MAX_REDACTION_SHAPES} shapes`);
  }
  const taken = new Set(BUILT_IN_SHAPES.map(({ name }) => name));
  const shapes = value.map((entry: unknown, index) => {
    const shape = parseShape(entry, `${source}[${index}]`);
    if (taken.has(shape.name)) throw new Error(`${source} names ${shape.name} twice`);
    taken.add(shape.name);
    return shape;
  });
  return shapes.length === 0 ? undefined : Object.freeze(shapes);
}

/**
 * Read the host's extra shapes from `AGNTN_MEMORY_REDACT`.
 *
 * @param env - Environment that may carry the variable; a Worker without `process` has none.
 * @returns {RedactionShapes | undefined} The shapes, or nothing when unset.
 * @throws {Error} When the variable isn't a JSON array of valid shapes.
 */
export function configuredRedactionShapes(
  env: Readonly<NodeJS.ProcessEnv> | undefined = globalThis.process?.env,
): RedactionShapes | undefined {
  const source = env?.[MEMORY_REDACT_ENV]?.trim();
  if (!source) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error(`${MEMORY_REDACT_ENV} must be a JSON array`);
  }
  return parseRedactionShapes(value, MEMORY_REDACT_ENV);
}

/**
 * Replace each span with the shape's marker, last first so earlier offsets hold.
 *
 * @param text - Text the spans point into.
 * @param spans - Where the secrets sit.
 * @param name - Name in the marker.
 * @returns {string} The text with the spans struck.
 */
function strike(text: string, spans: readonly Span[], name: string): string {
  let result = text;
  for (const { start, end } of [...spans].reverse()) {
    result = `${result.slice(0, start)}[redacted:${name}]${result.slice(end)}`;
  }
  return result;
}

/**
 * Strike every built-in and configured secret shape from a text.
 *
 * @param text - A message as written.
 * @param shapes - Shapes the host adds after the built-in ones.
 * @returns {Promise<Redacted>} The struck text and the count per shape that matched.
 */
export async function redactSecrets(text: string, shapes: RedactionShapes = []): Promise<Redacted> {
  let result = text;
  const counts: Record<string, number> = {};
  for (const shape of [...BUILT_IN_SHAPES, ...shapes]) {
    const spans = await shape.find(result);
    if (spans.length === 0) continue;
    counts[shape.name] = spans.length;
    result = strike(result, spans, shape.name);
  }
  return { text: result, counts };
}
