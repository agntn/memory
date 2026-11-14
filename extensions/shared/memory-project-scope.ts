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
 * The memory scope a remote URL names: its owner as namespace, its repository as profile.
 *
 * @param url - Remote URL, https, ssh or scp form.
 * @returns {ProfileParams | undefined} The scope, or nothing for a local path or odd URL.
 */
export function remoteMemoryScope(url: string): ProfileParams | undefined {
  const trimmed = url.trim();
  const path = (urlRemotePattern.exec(trimmed) ?? scpRemotePattern.exec(trimmed))?.[1];
  const segments =
    path
      ?.replace(/(?:\.git)?\/*$/u, "")
      .split("/")
      .filter(Boolean) ?? [];
  if (segments.length < 2) return undefined;
  const namespace = memoryName(segments[0]!, MAX_TOOL_NAMESPACE_CHARACTERS);
  const profile = memoryName(segments.at(-1)!, MAX_TOOL_PROFILE_CHARACTERS);
  return namespace === undefined || profile === undefined ? undefined : { namespace, profile };
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
