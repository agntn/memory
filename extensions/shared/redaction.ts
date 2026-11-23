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

/** Strikes every shape from one text, synchronously once the checksum code is loaded. */
export type Redactor = (text: string) => Redacted;

/** Where one secret sits, as `slice` counts. */
interface Span {
  readonly start: number;
  readonly end: number;
}

/** One shape and how it finds its secrets. */
export interface Shape {
  readonly name: string;
  readonly find: (text: string) => readonly Span[];
}

/** Shapes a host configured, checked once. */
export type RedactionShapes = readonly Shape[];

/** A pattern as `matchAll` takes it, without the mutable `lastIndex` of a shared `RegExp`. */
interface Pattern {
  readonly source: string;
  readonly flags: string;
}

/** The checksum checks `@agntn/keys` lends, loaded on the first ingest. */
interface Checks {
  readonly isWif: (candidate: string) => boolean;
  readonly isMnemonic: (phrase: string) => boolean;
  readonly listed: Readonly<Record<string, boolean>>;
}

const MAX_REDACTION_SHAPES = 32;
const SHAPE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const BASE58 = "1-9A-HJ-NP-Za-km-z";
const WIF_CHAINS = ["bitcoin", "litecoin", "dash", "dogecoin", "decred"] as const;
const WIF_NETWORKS = ["mainnet", "testnet"] as const;
const MNEMONIC_LENGTHS = [24, 21, 18, 15, 12] as const;
const SHORTEST_MNEMONIC = 12;

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
/** Bare hex is usually a txid or a hash, so a key needs a label like `ETH_PRIVATE_KEY`. */
const LABELED_HEX_KEY: Pattern =
  /(?<![a-z0-9])(?:private[ _-]?key|privkey|priv|secret(?:[ _-]?key)?|seed)["'`]?(?:[ \t]*[:=][ \t]*|[ \t]+is[ \t]+|[ \t]+)["'`]?(?:0x)?([0-9a-f]{128}|[0-9a-f]{64})(?![0-9a-z])/dgiu;
const GITHUB_TOKEN: Pattern =
  /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})(?![A-Za-z0-9_])/gu;
const API_KEY: Pattern = /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}/gu;
const SLACK_TOKEN: Pattern = /(?<![A-Za-z0-9-])xox[abposr]-[A-Za-z0-9-]{17,}/gu;
const CLOUDFLARE_TOKEN: Pattern =
  /(?<![A-Za-z0-9_])(?:cf(?:k|ut|at)_[A-Za-z0-9_-]{40,}|cfoat_[A-Za-z0-9_.-]{20,})/gu;

/**
 * Every nonempty match of a global pattern, or of its first group when it has one.
 *
 * @param text - Text to search.
 * @param pattern - Source and flags, `g` among them, `d` for a group.
 * @returns {Span[]} The matches in reading order.
 */
