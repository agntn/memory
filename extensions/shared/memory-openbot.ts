import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { MAX_TOOL_NAMESPACE_CHARACTERS, MEMORY_NAME_PATTERN } from "./memory-tool-contract.ts";
import { memoryName } from "./memory-project-scope.ts";

/** An OpenBot agent as its `<agent_profile>` block names it. */
export interface OpenBotAgent {
  readonly id: string;
  readonly name: string;
}

/** A stretch of one user message and who wrote it; no sender means the person. */
export interface OpenBotSegment {
  readonly senderId?: string;
  readonly senderName?: string;
  readonly text: string;
}

const agentProfilePattern = /<agent_profile>\n(\{[^\n]*\})\n<\/agent_profile>/u;
/* The header OpenBot's `deliveryPromptInput` puts on a teammate's message, also in channels. */
const teammateHeaderPattern =
  /^Message from OpenBot teammate ([^\n]*) \(([^()\s]+)\)\.\nMessage ID: \S+\n/gmu;
/* A teammate's request posted to a channel, and a member's reply there; each opens the message. */
const channelSenderPattern =
  /^(?:Request from OpenBot teammate ([^\n]*) \(([^()\s]+)\), sent from another conversation|Reply from channel member ([^\n]*) \(([^()\s]+)\) to your message)\. It is not a message from the user\.\n\n/u;
const combinedHeaderPattern =
  /^This turn starts with \d+ messages\. Read all of them before you answer\.\n\n/u;
/* Blocks OpenBot adds to a user message; saved memories would come back as new conversation. */
const injectedBlockPattern =
  /<(openbot_saved_memories|openbot_saved_memories_update|openbot_section_teammates)>[\s\S]*?<\/\1>\n*/gu;
const memoryNamePattern = new RegExp(MEMORY_NAME_PATTERN, "u");
/** OpenBot's reply protocol for the recipient sits above this line; the teammate's words below. */
const COLLABORATOR_SEPARATOR = "\n--- collaborator message ---\n";

/**
 * A teammate's words without the protocol OpenBot puts above them.
 *
 * @param segment - Text after the header.
 * @returns {string} The words below the separator, or the whole text without one.
 */
function collaboratorText(segment: string): string {
  const separator = segment.indexOf(COLLABORATOR_SEPARATOR);
  return separator < 0 ? segment : segment.slice(separator + COLLABORATOR_SEPARATOR.length);
}

/**
 * The OpenBot agent a system prompt belongs to.
 *
 * @param systemPrompt - Pi's effective system prompt.
 * @returns {OpenBotAgent | undefined} The agent, or nothing outside OpenBot.
 */
