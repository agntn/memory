import { dirname, join } from "node:path";
import { MAX_TOOL_PROFILE_CHARACTERS } from "./memory-tool-contract.ts";
import type { RoutedMessage } from "./memory-ingest-turns.ts";
import { ingestMessages, messageText } from "./memory-ingest-turns.ts";
import {
  agentNamespace,
  agentScopePath,
  type ChannelSenders,
  openBotAgent,
  openBotChannelSenders,
  openBotSegments,
  type OpenBotSegment,
  templateNamespace,
  withoutInjectedBlocks,
  writeAgentNamespace,
} from "./memory-openbot.ts";
import { memoryName, projectMemoryScope } from "./memory-project-scope.ts";
import type { ProfileParams } from "./memory-tools.types.ts";
import { singleLineToolText } from "./terminal-text.ts";

/** Scopes the router picks from. */
export interface IngestRouterOptions {
  /** The bound scope: the default outside a project, and the person's profile. */
  readonly fallback?: ProfileParams;
  /** Turns an OpenBot agent's name into its namespace, like `{name}-bot`. */
  readonly agentNamespace?: string;
  /** OpenBot's database, where a channel session's senders are recorded. */
  readonly openBotDatabase?: string;
}

/** What the router reads from the host for one message. */
export interface RouteHost {
  readonly cwd: string;
  readonly sessionFile: () => string | undefined;
  readonly systemPrompt: () => string;
  readonly warn: (message: string) => void;
}

/** Sends each host message to the profile it belongs in. */
export type IngestRouter = (message: unknown, host: RouteHost) => RoutedMessage[];

/** How the conversation is split once per session. */
type Mode =
  | { readonly kind: "scope"; readonly scope: ProfileParams; readonly fallback?: ProfileParams }
  | {
      readonly kind: "openbot";
      readonly namespace: string;
      readonly agentsDirectory: string;
      readonly channel?: ChannelSenders;
    }
  | { readonly kind: "off" };

/**
 * The OpenBot agent's namespace: its file, or the template, which then writes the file again.
 *
 * @param host - The host at the first message.
 * @param name - The agent's name in OpenBot.
 * @param template - Template for a missing file, if any.
 * @returns {string | undefined} The namespace, or nothing when neither gives one.
 */
function openBotNamespace(
  host: RouteHost,
  name: string,
  template: string | undefined,
): string | undefined {
  const stored = agentNamespace(host.cwd);
  if (stored !== undefined) return stored;
  const path = agentScopePath(host.cwd);
  const derived = template === undefined ? undefined : templateNamespace(template, name);
  if (derived === undefined) {
    host.warn(
      `OpenBot agent ${singleLineToolText(name)} has no namespace in ${path}, so its conversation isn't ingested.`,
    );
  } else if (writeAgentNamespace(host.cwd, derived)) {
    host.warn(
      `OpenBot agent ${singleLineToolText(name)} had no namespace file, so ${path} now says ${derived}.`,
    );
  }
  return derived;
}

/**
 * Pick the session's mode: the remote's project, an OpenBot agent, or the bound scope.
 *
 * @param host - The host at the first message.
 * @param options - The bound scope and the agent namespace template.
 * @returns {Mode} How every message of the session is routed.
 */
function sessionMode(host: RouteHost, options: IngestRouterOptions): Mode {
  const { fallback } = options;
  const project = projectMemoryScope(host.cwd);
  if (project !== undefined) {
    return fallback === undefined
      ? { kind: "scope", scope: project }
      : { kind: "scope", scope: project, fallback };
  }
  const agent = openBotAgent(host.systemPrompt());
  if (agent === undefined) {
    return fallback === undefined ? { kind: "off" } : { kind: "scope", scope: fallback };
  }
  const namespace = openBotNamespace(host, agent.name, options.agentNamespace);
  if (namespace === undefined) return { kind: "off" };
  const agentsDirectory = dirname(host.cwd);
  const sessionFile = host.sessionFile();
  const channel =
    options.openBotDatabase === undefined || sessionFile === undefined
      ? undefined
      : openBotChannelSenders(options.openBotDatabase, sessionFile);
  return channel === undefined
    ? { kind: "openbot", namespace, agentsDirectory }
    : { kind: "openbot", namespace, agentsDirectory, channel };
}

