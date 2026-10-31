#!/usr/bin/env node
/** Memory CLI: a command per memory tool, and `mcp` for the stdio server. */
import { existsSync } from "node:fs";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";
import type * as McpCommand from "./commands/mcp.ts";

/** The same file from `src/cli.ts` and `dist/cli.mjs`; the npm package ships only `dist`. */
const sourceMcpCommand = new URL("../src/commands/mcp.ts", import.meta.url);
const sourceMcpCommandPath = fileURLToPath(sourceMcpCommand);

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
    existsSync(sourceMcpCommandPath)
  );
}

/**
 * Narrows the module a runtime URL import returned, which TypeScript types as `any`.
 * @param value - The imported module namespace.
 * @returns {value is typeof McpCommand} Whether it exports `serveMcp`.
 */
function isMcpModule(value: unknown): value is typeof McpCommand {
  return typeof value === "object" && value !== null && "serveMcp" in value;
}

/**
 * A checkout's bin serves live `src/`, so an edit wants a restart, not `pnpm build`.
 * @returns {Promise<typeof McpCommand>} The module that starts the stdio server.
 * @throws {TypeError} When the source file has no `serveMcp`.
 */
async function loadMcpCommand(): Promise<typeof McpCommand> {
  if (!servesSource()) return import("./commands/mcp.ts");
  const module: unknown = await import(sourceMcpCommand.href);
  if (!isMcpModule(module)) throw new TypeError(`${sourceMcpCommandPath} has no serveMcp`);
  return module;
}

const argv = process.argv.slice(2);

/** `memory mcp` serves straight away, and a stray flag from a client config doesn't stop it. */
const servesMcp = argv[0] === "mcp" && !argv.some((word) => word === "--help" || word === "-h");

if (servesMcp) {
  await (await loadMcpCommand()).serveMcp();
} else {
  await (await import("./cli-run.ts")).runMemoryCli(argv);
}
