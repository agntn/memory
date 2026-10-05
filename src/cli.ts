#!/usr/bin/env node
import { existsSync } from "node:fs";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";
import { defineCommand, runMain } from "citty";
import type McpCommand from "./commands/mcp.ts";
import { version } from "./version.ts";

/** The same file from `src/cli.ts` and `dist/cli.mjs`; the npm package ships only `dist`. */
const sourceMcpCommand = new URL("../src/commands/mcp.ts", import.meta.url);
const sourceMcpCommandPath = fileURLToPath(sourceMcpCommand);

/**
 * typebox is the one devDependency `src/` loads, and the bundle carries its own copy.
 * @returns {boolean} Whether typebox resolves from this file.
 */
function resolvesTypebox(): boolean {
  try {
    import.meta.resolve("typebox");
    return true;
  } catch {
    return false;
  }
}

/**
 * Node won't strip types under `node_modules` or with stripping off, and `MEMORY_DIST=1` opts out.
 * @returns {boolean} Whether the `mcp` command should come from `src/`.
 */
function servesSource(): boolean {
  return (
    !import.meta.url.endsWith(".ts") &&
    process.env.MEMORY_DIST !== "1" &&
    Boolean(process.features.typescript) &&
    !sourceMcpCommandPath.includes(`${sep}node_modules${sep}`) &&
    existsSync(sourceMcpCommandPath) &&
    resolvesTypebox()
  );
}

/**
 * Narrows the module a runtime URL import returned, which TypeScript types as `any`.
 * @param value - The imported module namespace.
 * @returns {value is { default: typeof McpCommand }} Whether it exports a default command.
 */
function isCommandModule(value: unknown): value is { default: typeof McpCommand } {
  return typeof value === "object" && value !== null && "default" in value;
}

/**
 * A checkout's bin serves live `src/`, so an edit wants a restart, not `pnpm build`.
 * @returns {Promise<typeof McpCommand>} The citty command that starts the stdio server.
 * @throws {TypeError} When the source file has no default export.
 */
async function loadMcpCommand(): Promise<typeof McpCommand> {
  if (!servesSource()) return (await import("./commands/mcp.ts")).default;
  const module: unknown = await import(sourceMcpCommand.href);
  if (!isCommandModule(module)) {
    throw new TypeError(`${sourceMcpCommandPath} has no default command`);
  }
  return module.default;
}

const main = defineCommand({
  meta: {
    name: "memory",
    version,
    description: "Agent memory CLI",
  },
  subCommands: {
    mcp: loadMcpCommand,
  },
});

await runMain(main);