function spansOf(text: string, pattern: Pattern): Span[] {
  return Array.from(text.matchAll(new RegExp(pattern.source, pattern.flags)), (match) => {
    const [start, end] = match.indices?.[1] ?? [match.index, match.index + match[0].length];
    return { start, end };
  }).filter(({ start, end }) => end > start);
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
 * Load the checksum code once, so every later check runs synchronously.
 *
 * @returns {Promise<Checks>} WIF and BIP39 checks over the English list.
 */
async function loadChecks(): Promise<Checks> {
  const [{ decode }, { validateMnemonic, wordlist }] = await Promise.all([
    import("@agntn/keys/wif"),
    import("@agntn/keys/bip39"),
  ]);
  const decodes = (candidate: string, chain: (typeof WIF_CHAINS)[number]) =>
    WIF_NETWORKS.some((network) => {
      try {
        decode(candidate, { chain, network });
        return true;
      } catch {
        return false;
      }
    });
  return {
    isWif: (candidate) => WIF_CHAINS.some((chain) => decodes(candidate, chain)),
    isMnemonic: (phrase) => validateMnemonic(phrase),
    listed: Object.fromEntries(wordlist.map((word) => [word, true])),
  };
}

let checks: Promise<Checks> | undefined;

/** One word of a run, lowercased, with where it sits. */
interface RunWord extends Span {
  readonly word: string;
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
  return stretches.filter((stretch) => stretch.length >= SHORTEST_MNEMONIC);
}

/**
 * Every checksummed phrase in one stretch, from every word, so an overlapping seed can't hide.
 *
 * @param words - Words that are all on the list.
 * @param valid - Checks one phrase.
 * @returns {Span[]} The phrases, overlapping ones merged.
 */
function phrasesIn(words: readonly RunWord[], valid: (phrase: string) => boolean): Span[] {
  const spans: Span[] = [];
  for (let index = 0; index + SHORTEST_MNEMONIC <= words.length; index += 1) {
    const length = MNEMONIC_LENGTHS.find(
      (size) =>
        index + size <= words.length &&
        valid(
          words
            .slice(index, index + size)
            .map(({ word }) => word)
            .join(" "),
        ),
    );
    if (length === undefined) continue;
    const span = { start: words[index]!.start, end: words[index + length - 1]!.end };
    const last = spans.at(-1);
    if (last !== undefined && span.start <= last.end) {
      spans[spans.length - 1] = { start: last.start, end: Math.max(last.end, span.end) };
    } else spans.push(span);
  }
  return spans;
}

/**
 * English BIP39 phrases whose checksum holds, so twelve plain words in a row stay.
 *
 * @param text - Text to search.
 * @param loaded - The checks.
 * @returns {Span[]} Where the phrases sit.
 */
function mnemonicSpans(text: string, loaded: Checks): Span[] {
  const checked = new Map<string, boolean>();
  const valid = (phrase: string) => {
    const known = checked.get(phrase);
    if (known !== undefined) return known;
    const result = loaded.isMnemonic(phrase);
    checked.set(phrase, result);
    return result;
  };
  return spansOf(text, WORD_RUN).flatMap((run) =>
    listedRuns(wordsIn(text, run), loaded.listed).flatMap((words) => phrasesIn(words, valid)),
  );
}

/**
 * What every ingest strikes, armored keys first so their base64 goes whole.
 *
 * @param loaded - The checksum checks.
 * @returns {Shape[]} The built-in shapes.
 */
function builtInShapes(loaded: Checks): Shape[] {
  return [
    patternShape("private-key", PEM_PRIVATE_KEY),
    patternShape("extended-private-key", EXTENDED_PRIVATE_KEY),
    {
      name: "wif",
      find: (text) =>
        spansOf(text, WIF_CANDIDATE).filter(({ start, end }) =>
          loaded.isWif(text.slice(start, end)),
        ),
    },
    { name: "bip39", find: (text) => mnemonicSpans(text, loaded) },
    patternShape("hex-private-key", LABELED_HEX_KEY),
    patternShape("github-token", GITHUB_TOKEN),
    patternShape("api-key", API_KEY),
    patternShape("slack-token", SLACK_TOKEN),
    patternShape("cloudflare-token", CLOUDFLARE_TOKEN),
  ];
}

/** Names the built-in shapes take, which a configured one can't reuse. */
const BUILT_IN_NAMES = [
  "private-key",
  "extended-private-key",
  "wif",
  "bip39",
  "hex-private-key",
  "github-token",
  "api-key",
  "slack-token",
  "cloudflare-token",
] as const;

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
  const taken = new Set<string>(BUILT_IN_NAMES);
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
 * Load the redactor for the built-in shapes and the host's own.
 *
 * @param shapes - Shapes the host adds after the built-in ones.
 * @returns {Promise<Redactor>} A synchronous redactor.
 */
export async function loadRedactor(shapes: RedactionShapes = []): Promise<Redactor> {
  checks ??= loadChecks();
  const all = [...builtInShapes(await checks), ...shapes];
  return (text) => {
    let result = text;
    const counts: Record<string, number> = {};
    for (const shape of all) {
      const spans = shape.find(result);
      if (spans.length === 0) continue;
      counts[shape.name] = spans.length;
      result = strike(result, spans, shape.name);
    }
    return { text: result, counts };
  };
}