/**
 * The senders of one user message: the channel's records first, then OpenBot's headers.
 *
 * @param text - The message text.
 * @param channel - The channel lookup, when the session is a channel's.
 * @returns {OpenBotSegment[]} Its stretches and who wrote each.
 */
function userSegments(text: string, channel: ChannelSenders | undefined): OpenBotSegment[] {
  const clean = withoutInjectedBlocks(text);
  const sender = channel?.(clean);
  if (sender === undefined) return openBotSegments(text);
  return [
    sender.senderId === undefined ? { text: clean } : { senderId: sender.senderId, text: clean },
  ];
}

/**
 * Route a session's messages, deciding the mode on the first one.
 *
 * @param options - The bound scope and the agent namespace template.
 * @returns {IngestRouter} The router for one session.
 */
export function createIngestRouter(options: Readonly<IngestRouterOptions>): IngestRouter {
  const { fallback, agentNamespace: template } = options;
  let mode: Mode | undefined;
  /** Who the agent last heard from, so its reply goes to the same profile. */
  let interlocutor = fallback?.profile;

  /**
   * The profile of one OpenBot segment's sender.
   *
   * @param agentsDirectory - Folder holding every agent's working directory.
   * @param senderId - Teammate's agent id, or nothing for the person.
   * @param senderName - Teammate's display name.
   * @returns {string | undefined} The profile, or nothing when the person has no profile.
   */
  function senderProfile(
    agentsDirectory: string,
    senderId: string | undefined,
    senderName: string | undefined,
  ): string | undefined {
    if (senderId === undefined) return fallback?.profile;
    const name = senderName ?? senderId;
    return (
      agentNamespace(join(agentsDirectory, senderId)) ??
      (template === undefined ? undefined : templateNamespace(template, name)) ??
      memoryName(name, MAX_TOOL_PROFILE_CHARACTERS)
    );
  }

  /**
   * Route one message of an OpenBot agent.
   *
   * @param message - The host message.
   * @param openbot - The agent's namespace and the agents' folder.
   * @returns {RoutedMessage[]} Its stretches, each to its sender's profile.
   */
  function routeOpenBot(
    message: unknown,
    openbot: Readonly<{ namespace: string; agentsDirectory: string; channel?: ChannelSenders }>,
  ): RoutedMessage[] {
    const routed: RoutedMessage[] = [];
    const { role, content, timestamp } = message as Record<string, unknown>;
    if (role !== "user") {
      if (interlocutor === undefined) return [];
      const scope = { namespace: openbot.namespace, profile: interlocutor };
      return ingestMessages(message).map((ingest) => ({ scope, message: ingest }));
    }
    for (const segment of userSegments(messageText(content), openbot.channel)) {
      const profile = senderProfile(openbot.agentsDirectory, segment.senderId, segment.senderName);
      interlocutor = profile;
      if (profile === undefined) continue;
      const scope = { namespace: openbot.namespace, profile };
      for (const ingest of ingestMessages({ role, content: segment.text, timestamp })) {
        routed.push({ scope, message: ingest });
      }
    }
    return routed;
  }

  return (message, host) => {
    mode ??= sessionMode(host, options);
    if (mode.kind === "off") return [];
    if (mode.kind === "openbot") return routeOpenBot(message, mode);
    const { scope } = mode;
    const extra = mode.fallback === undefined ? {} : { fallback: mode.fallback };
    return ingestMessages(message).map((ingest) => ({ scope, message: ingest, ...extra }));
  };
}
