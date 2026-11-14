import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
 * Split a user message into what the person wrote and what each teammate sent.
 *
 * @param text - User message text as Pi got it.
 * @returns {OpenBotSegment[]} The stretches, OpenBot's injected blocks removed.
 */
export function openBotSegments(text: string): OpenBotSegment[] {
  const clean = text.replaceAll(injectedBlockPattern, "").replace(combinedHeaderPattern, "");
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
