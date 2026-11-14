import { MAX_TOOL_INGEST_MESSAGES, MAX_TOOL_MESSAGE_CHARACTERS } from "./memory-tool-contract.ts";
import type { IngestParams, ProfileParams } from "./memory-tools.types.ts";
import { toolErrorMessage } from "./tool-errors.ts";

type IngestMessage = IngestParams["messages"][number];

/** The conversation a turn belongs to, as the host sees it at that moment. */
export interface TurnContext {
  /** Working directory the project scope comes from. */
  readonly cwd: string;
  /** Session the ingested messages go under. */
  readonly sessionId?: string;
  /** Tells the person at the keyboard that an ingest failed. */
  readonly warn: (message: string) => void;
}

/** Where a turn ingest sends the conversation. */
export interface TurnIngestOptions {
  /** Turns between ingests. */
  readonly every: number;
  /** Scope outside a project, or for a project without its namespace; none means skip. */
  readonly fallback?: ProfileParams;
  /** The project's scope for a working directory, if it has one. */
  readonly project?: (cwd: string) => ProfileParams | undefined;
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
 * The notice for a project whose namespace doesn't exist.
 *
 * @param project - Scope the remote named.
 * @param fallback - Scope the session uses instead, if any.
 * @returns {string} One line for the terminal.
 */
function fallbackNotice(project: ProfileParams, fallback: ProfileParams | undefined): string {
  const instead =
    fallback === undefined
      ? "this session ingests nothing"
      : `this session ingests into ${fallback.namespace}/${fallback.profile}`;
  return `Memory namespace ${project.namespace} doesn't exist, so ${instead}. Create it with memory_namespace_create to keep ${project.namespace}/${project.profile} apart.`;
}

/**
 * Ingest a conversation every few turns, into its project when the remote names one.
 *
 * @param options - Interval and scopes.
 * @returns {TurnIngest} The buffer the host feeds.
 */
export function createTurnIngest(options: Readonly<TurnIngestOptions>): TurnIngest {
  const { every, fallback, project } = options;
  const queued: IngestMessage[] = [];
  let turns = 0;
  let running: Promise<void> | undefined;
  let scope: ProfileParams | undefined;
  let resolved = false;

  /**
   * The scope for this session, read from the remote once.
   *
   * @param context - Conversation the scope is for.
   * @returns {ProfileParams | undefined} The scope, or nothing when there's nowhere to ingest.
   */
  function sessionScope(context: TurnContext): ProfileParams | undefined {
    if (!resolved) {
      scope = project?.(context.cwd) ?? fallback;
      resolved = true;
    }
    return scope;
  }

  /**
   * Send one request's worth of messages, falling back once when the project has no namespace.
   *
   * @param messages - At most one request's worth.
   * @param context - Session and warning channel of the conversation.
   * @returns {Promise<void>} Settles once the service took them.
   */
  async function sendChunk(
    messages: readonly Readonly<IngestMessage>[],
    context: TurnContext,
  ): Promise<void> {
    const { memoryToolExecutors } = await import("./memory-tools.ts");
    const session = context.sessionId === undefined ? {} : { sessionId: context.sessionId };
    const target = sessionScope(context);
    if (target === undefined) return;
    try {
      await memoryToolExecutors.ingest({ ...target, ...session, messages: [...messages] });
    } catch (error) {
      if (target === fallback || !isMissingNamespace(error)) throw error;
      context.warn(fallbackNotice(target, fallback));
      scope = fallback;
      if (fallback !== undefined) {
        await memoryToolExecutors.ingest({ ...fallback, ...session, messages: [...messages] });
      }
    }
  }

  /**
   * Send what is queued now; a refused chunk and the ones after it go back for the next try.
   *
   * @param context - Session and warning channel of the conversation.
   * @param last - Whether this is the session's final send.
   * @returns {Promise<void>} Settles once the queue is empty or a chunk failed.
   */
  async function send(context: TurnContext, last: boolean): Promise<void> {
    const batch = queued.splice(0);
    for (let sent = 0; sent < batch.length; sent += MAX_TOOL_INGEST_MESSAGES) {
      const messages = batch.slice(sent, sent + MAX_TOOL_INGEST_MESSAGES);
      try {
        await sendChunk(messages, context);
      } catch (error) {
        const landed = mayHaveLanded(error);
        queued.unshift(...batch.slice(landed ? sent + messages.length : sent));
        const { withCredentialStep } = await import("./memory-tools.ts");
        const reason = withCredentialStep(toolErrorMessage(error), error);
        const unsent = landed ? messages.length : batch.length - sent;
        context.warn(failureWarning(error, reason, { unsent, last }));
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
      if (resolved && scope === undefined) return;
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
