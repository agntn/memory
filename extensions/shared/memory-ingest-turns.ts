import { MAX_TOOL_INGEST_MESSAGES, MAX_TOOL_MESSAGE_CHARACTERS } from "./memory-tool-contract.ts";
import type { IngestParams, ProfileParams } from "./memory-tools.types.ts";
import { toolErrorMessage } from "./tool-errors.ts";
import { memoryFieldBlock } from "./memory-fields.ts";
import type { Redactor } from "./redaction.ts";

type IngestMessage = IngestParams["messages"][number];

/** The conversation a turn belongs to, as the host sees it at that moment. */
export interface TurnContext {
  /** Session the ingested messages go under. */
  readonly sessionId?: string;
  /** Tells the person at the keyboard that an ingest failed. */
  readonly warn: (message: string) => void;
}

/** One message and the profile it goes into. */
export interface RoutedMessage {
  readonly scope: Readonly<ProfileParams>;
  readonly message: Readonly<IngestMessage>;
  /** Where it goes instead when the service has no namespace for `scope`; none means nowhere. */
  readonly fallback?: Readonly<ProfileParams>;
}

/** Buffers a conversation and hands it to `memory_ingest` every few turns. */
export interface TurnIngest {
  /** Queue messages already routed to their profiles. */
  add(messages: readonly RoutedMessage[]): void;
  /** Count a finished turn and ingest the queue once enough of them went by. */
  turn(context: TurnContext): void;
  /** Ingest whatever is still queued, after any ingest already running. */
  flush(context: TurnContext): Promise<void>;
  /** Route to a namespace again once somebody created it. */
  created(namespace: string): void;
}

/** What the turn ingest reports besides warnings. */
export interface TurnIngestOptions {
  /** Called once per scope whose namespace an ingest found missing. */
  readonly onMissing?: (scope: Readonly<ProfileParams>) => void;
}

const textEncoder = new TextEncoder();

/**
 * Whether one content part of a host message is plain text.
 *
 * @param part - A content part.
 * @returns {boolean} True for `{ type: "text", text }`.
 */
function isTextPart(part: unknown): part is { text: string } {
  if (typeof part !== "object" || part === null) return false;
  const { type, text } = part as { type?: unknown; text?: unknown };
  return type === "text" && typeof text === "string";
}

/**
 * The text of a message, without thinking, tool calls or images.
 *
 * @param content - A string or an array of content parts.
 * @returns {string} The text parts joined by blank lines.
 */
export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(isTextPart)
    .map((part) => part.text)
    .join("\n\n");
}

/**
 * The host message as ingest reads it, joined text struck, so a key split across parts goes too.
 *
 * @param message - A Pi or OMP agent message.
 * @param redact - The loaded redactor.
 * @returns {unknown} The message with its text as one struck string.
 */
export function redactedMessage(message: unknown, redact: Redactor): unknown {
  if (typeof message !== "object" || message === null) return message;
  const { content } = message as { content?: unknown };
  return { ...message, content: redact(messageText(content)).text };
}

/**
 * Cut text into pieces the service takes as one message each.
 *
 * @param text - Message text.
 * @param limit - Most bytes one piece may hold.
 * @returns {string[]} Pieces of at most `limit` bytes.
 */
export function byteChunks(text: string, limit: number): string[] {
  if (textEncoder.encode(text).length <= limit) return [text];
  const chunks: string[] = [];
  let chunk = "";
  let bytes = 0;
  for (const character of text) {
    const size = textEncoder.encode(character).length;
    if (bytes + size > limit) {
      chunks.push(chunk);
      chunk = "";
      bytes = 0;
    }
    chunk += character;
    bytes += size;
  }
  chunks.push(chunk);
  return chunks;
}

/**
 * The ISO instant of a host timestamp in milliseconds.
 *
 * @param timestamp - Milliseconds since the epoch.
 * @returns {{ timestamp?: string }} The instant, or nothing outside years 0 to 9999.
 */
function isoTimestamp(timestamp: unknown): { timestamp?: string } {
  if (typeof timestamp !== "number") return {};
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return {};
  const iso = date.toISOString();
  return /^\d{4}-/u.test(iso) ? { timestamp: iso } : {};
}

/**
 * Ingest messages for one host message, signed by `author` alone: other fields came back as facts.
 *
 * @param message - A Pi or OMP agent message.
 * @param author - Profile of whoever wrote it, when the host knows.
 * @returns {IngestMessage[]} Nothing for tool results, custom messages and empty text.
 */
