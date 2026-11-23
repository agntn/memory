import { dirname, join } from "node:path";
import { MAX_TOOL_PROFILE_CHARACTERS } from "./memory-tool-contract.ts";
import type { RoutedMessage } from "./memory-ingest-turns.ts";
import type { IngestParams } from "./memory-tools.types.ts";
import { ingestMessages, messageText, redactedMessage, scopeKey } from "./memory-ingest-turns.ts";
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
  /** The project each OpenBot channel ingests into, by channel id; `null` leaves one unmapped. */
  readonly openBotChannels?: ReadonlyMap<string, ProfileParams | null>;
  /** Strikes secrets after the sender is known and before a message is cut into pieces. */
  readonly redact?: (text: string) => string;
}

/** What the router reads from the host for one message. */
export interface RouteHost {
  readonly cwd: string;
  readonly sessionFile: () => string | undefined;
  readonly systemPrompt: () => string;
  readonly warn: (message: string) => void;
}

/** Sends each host message to the profile it belongs in. */
export interface IngestRouter {
  readonly route: (message: unknown, host: RouteHost) => RoutedMessage[];
  /** The project the session ingests into, if it has one. */
  readonly project: (host: RouteHost) => ProfileParams | undefined;
  /** The session's OpenBot channel when the configuration doesn't map it, else nothing. */
  readonly unmappedChannel: (host: RouteHost) => ChannelSenders | undefined;
}

type IngestMessage = IngestParams["messages"][number];

/** An OpenBot session: the agent's namespace, the agents' folder, its channel and remote project. */
interface OpenBotMode {
  readonly kind: "openbot";
  readonly namespace: string;
  readonly agentsDirectory: string;
  readonly channel?: ChannelSenders;
  /** The project the remote of the agent's folder names, if any. */
  readonly project?: ProfileParams;
}

/**
 * The agent's own scope for one speaker, when there is one.
 *
 * @param namespace - The agent's namespace.
 * @param profile - The speaker's profile, if known.
 * @returns {ProfileParams | undefined} The scope, or nothing without a profile.
 */
function personalScope(namespace: string, profile: string | undefined): ProfileParams | undefined {
  return profile === undefined ? undefined : { namespace, profile };
}

/** Namespace whose profiles collect everything one owner's projects say. */
const OWNER_NAMESPACE = "default";

/**
 * The shared profile of a project's owner: `agntn/memory` also lands in `default/agntn`.
 *
 * @param project - The project scope.
 * @returns {ProfileParams | undefined} The owner's scope, or nothing for a project already in `default`.
 */
function ownerScope(project: ProfileParams): ProfileParams | undefined {
  return project.namespace === OWNER_NAMESPACE
    ? undefined
    : { namespace: OWNER_NAMESPACE, profile: project.namespace };
}

/** The cross-cutting profile every ingested message also lands in, whatever its scope. */
const EVERYTHING_SCOPE: ProfileParams = { namespace: OWNER_NAMESPACE, profile: OWNER_NAMESPACE };

/**
 * Add a `default/default` copy of each piece no route sends there already.
 *
 * @param pieces - Pieces of one message, already cleaned of anything the host injected.
 * @param routed - Their scoped routes, which share the piece objects.
 * @returns {RoutedMessage[]} The routes, then the missing `default/default` copies.
 */
function withEverything(
  pieces: readonly Readonly<IngestMessage>[],
  routed: readonly RoutedMessage[],
): RoutedMessage[] {
  const covered = new Set(
    routed
      .filter(({ scope }) => scopeKey(scope) === scopeKey(EVERYTHING_SCOPE))
      .map(({ message }) => message),
  );
  const copies = pieces
    .filter((message) => !covered.has(message))
    .map((message) => ({ scope: EVERYTHING_SCOPE, message }));
  return [...routed, ...copies];
}

/**
 * Route messages into a project, then copy them to its owner's profile, which has no fallback.
 *
 * @param messages - Pieces of one message.
 * @param project - The project scope.
 * @param fallback - Where the project's copies go when its namespace is missing, if anywhere.
 * @returns {RoutedMessage[]} The project's copies, then the owner's.
 */
function intoProject(
  messages: readonly Readonly<IngestMessage>[],
  project: ProfileParams,
  fallback: ProfileParams | undefined,
): RoutedMessage[] {
  const routed: RoutedMessage[] = messages.map((message) =>
    fallback === undefined ? { scope: project, message } : { scope: project, message, fallback },
  );
  const owner = ownerScope(project);
  if (owner === undefined) return routed;
  return [...routed, ...messages.map((message) => ({ scope: owner, message }))];
}

/**
 * Give messages their scope: the project with the personal scope as fallback, else the personal one.
 *
 * @param messages - Pieces of one message.
 * @param personal - The speaker's scope in the agent's namespace, if any.
 * @param project - The session's project, if any.
 * @returns {RoutedMessage[]} The routed pieces, each also bound for `default/default`.
 */
function placed(
  messages: readonly Readonly<IngestMessage>[],
  personal: ProfileParams | undefined,
  project: ProfileParams | undefined,
): RoutedMessage[] {
  if (project !== undefined)
    return withEverything(messages, intoProject(messages, project, personal));
  const routed =
    personal === undefined ? [] : messages.map((message) => ({ scope: personal, message }));
  return withEverything(messages, routed);
}

