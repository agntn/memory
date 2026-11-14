import { MAX_TOOL_INGEST_MESSAGES, MAX_TOOL_MESSAGE_CHARACTERS } from "./memory-tool-contract.ts";
import type { IngestParams, ProfileParams } from "./memory-tools.types.ts";
import { toolErrorMessage } from "./tool-errors.ts";

type IngestMessage = IngestParams["messages"][number];

/** The conversation a turn belongs to, as the host sees it at that moment. */
export interface TurnContext {
  /** Session the ingested messages go under. */
  readonly sessionId?: string;
  /** Tells the person at the keyboard that an ingest failed. */
  readonly warn: (message: string) => void;
}

/** Buffers a conversation and hands it to `memory_ingest` every few turns. */
export interface TurnIngest {
  /** Queue one host message; only user and assistant text goes in. */
  add(message: unknown): void;
  /** Count a finished turn and ingest the queue once enough of them went by. */
  turn(context: TurnContext): void;
  /** Ingest whatever is still queued, after any ingest already running. */
  flush(context: TurnContext): Promise<void>;
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
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(isTextPart)
    .map((part) => part.text)
    .join("\n\n");
}

/**
 * Cut text into pieces the service takes as one message each.
 *
 * @param text - Message text.
 * @returns {string[]} Pieces of at most the message byte cap.
 */
function byteChunks(text: string): string[] {
  if (textEncoder.encode(text).length <= MAX_TOOL_MESSAGE_CHARACTERS) return [text];
  const chunks: string[] = [];
  let chunk = "";
  let bytes = 0;
  for (const character of text) {
    const size = textEncoder.encode(character).length;
    if (bytes + size > MAX_TOOL_MESSAGE_CHARACTERS) {
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
 * @returns {{ timestamp?: string }} The instant, or nothing for a value that isn't one.
 */
function isoTimestamp(timestamp: unknown): { timestamp?: string } {
  if (typeof timestamp !== "number") return {};
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? {} : { timestamp: date.toISOString() };
}

/**
 * Turn one host message into the messages `memory_ingest` takes.
 *
 * @param message - A Pi or OMP agent message.
 * @returns {IngestMessage[]} Nothing for tool results, custom messages and empty text.
 */
export function ingestMessages(message: unknown): IngestMessage[] {
  if (typeof message !== "object" || message === null) return [];
  const { role, content, timestamp } = message as Record<string, unknown>;
  if (role !== "user" && role !== "assistant") return [];
  const text = messageText(content).trim();
  if (text === "") return [];
  const at = isoTimestamp(timestamp);
  return byteChunks(text).map((chunk) => ({ role, content: chunk, ...at }));
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
 * The warning for a failed batch.
 *
 * @param error - What the ingest threw.
 * @param reason - The failure as one line.
 * @param counts - Messages left unsent, and whether no next try comes.
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
 * Ingest a conversation into one profile every `every` turns.
 *
 * @param scope - Profile the conversation goes into.
 * @param every - Turns between ingests.
 * @returns {TurnIngest} The buffer the host feeds.
 */
export function createTurnIngest(scope: ProfileParams, every: number): TurnIngest {
  const queued: IngestMessage[] = [];
  let turns = 0;
  let running: Promise<void> | undefined;

  /**
   * Send what is queued now; a refused batch goes back to the front for the next try.
   *
   * @param context - Session and warning channel of the conversation.
   * @param last - Whether this is the session's final send.
   * @returns {Promise<void>} Settles once the queue is empty or a batch failed.
   */
  async function send(context: TurnContext, last: boolean): Promise<void> {
    const batch = queued.splice(0);
    const { memoryToolExecutors, withCredentialStep } = await import("./memory-tools.ts");
    const session = context.sessionId === undefined ? {} : { sessionId: context.sessionId };
    for (let sent = 0; sent < batch.length; sent += MAX_TOOL_INGEST_MESSAGES) {
      const messages = batch.slice(sent, sent + MAX_TOOL_INGEST_MESSAGES);
      try {
        await memoryToolExecutors.ingest({ ...scope, ...session, messages });
      } catch (error) {
        const unsent = batch.slice(sent);
        if (!mayHaveLanded(error)) queued.unshift(...unsent);
        const reason = withCredentialStep(toolErrorMessage(error), error);
        context.warn(failureWarning(error, reason, { unsent: unsent.length, last }));
        return;
      }
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
    add(message) {
      queued.push(...ingestMessages(message));
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
  };
}
