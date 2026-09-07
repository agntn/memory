import { stripVTControlCharacters } from "node:util";
import { UNSAFE_TERMINAL_CHARACTER_PATTERN } from "./terminal-text.ts";

/**
 * Terminal rendering shared by the Pi and OMP wrappers.
 *
 * Both harnesses hand a renderer a theme with `fg()` and `bold()`, but they
 * order the renderer arguments differently. Pi passes `(args, theme, context)`
 * while OMP passes `(args, options, theme)`. Each wrapper adapts its own
 * signature and calls in here, so both surfaces read the same.
 */

/**
 * The part of the harness theme these renderers touch. Both methods are
 * optional: a harness may hand a renderer a bare object, and a status line
 * without styling still has to read correctly.
 */
export interface StatusTheme {
  fg?(color: string, text: string): string;
  bold?(text: string): string;
}

/**
 * View state of one tool row, as the two harnesses report it.
 *
 * Pi carries `executionStarted` and no spinner frame, OMP carries the frame and
 * no start flag. Reading both is what keeps the running icon alive in each.
 */
export interface RenderOptions {
  expanded?: boolean;
  isPartial?: boolean;
  spinnerFrame?: number;
  executionStarted?: boolean;
}

export type StatusIcon = "pending" | "running" | "done" | "error";

/** One status header: icon, tool label, the call's subject, and short facts. */
export interface StatusLine {
  icon?: StatusIcon;
  spinnerFrame?: number;
  /** Memory-specific mark that makes neighboring tool calls easy to scan. */
  symbol?: string;
  /** Left out of a result line, whose call line already names the tool. */
  title?: string;
  description?: string;
  badge?: string;
  meta?: string[];
}

/**
 * A tool result as the harness hands it back to the renderer.
 *
 * `content` stays untyped because a harness models it as a union of text and
 * image parts, and an image part shares no field with a text one.
 */
