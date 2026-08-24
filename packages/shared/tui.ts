import { stripVTControlCharacters } from "node:util";

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
  running: { glyph: "·", color: "accent" },
  done: { glyph: "✓", color: "success" },
  error: { glyph: "✗", color: "error" },
};

/** Argument carrying the subject of the call, most specific first. */
const CALL_SUBJECT_KEYS = ["query", "content", "memoryId", "sessionId"] as const;

/** Arguments worth showing next to the subject as `key=value`. */
const CALL_META_KEYS = [
  "type",
  "thinkingLevel",
  "responseLength",
  "expand",
  "limit",
  "order",
  "direction",
] as const;

/** Result fields naming what the service assigned, most specific first. */
const RESULT_NAME_KEYS = ["id", "name"] as const;

/** Result fields worth restating next to the name. */
const RESULT_FACT_KEYS = ["type", "sessionId"] as const;

/**
 * Result fields carrying a count. A tool reports the same fact as a number or
 * as the array behind it, so both forms are read here.
 */
const RESULT_COUNT_KEYS = ["count", "messageCount", "memories", "namespaces"] as const;

const SUBJECT_WIDTH = 72;
const META_WIDTH = 40;
const META_LIMIT = 5;
/**
 * Pi's own fallback preview shows ten lines. Matching it keeps the depth
 * familiar when a memory tool renders next to a built-in one.
 */
const COLLAPSED_BODY_LINES = 10;
/**
 * A line wider than a few terminals carries no more information, and capping it
 * bounds both the wrapping cost and the escape sequence scan below.
 */
const LINE_WIDTH_CAP = 2048;
/**
 * Width one preview line gets before it is cut.
 *
 * A memory arrives as JSON with its content on a single line, which can run for
 * thousands of characters. Wrapped whole, one such line buries the ten-line
 * preview under itself, so the collapsed view cuts every line to this and the
 * expanded view shows them in full.
 */
const PREVIEW_LINE_WIDTH = 200;

/** Cut a line to `max`, leaving the whitespace inside it alone. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Collapse whitespace and cut to `max`, keeping a trailing ellipsis.
 *
 * The slice up front is safe because collapsing runs first: a value loses at
 * most three of every four characters, so nothing past that could still reach
 * the visible `max`.
 */
function truncate(text: string, max: number): string {
  const bounded = text.length > max * 4 ? text.slice(0, max * 4) : text;
  const single = bounded.replace(/\s+/g, " ").trim();
  return single.length <= max ? single : `${single.slice(0, max - 1)}…`;
}

/**
 * Strip everything that could drive the terminal instead of describing the
 * call. Model arguments and stored memory text cross a trust boundary: the Text
 * component forwards ANSI and OSC sequences and raw control bytes unchanged.
 * `String()` comes first because hostile JSON ignores the declared types.
 */
function stripControlBytes(value: unknown): string {
  const text = String(value);
  const bounded = clip(text, LINE_WIDTH_CAP);
  // oxlint-disable-next-line no-control-regex -- matching control bytes is the point
  return stripVTControlCharacters(bounded).replace(/[\u0000-\u001F\u007F-\u009F]/g, " ");
}

/** Sanitize a value for one status field: no control bytes, one line. */
export function sanitizeTerminalText(value: unknown): string {
  return stripControlBytes(value).replace(/ +/g, " ").trim();
}