export function ingestMessages(message: unknown, author?: string): IngestMessage[] {
  if (typeof message !== "object" || message === null) return [];
  const { role, content, timestamp } = message as Record<string, unknown>;
  if (role !== "user" && role !== "assistant") return [];
  const text = messageText(content).trim();
  if (text === "") return [];
  const at = isoTimestamp(timestamp);
  const block = author === undefined ? "" : memoryFieldBlock({ author });
  const limit = MAX_TOOL_MESSAGE_CHARACTERS - textEncoder.encode(block).length;
  return byteChunks(text, limit).map((chunk) => ({ role, content: chunk + block, ...at }));
}

/**
 * Whether the batch may have landed: a dropped connection or an unreadable 2xx answer.
 *
 * @param error - What the ingest threw.
 * @returns {boolean} True when sending it again could extract it twice.
 */
function mayHaveLanded(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "MemoryNetworkError") return true;
  const { statusCode } = error as { statusCode?: unknown };
  return typeof statusCode === "number" && statusCode < 400;
}

/**
 * Whether the service has no such namespace; it creates profiles on write, but not namespaces.
 *
 * @param error - What the ingest threw.
 * @returns {boolean} True for a 404.
 */
function isMissingNamespace(error: unknown): boolean {
  return (error as { statusCode?: unknown } | null)?.statusCode === 404;
}

/**
 * The warning for a failed batch.
 *
 * @param error - What the ingest threw.
 * @param reason - The failure as one line.
 * @param counts - Messages hit by the failure, and whether no next try comes.
 * @returns {string} One line for the terminal.
 */
function failureWarning(
  error: unknown,
  reason: string,
  counts: Readonly<{ unsent: number; last: boolean }>,
): string {
  const { unsent, last } = counts;
  if (mayHaveLanded(error)) {
    return `Memory ingest may have landed, so ${unsent} messages won't be sent again: ${reason}`;
  }
  const fate = last ? "were not ingested" : "wait for the next try";
  return `Memory ingest failed, ${unsent} messages ${fate}: ${reason}`;
}

/**
 * A scope as one key.
 *
 * @param scope - Namespace and profile.
 * @returns {string} `namespace/profile`.
 */
export function scopeKey(scope: ProfileParams): string {
  return `${scope.namespace}/${scope.profile}`;
}

/**
 * The notice for a namespace the service doesn't have.
 *
 * @param scope - Scope that failed.
 * @param fallback - Scope used instead, if any.
 * @returns {string} One line for the terminal.
 */
function fallbackNotice(scope: ProfileParams, fallback: ProfileParams | undefined): string {
  const instead =
    fallback === undefined
      ? `nothing goes to ${scopeKey(scope)}`
      : `${scopeKey(scope)} goes to ${scopeKey(fallback)}`;
  return `Memory namespace ${scope.namespace} doesn't exist, so ${instead} until it does.`;
}

/**
 * Ingest a conversation every few turns, each message into the profile it was routed to.
 *
 * @param every - Turns between ingests.
 * @param options - Who else hears about a missing namespace.
 * @returns {TurnIngest} The buffer the host feeds.
 */