export interface RenderedToolResult {
  content?: ReadonlyArray<unknown>;
  details?: unknown;
  isError?: boolean;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const ICONS: Record<StatusIcon, { glyph: string; color: string }> = {
  pending: { glyph: "·", color: "muted" },
  running: { glyph: "◌", color: "accent" },
  done: { glyph: "✓", color: "success" },
  error: { glyph: "✗", color: "error" },
};

/** Visual vocabulary shared by the Pi and OMP memory extensions. */
export const MEMORY_TOOL_SYMBOLS = {
  memory_namespace_list: "🗂️",
  memory_namespace_get: "📂",
  memory_namespace_create: "➕",
  memory_namespace_delete: "🗑️",
  memory_profile_list: "👤",
  memory_remember: "🧠",
  memory_supersede: "♻️",
  memory_resume_supersession: "▶️",
  memory_wait_for_recall: "⏳",
  memory_ingest: "📥",
  memory_recall: "🔎",
  memory_list: "📚",
  memory_get: "📖",
  memory_delete: "🗑️",
  memory_summary: "📝",
  memory_delete_session: "🧹",
  memory_delete_profile: "🗑️",
} as const;

/** Argument carrying the subject of the call, most specific first. */
const CALL_SUBJECT_KEYS = ["query", "content", "memoryIds", "memoryId", "sessionId"] as const;

/** Human labels for arguments worth showing next to the subject. */
const CALL_META_LABELS = {
  type: "type",
  thinkingLevel: "thinking",
  responseLength: "response",
  expand: "expand",
  limit: "limit",
  order: "order",
  direction: "direction",
} as const;

/**
 * Result fields naming what the service assigned.
 *
 * A namespace comes back with both, and every other tool addresses it by name,
 * so the name is the half worth showing.
 */
const RESULT_NAME_KEYS = ["name", "id"] as const;

/** Human labels for result fields worth restating next to the name. */
const RESULT_FACT_LABELS = { type: "type", sessionId: "session" } as const;

/**
 * Result fields carrying a count. A tool reports the same fact as a number or
 * as the array behind it, so both forms are read here.
 */
const RESULT_COUNT_LABELS = {
  count: ["item", "items"],
  messageCount: ["message", "messages"],
  candidates: ["candidate", "candidates"],
  memories: ["memory", "memories"],
  namespaces: ["namespace", "namespaces"],
  profiles: ["profile", "profiles"],
} as const;

const SUBJECT_WIDTH = 72;
const META_WIDTH = 40;
/**
 * Pi's own fallback preview shows ten lines. Matching it keeps the depth
 * familiar when a memory tool renders next to a built-in one.
 */
const COLLAPSED_BODY_LINES = 10;
/**
 * How much of a line the sanitizer reads before it gives up on the rest.
 *
 * A status field is a few dozen characters wide, so scanning a huge line whole
 * buys nothing there. An expanded body passes no cap, because the whole line is
 * what the reader opened the result for.
 */
const LINE_WIDTH_CAP = 2048;
/**
 * Width one preview line gets before it is cut.
 *
 * A record line, or a content line without breaks of its own, can run for
 * thousands of characters. Wrapped whole, one such line buries the ten-line
 * preview under itself, so the collapsed view cuts every line to this and the
 * expanded view shows them in full.
 */
const PREVIEW_LINE_WIDTH = 200;

/*
 * Cut `text` to `end` code units without splitting a surrogate pair.
 *
 * Half a pair is not a character the terminal can measure or print, so a cut
 * that lands inside one gives back the code unit before it.
 */
function cutAt(text: string, end: number): string {
  // oxlint-disable-next-line unicorn/prefer-code-point -- This boundary check must inspect one UTF-16 code unit, not combine the pair.
  const last = text.charCodeAt(end - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end);
}

/* Cut a line to `max`, leaving the whitespace inside it alone. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${cutAt(text, max - 1)}…`;
}

/**
 * One half of a surrogate pair, standing on its own.
 *
 * Model arguments arrive as decoded JSON, which can carry an unpaired code
 * unit. It is not a character, so it has no width the terminal can work with.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const UNSAFE_TERMINAL_CHARACTER = new RegExp(UNSAFE_TERMINAL_CHARACTER_PATTERN, "gu");

/*
 * Strip everything that could drive the terminal instead of describing the
 * call. Model arguments and stored memory text cross a trust boundary: the Text
 * component forwards ANSI and OSC sequences and Unicode layout controls unchanged.
 * `String()` comes first because hostile JSON ignores the declared types.
 * `cap` is where the scan stops and an ellipsis takes over. A caller that needs
 * the line intact raises it.
 */
function stripTerminalControls(value: unknown, cap = LINE_WIDTH_CAP): string {
  const text = String(value);
  const long = text.length > cap;
  const bounded = long ? cutAt(text, cap) : text;
  const clean = stripVTControlCharacters(bounded)
    .replaceAll(UNSAFE_TERMINAL_CHARACTER, " ")
    .replace(LONE_SURROGATE, " ");
  return long ? `${clean}…` : clean;
}

/**
 * Sanitize a value for one status field: no control bytes, one line.
 *
 * @param value - Untrusted value crossing the terminal boundary.
 * @returns {string} Plain single-line text safe to interpolate into a status row.
 */
export function sanitizeTerminalText(value: unknown): string {
  return stripTerminalControls(value).replaceAll(/\s+/g, " ").trim();
}

/* Sanitize a value and fit it into one status field. */
function field(value: unknown, max: number): string {
  return clip(sanitizeTerminalText(value), max);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function scalarText(value: unknown): string | undefined {
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

/*
 * Read the subject of a call, which some tools address one at a time and
 * others in a batch.
 */
function subjectText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return scalarText(value);
  return value.length > 0 ? value.map(String).join(", ") : undefined;
}

function paint(theme: StatusTheme, color: string, text: string): string {
  return theme.fg ? theme.fg(color, text) : text;
}

/* Join the text the tool returned, skipping parts that carry no text. */
function resultText(result: RenderedToolResult): string {
  const parts: string[] = [];
  for (const part of result.content ?? []) {
    if (isRecord(part) && typeof part.text === "string") parts.push(part.text);
  }
  return parts.join("\n").trimEnd();
}

function firstLine(body: string): string {
  const breakAt = body.indexOf("\n");
  return breakAt === -1 ? body : body.slice(0, breakAt);
}

/*
 * Name the profile a call addresses.
 *
 * A namespace tool addresses a namespace and has no profile, and a wrapper
 * bound to one scope hands the renderer arguments that already carry both.
 */
function callTarget(record: Readonly<Record<string, unknown>>): string | undefined {
  const namespace = scalarText(record.namespace);
  if (namespace === undefined) return undefined;
  const profile = scalarText(record.profile);
  return profile === undefined ? namespace : `${namespace}/${profile}`;
}

/* Map the harness's streaming state onto a call icon. */
function callIcon(options: RenderOptions | undefined): StatusIcon | undefined {
  if (!options) return undefined;
  if (options.isPartial === false) return "done";
  if (options.spinnerFrame !== undefined) return "running";
  return options.executionStarted === true ? "running" : "pending";
}

function callSubject(record: Readonly<Record<string, unknown>>): string | undefined {
  for (const key of CALL_SUBJECT_KEYS) {
    const value = subjectText(record[key]);
    if (value !== undefined) return field(value, SUBJECT_WIDTH);
  }
  return undefined;
}

function callMeta(
  record: Readonly<Record<string, unknown>>,
  subject: string | undefined,
  target: string | undefined,
): string[] {
  const meta: string[] = [];
  if (subject !== undefined && target !== undefined) meta.push(field(target, META_WIDTH));
  if (Array.isArray(record.messages)) meta.push(`messages ${record.messages.length}`);
  for (const [key, metaLabel] of Object.entries(CALL_META_LABELS)) {
    const value = scalarText(record[key]);
    if (value !== undefined) meta.push(`${metaLabel} ${field(value, META_WIDTH)}`);
  }
  return meta;
}

/**
 * Describe a tool call: what it is, on what, and with which knobs turned.
 *
 * `options` is optional because the two harnesses deliver the streaming state
 * differently; without it the line simply carries no status icon. The profile
 * moves into the meta once a more specific subject takes the description, so a
 * recall shows its question and still says where it looked.
 *
 * @param label - Human-readable tool label.
 * @param args - Untrusted tool arguments supplied by the model.
 * @param options - Current streaming state, when the harness exposes it.
 * @param symbol - Memory-specific symbol shown beside the label.
 * @returns {StatusLine} A normalized status line for the tool call.
 */
export function describeToolCall(
  label: string,
  args: unknown,
  options?: RenderOptions,
  symbol?: string,
): StatusLine {
  const record = isRecord(args) ? args : {};
  const target = callTarget(record);
  const subject = callSubject(record);
  const meta = callMeta(record, subject, target);

  return {
    icon: callIcon(options),
    spinnerFrame: options?.spinnerFrame,
    symbol,
    title: label,
    description: subject ?? (target === undefined ? undefined : field(target, SUBJECT_WIDTH)),
    meta: meta.length > 0 ? meta : undefined,
  };
}

function resultNameMeta(details: Readonly<Record<string, unknown>>): string[] {
  for (const key of RESULT_NAME_KEYS) {
    const value = scalarText(details[key]);
    if (value !== undefined) return [field(value, META_WIDTH)];
  }
  return [];
}

function resultFactMeta(details: Readonly<Record<string, unknown>>): string[] {
  const meta: string[] = [];
  for (const [key, factLabel] of Object.entries(RESULT_FACT_LABELS)) {
    const value = scalarText(details[key]);
    if (value !== undefined) {
      meta.push(
        key === "type" ? field(value, META_WIDTH) : `${factLabel} ${field(value, META_WIDTH)}`,
      );
    }
  }
  return meta;
}

function resultCountMeta(details: Readonly<Record<string, unknown>>): string[] {
  const meta: string[] = [];
  for (const [key, [singular, plural]] of Object.entries(RESULT_COUNT_LABELS)) {
    const value = details[key];
    const count =
      typeof value === "number" ? value : Array.isArray(value) ? value.length : undefined;
    if (count !== undefined) meta.push(`${count} ${count === 1 ? singular : plural}`);
  }
  return meta;
}

function resultMeta(details: Readonly<Record<string, unknown>>): string[] {
  const meta = [
    ...resultNameMeta(details),
    ...resultFactMeta(details),
    ...resultCountMeta(details),
  ];
  if (details.hasMore === true) meta.push("more pages");
  return meta;
}

/**
 * Describe a finished tool result: the outcome plus the facts behind it.
 *
 * No title, because both harnesses render the call line above this one and
 * repeating the tool name would print it twice. `isError` is a separate
 * argument because Pi keeps the flag out of the result object and reports it
 * through the render context instead.
 *
 * @param result - Tool result supplied by the harness.
 * @param isError - Whether the harness classified the result as failed.
 * @param options - Current streaming and expansion state.
 * @returns {StatusLine} A normalized status line for the tool result.
 */
export function describeToolResult(
  result: RenderedToolResult,
  isError: boolean,
  options?: RenderOptions,
): StatusLine {
  if (isError) {
    return {
      icon: "error",
      description: field(firstLine(resultText(result)), SUBJECT_WIDTH),
      badge: "failed",
    };
  }

  /* A streamed update is progress, not an outcome, so it keeps the running icon. */
  if (options?.isPartial === true) {
    return {
      icon: "running",
      ...(options.spinnerFrame === undefined ? {} : { spinnerFrame: options.spinnerFrame }),
      description: field(firstLine(resultText(result)), SUBJECT_WIDTH),
    };
  }

  const details = isRecord(result.details) ? result.details : {};
  const meta = resultMeta(details);
  return {
    icon: "done",
    meta: meta.length > 0 ? meta : undefined,
  };
}

function renderedIcon(line: StatusLine, theme: StatusTheme): string | undefined {
  if (!line.icon) return undefined;
  const icon = ICONS[line.icon];
  const glyph =
    line.icon === "running" && line.spinnerFrame !== undefined
      ? SPINNER_FRAMES[line.spinnerFrame % SPINNER_FRAMES.length]
      : icon.glyph;
  return paint(theme, icon.color, glyph ?? icon.glyph);
}

/**
 * Render one status header. Everything interpolated is already sanitized.
 *
 * @param line - Normalized status-line fields.
 * @param theme - Harness theme used for optional styling.
 * @returns {string} The rendered one-line status header.
 */
export function renderStatusLine(line: StatusLine, theme: StatusTheme): string {
  const parts: string[] = [];
  const icon = renderedIcon(line, theme);
  if (icon !== undefined) parts.push(icon);
  if (line.symbol) parts.push(paint(theme, "accent", line.symbol));
  if (line.title) {
    parts.push(paint(theme, "toolTitle", theme.bold ? theme.bold(line.title) : line.title));
  }
  if (line.description) parts.push(paint(theme, "dim", line.description));
  if (line.badge) parts.push(paint(theme, "accent", `(${line.badge})`));
  if (line.meta && line.meta.length > 0) parts.push(paint(theme, "muted", line.meta.join(" · ")));

  return parts.join(" ");
}

/*
 * Walk `body` line by line from `from`, materializing at most `max` of them.
 *
 * A collapsed result shows ten lines of a page that can be tens of kilobytes,
 * and a renderer reruns on every streamed delta, so the hidden lines are
 * counted rather than allocated.
 */
function takeLines(body: string, from: number, max: number): { lines: string[]; hidden: number } {
  const lines: string[] = [];
  let hidden = 0;
  let cursor = from;

  while (cursor <= body.length) {
    const breakAt = body.indexOf("\n", cursor);
    const end = breakAt === -1 ? body.length : breakAt;
    if (lines.length < max) lines.push(body.slice(cursor, end));
    else hidden++;
    if (breakAt === -1) break;
    cursor = breakAt + 1;
  }

  return { lines, hidden };
}

function renderedBodyStart(body: string, isError: boolean, isPartial: boolean): number {
  const first = isError || isPartial ? firstLine(body) : "";
  return (isError || isPartial) && sanitizeTerminalText(first).length <= SUBJECT_WIDTH
    ? first.length + 1
    : 0;
}

/**
 * Render a finished call: the status header plus the tool's own output,
 * trimmed to a preview until the user expands the result.
 *
 * On a failure the header already carries the first line, so the body starts
 * below it. The exception is a line the header had to cut short, which the body
 * still owes the reader in full. The header prints the sanitized line, so its
 * length is the one that decides which case this is.
 *
 * @param result - Tool result supplied by the harness.
 * @param isError - Whether the harness classified the result as failed.
 * @param options - Current expansion and streaming state.
 * @param theme - Harness theme used for optional styling.
 * @returns {string} The status header followed by the visible result body.
 */
export function renderToolResult(
  result: RenderedToolResult,
  isError: boolean,
  options: RenderOptions,
  theme: StatusTheme,
): string {
  const line = describeToolResult(result, isError, options);
  const header = renderStatusLine(line, theme);
  const body = resultText(result);
  if (body.length === 0) return header;

  const from = renderedBodyStart(body, isError, options.isPartial === true);
  if (from > body.length) return header;

  const expanded = options.expanded === true;
  const { lines, hidden } = takeLines(
    body,
    from,
    expanded ? Number.POSITIVE_INFINITY : COLLAPSED_BODY_LINES,
  );
  const rendered = lines.map((text) => {
    const clean = expanded
      ? stripTerminalControls(text, Number.POSITIVE_INFINITY)
      : clip(stripTerminalControls(text), PREVIEW_LINE_WIDTH);
    return `  ${paint(theme, "toolOutput", clean)}`;
  });
  if (hidden > 0) {
    rendered.push(`  ${paint(theme, "muted", `… ${hidden} more lines · expand to view`)}`);
  }

  return [header, ...rendered].join("\n");
}