export function openBotAgent(systemPrompt: string): OpenBotAgent | undefined {
  const json = agentProfilePattern.exec(systemPrompt)?.[1];
  if (json === undefined) return undefined;
  try {
    const { id, name } = JSON.parse(json) as { id?: unknown; name?: unknown };
    return typeof id === "string" && typeof name === "string" ? { id, name } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A user message without the blocks OpenBot pastes into it.
 *
 * @param text - User message text as Pi got it.
 * @returns {string} The text the sender wrote.
 */
export function withoutInjectedBlocks(text: string): string {
  return text.replaceAll(injectedBlockPattern, "");
}

/**
 * Split a user message into what the person wrote and what each teammate sent.
 *
 * @param text - User message text as Pi got it.
 * @returns {OpenBotSegment[]} The stretches, OpenBot's injected blocks removed.
 */
export function openBotSegments(text: string): OpenBotSegment[] {
  const clean = withoutInjectedBlocks(text).replace(combinedHeaderPattern, "");
  const channel = channelSenderPattern.exec(clean);
  if (channel !== null) {
    return [
      {
        senderName: channel[1] ?? channel[3],
        senderId: (channel[2] ?? channel[4])!.replace(/^agent:/u, ""),
        text: clean.slice(channel[0].length),
      },
    ];
  }
  const headers = [...clean.matchAll(teammateHeaderPattern)];
  if (headers[0]?.index !== 0) return [{ text: clean }];
  return headers.map((header, index) => ({
    senderName: header[1],
    senderId: header[2],
    text: collaboratorText(
      clean.slice(header.index + header[0].length, headers[index + 1]?.index ?? clean.length),
    ),
  }));
}

/**
 * Where an OpenBot agent's folder names its namespace.
 *
 * @param agentDirectory - The agent's working directory.
 * @returns {string} Path of its `.pi/agntn/memory.json`.
 */
export function agentScopePath(agentDirectory: string): string {
  return join(agentDirectory, ".pi", "agntn", "memory.json");
}

/**
 * The namespace a template gives an agent's name.
 *
 * @param template - Template with `{name}`, like `{name}-bot`.
 * @param name - The agent's name in OpenBot.
 * @returns {string | undefined} The namespace, or nothing when it can't be one.
 */
export function templateNamespace(template: string, name: string): string | undefined {
  return memoryName(template.replaceAll("{name}", name), MAX_TOOL_NAMESPACE_CHARACTERS);
}

/**
 * Write an agent's namespace file again after it went missing.
 *
 * @param agentDirectory - The agent's working directory.
 * @param namespace - Namespace to write.
 * @returns {boolean} Whether the file was written.
 */
export function writeAgentNamespace(agentDirectory: string, namespace: string): boolean {
  try {
    mkdirSync(dirname(agentScopePath(agentDirectory)), { recursive: true });
    writeFileSync(agentScopePath(agentDirectory), `${JSON.stringify({ namespace }, null, 2)}\n`, {
      flag: "wx",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * The memory namespace an OpenBot agent's folder names in `.pi/agntn/memory.json`.
 *
 * @param agentDirectory - The agent's working directory.
 * @returns {string | undefined} The namespace, or nothing without a valid one.
 */
export function agentNamespace(agentDirectory: string): string | undefined {
  try {
    const source = readFileSync(agentScopePath(agentDirectory), "utf8");
    const { namespace } = JSON.parse(source) as { namespace?: unknown };
    if (typeof namespace !== "string") return undefined;
    const name = namespace.trim();
    return name.length <= MAX_TOOL_NAMESPACE_CHARACTERS && memoryNamePattern.test(name)
      ? name
      : undefined;
  } catch {
    return undefined;
  }
}

/** Who sent one message of a channel session: an agent id, or nobody for the person. */
export interface ChannelSender {
  readonly senderId?: string;
}

/** Finds the sender of a channel message in OpenBot's own records. */
export type ChannelSenders = (text: string) => ChannelSender | undefined;

/* The folder OpenBot loads its Pi extension from sits in its data folder, next to the database. */
const providerStatePattern = /^(.*)[\\/]provider-state[\\/]openbot-pi-[^\\/]+[\\/][^\\/]+$/u;

/**
 * OpenBot's database, found from the extension path OpenBot passes Pi.
 *
 * @param argv - Pi's command line.
 * @returns {string | undefined} Path of `openbot.db`, or nothing outside OpenBot.
 */
export function openBotDatabasePath(argv: readonly string[] = process.argv): string | undefined {
  for (const argument of argv) {
    const folder = providerStatePattern.exec(argument)?.[1];
    if (folder !== undefined) return join(folder, "openbot.db");
  }
  return undefined;
}

/** A channel task as OpenBot stores it, reduced to what names its sender. */
interface ChannelTask {
  readonly instruction?: string;
  readonly parentTaskId?: string | null;
  readonly ownerAgentId?: string;
  readonly requestMessageId?: string;
  readonly sourceMessageIds?: readonly string[];
}

/**
 * Parse one JSON column, or nothing for a missing row.
 *
 * @param row - The row, if any.
 * @param column - Column holding JSON.
 * @returns {T | undefined} The parsed value.
 */
function jsonColumn<T>(row: unknown, column: string): T | undefined {
  const value = (row as Record<string, unknown> | undefined)?.[column];
  return typeof value === "string" ? (JSON.parse(value) as T) : undefined;
}

/** Reads the rows a task's sender comes from. */
interface TaskLookup {
  readonly task: (id: string) => ChannelTask | undefined;
  readonly author: (messageId: string) => unknown;
}

/**
 * The task whose instruction a message carries, the longest when several fit.
 *
 * @param rows - The agent's task rows in the channel.
 * @param text - The message text.
 * @returns {ChannelTask | undefined} The task, or nothing for a message no task wrote.
 */
function matchingTask(rows: readonly unknown[], text: string): ChannelTask | undefined {
  let best: ChannelTask | undefined;
  let bestLength = 0;
  for (const row of rows) {
    const item = jsonColumn<ChannelTask>(row, "task_json");
    const length = carriedLength(item, text);
    if (length > bestLength) {
      best = item;
      bestLength = length;
    }
  }
  return best;
}

/**
 * How long a task's instruction is when the message carries it.
 *
 * @param item - A task, if the row held one.
 * @param text - The message text.
 * @returns {number} The instruction's length, or 0 when the message doesn't carry it.
 */
function carriedLength(item: ChannelTask | undefined, text: string): number {
  const instruction = item?.instruction?.trim() ?? "";
  return instruction !== "" && text.includes(instruction) ? instruction.length : 0;
}

/**
 * Who a task came from: the parent task's owner for an assignment, else its request's author.
 *
 * @param matched - The task the message carries.
 * @param lookup - Reads the parent task and the request's author.
 * @returns {ChannelSender | undefined} The sender, or nothing when the records lack it.
 */
function taskSender(matched: ChannelTask, lookup: TaskLookup): ChannelSender | undefined {
  if (matched.parentTaskId) {
    const owner = lookup.task(matched.parentTaskId)?.ownerAgentId;
    return owner === undefined ? undefined : { senderId: owner };
  }
  const author = lookup.author(matched.sourceMessageIds?.[0] ?? matched.requestMessageId ?? "");
  const id = typeof author === "string" ? author : "";
  return id.startsWith("agent:") ? { senderId: id.slice("agent:".length) } : {};
}

/**
 * Open OpenBot's database read-only, where this runtime has `node:sqlite`.
 *
 * @param databasePath - Path of `openbot.db`.
 * @returns {DatabaseSync | undefined} The handle, or nothing when it can't be opened.
 */
function openDatabase(databasePath: string): DatabaseSync | undefined {
  const sqlite = process.getBuiltinModule("node:sqlite") as
    | typeof import("node:sqlite")
    | undefined;
  try {
    return sqlite === undefined
      ? undefined
      : new sqlite.DatabaseSync(databasePath, { readOnly: true });
  } catch {
    return undefined;
  }
}

/**
 * Who sends each message of a Pi session in an OpenBot channel, read from its task records.
 *
 * @param databasePath - Path of `openbot.db`.
 * @param sessionFile - Pi's session file, which OpenBot stores as the channel session.
 * @returns {ChannelSenders | undefined} The lookup, or nothing outside a channel.
 */
export function openBotChannelSenders(
  databasePath: string,
  sessionFile: string,
): ChannelSenders | undefined {
  const database = openDatabase(databasePath);
  if (database === undefined) return undefined;
  try {
    const context = database
      .prepare("SELECT channel_id, agent_id FROM projection_channel_contexts WHERE session_id = ?")
      .get(sessionFile) as { channel_id: string; agent_id: string } | undefined;
    if (context === undefined) {
      database.close();
      return undefined;
    }
    const tasks = database.prepare(
      "SELECT t.task_json FROM projection_channel_assignments a JOIN projection_channel_tasks t ON t.task_id = a.task_id WHERE a.channel_id = ? AND json_extract(a.assignment_json, '$.agentId') = ?",
    );
    const task = database.prepare(
      "SELECT task_json FROM projection_channel_tasks WHERE task_id = ?",
    );
    const message = database.prepare(
      "SELECT message_json FROM projection_channel_messages WHERE channel_id = ? AND message_id = ?",
    );
    const lookup: TaskLookup = {
      task: (id) => jsonColumn<ChannelTask>(task.get(id), "task_json"),
      author: (id) =>
        jsonColumn<{ author?: { id?: unknown } }>(
          message.get(context.channel_id, id),
          "message_json",
        )?.author?.id,
    };
    return (text) => {
      try {
        const rows = tasks.all(context.channel_id, context.agent_id);
        const matched = matchingTask(rows, text);
        return matched === undefined ? undefined : taskSender(matched, lookup);
      } catch {
        return undefined;
      }
    };
  } catch {
    database.close();
    return undefined;
  }
}