export function createTurnIngest(every: number, options: TurnIngestOptions = {}): TurnIngest {
  const queued: RoutedMessage[] = [];
  /** Scopes whose namespace turned out missing; their messages go to their own fallbacks. */
  const missing = new Set<string>();
  /** How often each namespace got created, so a 404 from before the last time doesn't count. */
  const creations = new Map<string, number>();
  let turns = 0;
  let running: Promise<void> | undefined;

  /**
   * Where a message goes, after any redirect a missing namespace caused.
   *
   * @param routed - The queued message.
   * @returns {ProfileParams | undefined} The scope, or nothing when it has nowhere to go.
   */
  function target(routed: RoutedMessage): ProfileParams | undefined {
    return missing.has(scopeKey(routed.scope)) ? routed.fallback : routed.scope;
  }

  /**
   * The target of a message as one key, so runs compare scopes by value.
   *
   * @param routed - The queued message.
   * @returns {string | undefined} `namespace/profile`, or nothing when it has nowhere to go.
   */
  function targetKey(routed: RoutedMessage): string | undefined {
    const scope = target(routed);
    return scope === undefined ? undefined : scopeKey(scope);
  }

  /**
   * Messages gathered by target, first target first, so a project and its owner copy send one run each.
   * A fallback can land on a target the message already had, so a repeat there drops out.
   *
   * @param batch - Messages in the order they were queued.
   * @returns {RoutedMessage[]} The same messages, each target's once and in their own order.
   */
  function grouped(batch: readonly RoutedMessage[]): RoutedMessage[] {
    const groups = new Map<string | undefined, Map<RoutedMessage["message"], RoutedMessage>>();
    for (const routed of batch) {
      const key = targetKey(routed);
      const group = groups.get(key) ?? new Map<RoutedMessage["message"], RoutedMessage>();
      groups.set(key, group);
      if (!group.has(routed.message)) group.set(routed.message, routed);
    }
    return [...groups.values()].flatMap((group) => [...group.values()]);
  }

  /**
   * The run of messages from `start` that share one target, at most one request's worth.
   *
   * @param batch - Messages being sent.
   * @param start - Index of the first one.
   * @returns {number} How many messages the run holds.
   */
  function runLength(batch: readonly RoutedMessage[], start: number): number {
    const first = targetKey(batch[start]!);
    let end = start + 1;
    while (
      end < batch.length &&
      end - start < MAX_TOOL_INGEST_MESSAGES &&
      targetKey(batch[end]!) === first
    ) {
      end += 1;
    }
    return end - start;
  }

  /**
   * Send one run; a missing namespace sends its messages to their fallbacks from then on.
   *
   * @param run - Messages sharing one target.
   * @param context - Session and warning channel of the conversation.
   * @returns {Promise<boolean>} False when the run has to be regrouped and sent again.
   */
  async function sendRun(run: readonly RoutedMessage[], context: TurnContext): Promise<boolean> {
    const first = run[0]!;
    const scope = target(first);
    if (scope === undefined) return true;
    const { memoryToolExecutors } = await import("./memory-tools.ts");
    const session = context.sessionId === undefined ? {} : { sessionId: context.sessionId };
    const messages = run.map((routed) => ({ ...routed.message }));
    const createdBefore = creations.get(first.scope.namespace);
    try {
      await memoryToolExecutors.ingest({ ...scope, ...session, messages });
      return true;
    } catch (error) {
      const key = scopeKey(first.scope);
      if (!isMissingNamespace(error) || missing.has(key)) throw error;
      if (creations.get(first.scope.namespace) !== createdBefore) return false;
      missing.add(key);
      options.onMissing?.(first.scope);
      context.warn(fallbackNotice(first.scope, first.fallback));
      return false;
    }
  }

  /**
   * Send what is queued now; a refused run and the ones after it go back for the next try.
   *
   * @param context - Session and warning channel of the conversation.
   * @param last - Whether this is the session's final send.
   * @returns {Promise<void>} Settles once the queue is empty or a run failed.
   */
  async function send(context: TurnContext, last: boolean): Promise<void> {
    let batch = grouped(queued.splice(0));
    let sent = 0;
    while (sent < batch.length) {
      const length = runLength(batch, sent);
      try {
        if (!(await sendRun(batch.slice(sent, sent + length), context))) {
          batch = [...batch.slice(0, sent), ...grouped(batch.slice(sent))];
          continue;
        }
      } catch (error) {
        const landed = mayHaveLanded(error);
        queued.unshift(...batch.slice(landed ? sent + length : sent));
        const { withCredentialStep } = await import("./memory-tools.ts");
        const reason = withCredentialStep(toolErrorMessage(error), error);
        const unsent = landed ? length : batch.length - sent;
        context.warn(failureWarning(error, reason, { unsent, last }));
        return;
      }
      sent += length;
    }
  }

  /**
   * Start sending unless a send is already on its way.
   *
   * @param context - Session and warning channel of the conversation.
   * @param last - Whether this is the session's final send.
   * @returns {Promise<void>} The send in flight.
   */
  function start(context: TurnContext, last = false): Promise<void> {
    running ??= send(context, last).finally(() => {
      running = undefined;
    });
    return running;
  }

  return {
    add(messages) {
      queued.push(...messages.filter((routed) => target(routed) !== undefined));
    },
    turn(context) {
      turns += 1;
      if (turns < every) return;
      turns = 0;
      void start(context);
    },
    async flush(context) {
      await running;
      if (queued.length > 0) await start(context, true);
    },
    created(namespace) {
      creations.set(namespace, (creations.get(namespace) ?? 0) + 1);
      for (const key of missing) if (key.startsWith(`${namespace}/`)) missing.delete(key);
    },
  };
}