/** How the conversation is split once per session. */
type Mode =
  | { readonly kind: "scope"; readonly scope?: ProfileParams }
  | { readonly kind: "project"; readonly scope: ProfileParams; readonly fallback?: ProfileParams }
  | OpenBotMode
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
 * The mode outside OpenBot: the remote's project, else the bound scope.
 *
 * @param project - Scope the remote names, if any.
 * @param fallback - The bound scope, if any.
 * @returns {Mode} The project with the bound scope as fallback, else the bound scope, if any.
 */
function plainMode(project: ProfileParams | undefined, fallback: ProfileParams | undefined): Mode {
  if (project === undefined)
    return { kind: "scope", ...(fallback === undefined ? {} : { scope: fallback }) };
  return fallback === undefined
    ? { kind: "project", scope: project }
    : { kind: "project", scope: project, fallback };
}

/**
 * Pick the session's mode: an OpenBot agent, the remote's project, or the bound scope.
 *
 * @param host - The host at the first message.
 * @param options - The bound scope and the agent namespace template.
 * @returns {Mode} How every message of the session is routed.
 */
function sessionMode(host: RouteHost, options: IngestRouterOptions): Mode {
  const { fallback } = options;
  const project = projectMemoryScope(host.cwd);
  const agent = openBotAgent(host.systemPrompt());
  if (agent === undefined) return plainMode(project, fallback);
  const namespace = openBotNamespace(host, agent.name, options.agentNamespace);
  if (namespace === undefined) return { kind: "off" };
  const agentsDirectory = dirname(host.cwd);
  const sessionFile = host.sessionFile();
  const channel =
    options.openBotDatabase === undefined || sessionFile === undefined
      ? undefined
      : openBotChannelSenders(options.openBotDatabase, sessionFile);
  return {
    kind: "openbot",
    namespace,
    agentsDirectory,
    ...(channel === undefined ? {} : { channel }),
    ...(project === undefined ? {} : { project }),
  };
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
  const sender = channel?.sender(clean);
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
  const redact = options.redact ?? ((text: string) => text);
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
   * The project an OpenBot session ingests into: a channel's from the map, else the remote's.
   *
   * @param openbot - The session's channel and remote project.
   * @returns {ProfileParams | undefined} The project, or nothing for the agent's own split.
   */
  function sessionProject(
    openbot: Readonly<{ channel?: ChannelSenders; project?: ProfileParams }>,
  ): ProfileParams | undefined {
    if (openbot.channel === undefined) return openbot.project;
    return options.openBotChannels?.get(openbot.channel.channelId) ?? undefined;
  }

  /**
   * Route one message of an OpenBot agent.
   *
   * @param message - The host message.
   * @param openbot - The agent's namespace, the agents' folder, the channel and the remote's project.
   * @returns {RoutedMessage[]} Its stretches, each to the project or its sender's profile.
   */
  function routeOpenBot(message: unknown, openbot: OpenBotMode): RoutedMessage[] {
    const project = sessionProject(openbot);
    const { role, content, timestamp } = message as Record<string, unknown>;
    if (role !== "user") {
      return placed(
        ingestMessages(redactedMessage(message, redact), openbot.namespace),
        personalScope(openbot.namespace, interlocutor),
        project,
      );
    }
    const routed: RoutedMessage[] = [];
    for (const segment of userSegments(messageText(content), openbot.channel)) {
      const profile = senderProfile(openbot.agentsDirectory, segment.senderId, segment.senderName);
      interlocutor = profile;
      const pieces = ingestMessages({ role, content: redact(segment.text), timestamp }, profile);
      routed.push(...placed(pieces, personalScope(openbot.namespace, profile), project));
    }
    return routed;
  }

  /**
   * The session's mode, decided once.
   *
   * @param host - The host at the first event.
   * @returns {Mode} How the session's messages are routed.
   */
  function sessionModeOnce(host: RouteHost): Mode {
    mode ??= sessionMode(host, options);
    return mode;
  }

  const route = (message: unknown, host: RouteHost): RoutedMessage[] => {
    const current = sessionModeOnce(host);
    if (current.kind === "off") return [];
    if (current.kind === "openbot") return routeOpenBot(message, current);
    const pieces = ingestMessages(redactedMessage(message, redact));
    if (current.kind === "project") return placed(pieces, current.fallback, current.scope);
    return placed(pieces, current.scope, undefined);
  };

  const unmappedChannel = (host: RouteHost): ChannelSenders | undefined => {
    const current = sessionModeOnce(host);
    if (current.kind !== "openbot" || current.channel === undefined) return undefined;
    return options.openBotChannels?.has(current.channel.channelId) ? undefined : current.channel;
  };

  const project = (host: RouteHost): ProfileParams | undefined => {
    const current = sessionModeOnce(host);
    if (current.kind === "project") return current.scope;
    return current.kind === "openbot" ? sessionProject(current) : undefined;
  };

  return { route, project, unmappedChannel };
}

/**
 * What an agent in an unmapped OpenBot channel is told once per session.
 *
 * @param channel - The channel the session works in.
 * @param configPath - Pi's `agntn/memory.json`.
 * @returns {string} The note.
 */
export function unmappedChannelNotice(channel: ChannelSenders, configPath: string): string {
  const name =
    channel.channelName === undefined ? "" : ` "${singleLineToolText(channel.channelName)}"`;
  return `agntn/memory: OpenBot channel${name} (${channel.channelId}) has no entry in openbotChannels in ${configPath}, so this channel's conversation is ingested under each agent and whoever it talks to. If the channel is about one project, tell the user to map the id there to namespace/profile, or to null when it has none.`;
}
