import { execFileSync } from "node:child_process";
import {
  MAX_TOOL_NAMESPACE_CHARACTERS,
  MAX_TOOL_PROFILE_CHARACTERS,
  MEMORY_NAME_PATTERN,
} from "./memory-tool-contract.ts";
import type { ProfileParams } from "./memory-tools.types.ts";

const memoryNamePattern = new RegExp(MEMORY_NAME_PATTERN, "u");
/* `https://host/owner/repo` and `ssh://git@host/owner/repo`, never `file://`. */
const urlRemotePattern = /^(?!file:)[a-z][a-z0-9+.-]*:\/\/[^/]+\/(.+)$/iu;
/* `git@host:owner/repo`, the scp form; a local path has no host before the colon. */
const scpRemotePattern = /^(?:[^@/:]+@)?[^/:]+:(?!\/)(.+)$/u;

/* What a `repository` field may hold: one line, no spaces or bidi tricks, exactly one slash. */
const repositoryPattern = /^[^\s/\p{Cc}\p{Cf}]+\/[^\s/\p{Cc}\p{Cf}]+$/u;

/** Remotes that name the project, the fork's upstream first. */
const projectRemotes = ["upstream", "origin"] as const;

/**
 * A git name as a memory name.
 *
 * @param name - Owner or repository name.
 * @param maxLength - Longest name the service takes.
 * @returns {string | undefined} Lowercase with hyphens, or nothing when it can't be one.
 */
export function memoryName(name: string, maxLength: number): string | undefined {
  const converted = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "");
  return converted.length <= maxLength && memoryNamePattern.test(converted) ? converted : undefined;
}

/**
 * The last two path segments of a remote URL: owner and repository as spelled.
 *
 * @param url - Remote URL, https, ssh or scp form.
 * @returns {readonly [string, string] | undefined} Both segments, or nothing for a local path.
 */
function remoteSegments(url: string): readonly [string, string] | undefined {
  const trimmed = url.trim();
  const path = (urlRemotePattern.exec(trimmed) ?? scpRemotePattern.exec(trimmed))?.[1];
  const segments =
    path
      ?.replace(/(?:\.git)?\/*$/u, "")
      .split("/")
      .filter(Boolean) ?? [];
  return segments.length < 2 ? undefined : [segments.at(-2)!, segments.at(-1)!];
}

/**
 * The memory scope a remote URL names: its last two path segments, owner and repository.
 *
 * @param url - Remote URL, https, ssh or scp form.
 * @returns {ProfileParams | undefined} The scope, or nothing for a local path or odd URL.
 */
export function remoteMemoryScope(url: string): ProfileParams | undefined {
  const segments = remoteSegments(url);
  if (segments === undefined) return undefined;
  const namespace = memoryName(segments[0], MAX_TOOL_NAMESPACE_CHARACTERS);
  const profile = memoryName(segments[1], MAX_TOOL_PROFILE_CHARACTERS);
  return namespace === undefined || profile === undefined ? undefined : { namespace, profile };
}

/**
 * The `owner/repo` a remote URL names, as spelled, for a `repository` field.
 *
 * @param url - Remote URL, https, ssh or scp form.
 * @returns {string | undefined} The repository, or nothing when it isn't one clean line.
 */
export function remoteRepository(url: string): string | undefined {
  const repository = remoteSegments(url)?.join("/");
  return repository !== undefined && repositoryPattern.test(repository) ? repository : undefined;
}

/**
 * URL of one remote, or nothing outside a repository or without that remote.
 *
 * @param cwd - Directory inside the repository.
 * @param remote - Remote name.
 * @returns {string | undefined} The URL git resolves.
 */
function remoteUrl(cwd: string, remote: string): string | undefined {
  try {
    return execFileSync("git", ["-C", cwd, "remote", "get-url", remote], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
  } catch {
    return undefined;
  }
}

/**
 * The project scope of a working directory, from its `upstream` or `origin` remote.
 *
 * @param cwd - Working directory of the session.
 * @returns {ProfileParams | undefined} The scope, or nothing without a usable remote.
 */
export function projectMemoryScope(cwd: string): ProfileParams | undefined {
  for (const remote of projectRemotes) {
    const url = remoteUrl(cwd, remote);
    const scope = url === undefined ? undefined : remoteMemoryScope(url);
    if (scope !== undefined) return scope;
  }
  return undefined;
}

const repositories = new Map<string, string | undefined>();

/**
 * The `owner/repo` of a directory's `upstream` or `origin` remote, read once per directory.
 *
 * @param cwd - Working directory of the session.
 * @returns {string | undefined} The repository, or nothing without a usable remote.
 */
export function projectRepository(cwd: string): string | undefined {
  if (repositories.has(cwd)) return repositories.get(cwd);
  let repository: string | undefined;
  for (const remote of projectRemotes) {
    const url = remoteUrl(cwd, remote);
    repository = url === undefined ? undefined : remoteRepository(url);
    if (repository !== undefined) break;
  }
  repositories.set(cwd, repository);
  return repository;
}

/**
 * The repository of the `cwd` in Pi's or OMP's `ctx`, handed over as `host`.
 *
 * @param host - The host context of the call.
 * @returns {string | undefined} The repository, or nothing for a host without a working directory.
 */
export function hostRepository(host: unknown): string | undefined {
  if (typeof host !== "object" || host === null) return undefined;
  const { cwd } = host as { cwd?: unknown };
  return typeof cwd === "string" ? projectRepository(cwd) : undefined;
}