/** Sanitize a value and fit it into one status field. */
function field(value: unknown, max: number): string {
  return truncate(sanitizeTerminalText(value), max);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function scalarText(value: unknown): string | undefined {
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function paint(theme: StatusTheme, color: string, text: string): string {
  return theme.fg ? theme.fg(color, text) : text;
}

/** Join the text the tool returned, skipping parts that carry no text. */
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

/**
 * Name the profile a call addresses.
 *
 * A namespace tool addresses a namespace and has no profile, and a wrapper
 * bound to one scope hands the renderer arguments that already carry both.
 */
function callTarget(record: Record<string, unknown>): string | undefined {
  const namespace = scalarText(record.namespace);
  if (namespace === undefined) return undefined;
  const profile = scalarText(record.profile);
  return profile === undefined ? namespace : `${namespace}/${profile}`;
}

/** Map the harness's streaming state onto a call icon. */
function callIcon(options: RenderOptions | undefined): StatusIcon | undefined {
  if (!options) return undefined;
  if (options.isPartial === false) return "done";
  if (options.spinnerFrame !== undefined) return "running";
  return options.executionStarted === true ? "running" : "pending";
}

/**
 * Describe a tool call: what it is, on what, and with which knobs turned.
 *
 * `options` is optional because the two harnesses deliver the streaming state
 * differently; without it the line simply carries no status icon. The profile
 * moves into the meta once a more specific subject takes the description, so a
 * recall shows its question and still says where it looked.
 */
export function describeToolCall(
  label: string,
  args: unknown,
  options?: RenderOptions,
): StatusLine {
  const record = isRecord(args) ? args : {};
  const target = callTarget(record);

  let subject: string | undefined;
  for (const key of CALL_SUBJECT_KEYS) {
    const value = scalarText(record[key]);
    if (value !== undefined) {
      subject = field(value, SUBJECT_WIDTH);
      break;
    }
  }

  const meta: string[] = [];
  if (subject !== undefined && target !== undefined) meta.push(field(target, META_WIDTH));
  if (Array.isArray(record.messages)) meta.push(`messages ${record.messages.length}`);
  for (const key of CALL_META_KEYS) {
    const value = scalarText(record[key]);
    if (value !== undefined) meta.push(`${key}=${field(value, META_WIDTH)}`);
  }

  return {
    icon: callIcon(options),
    spinnerFrame: options?.spinnerFrame,
    title: label,
    description: subject ?? (target === undefined ? undefined : field(target, SUBJECT_WIDTH)),
    meta: meta.length > 0 ? meta.slice(0, META_LIMIT) : undefined,
  };
}

/**
 * State how many memories a delete took with it.
 *
 * The service reports no count of its own, so the tool counts first and says
 * `null` when even that was not possible. A cascade of unknown size is worth
 * saying out loud, and zero removed is a fact, not an empty result.
 */
function removedMeta(details: Record<string, unknown>): string | undefined {
  if (!("removedMemories" in details)) return undefined;
  const removed = details.removedMemories;
  if (typeof removed !== "number") return "removed an unknown number";
  return details.removedAtLeast === true ? `removed at least ${removed}` : `removed ${removed}`;
}

/**
 * Describe a finished tool result: the outcome plus the facts behind it.
 *
 * No title, because both harnesses render the call line above this one and
 * repeating the tool name would print it twice. `isError` is a separate
 * argument because Pi keeps the flag out of the result object and reports it
 * through the render context instead.
 */
export function describeToolResult(result: RenderedToolResult, isError: boolean): StatusLine {
  if (isError) {
    return {
      icon: "error",
      description: field(firstLine(resultText(result)), SUBJECT_WIDTH),
      badge: "failed",
    };
  }

  const details = isRecord(result.details) ? result.details : {};
  const meta: string[] = [];

  for (const key of RESULT_NAME_KEYS) {
    const value = scalarText(details[key]);
    if (value !== undefined) {
      meta.push(field(value, META_WIDTH));
      break;
    }
  }

  for (const key of RESULT_FACT_KEYS) {
    const value = scalarText(details[key]);
    if (value !== undefined) meta.push(`${key}=${field(value, META_WIDTH)}`);
  }

  for (const key of RESULT_COUNT_KEYS) {
    const value = details[key];
    if (typeof value === "number") meta.push(`${key} ${value}`);
    else if (Array.isArray(value)) meta.push(`${key} ${value.length}`);
  }

  const removed = removedMeta(details);
  if (removed !== undefined) meta.push(removed);
  if (details.hasMore === true) meta.push("more pages");

  return {
    icon: "done",
    meta: meta.length > 0 ? meta.slice(0, META_LIMIT) : undefined,
  };
}

/** Render one status header. Everything interpolated is already sanitized. */
export function renderStatusLine(line: StatusLine, theme: StatusTheme): string {
  const parts: string[] = [];

  if (line.icon) {
    const icon = ICONS[line.icon];
    const glyph =
      line.icon === "running" && line.spinnerFrame !== undefined
        ? SPINNER_FRAMES[line.spinnerFrame % SPINNER_FRAMES.length]
        : icon.glyph;
    parts.push(paint(theme, icon.color, glyph ?? icon.glyph));
  }

  if (line.title) {
    parts.push(paint(theme, "toolTitle", theme.bold ? theme.bold(line.title) : line.title));
  }
  if (line.description) parts.push(paint(theme, "dim", line.description));
  if (line.badge) parts.push(paint(theme, "accent", `(${line.badge})`));
  if (line.meta && line.meta.length > 0) parts.push(paint(theme, "muted", line.meta.join(" · ")));

  return parts.join(" ");
}

/**
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

/**
 * Render a finished call: the status header plus the tool's own output,
 * trimmed to a preview until the user expands the result.
 *
 * On a failure the header already carries the first line, so the body starts
 * below it. The exception is a line the header had to cut short, which the body
 * still owes the reader in full.
 */
export function renderToolResult(
  result: RenderedToolResult,
  isError: boolean,
  options: RenderOptions,
  theme: StatusTheme,
): string {
  const line = describeToolResult(result, isError);
  const header = renderStatusLine(line, theme);
  const body = resultText(result);
  if (body.length === 0) return header;

  const first = isError ? firstLine(body) : "";
  const from = isError && first.length <= SUBJECT_WIDTH ? first.length + 1 : 0;
  if (from > body.length) return header;

  const expanded = options.expanded === true;
  const { lines, hidden } = takeLines(
    body,
    from,
    expanded ? Number.POSITIVE_INFINITY : COLLAPSED_BODY_LINES,
  );
  const rendered = lines.map((text) => {
    const clean = stripControlBytes(text);
    return `  ${paint(theme, "toolOutput", expanded ? clean : clip(clean, PREVIEW_LINE_WIDTH))}`;
  });
  if (hidden > 0) rendered.push(`  ${paint(theme, "muted", `… ${hidden} more lines`)}`);

  return [header, ...rendered].join("\n");
}
