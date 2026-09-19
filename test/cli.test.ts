import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const cli = resolve(root, "src/cli.ts");
const hook = resolve(root, "test/record-loads.ts");

/**
 * Run `src/cli.ts` under the load hook, not the built bin: Publish runs the suite before any build.
 * citty exits the process itself, so the hook reports at exit, into a file owned by this call.
 */
function runCli(args: readonly string[], input?: string) {
  const directory = mkdtempSync(join(tmpdir(), "memory-loads-"));
  const report = join(directory, "loaded.json");
  try {
    const result = spawnSync(process.execPath, ["--import", hook, cli, ...args], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, MEMORY_RECORD_LOADS: report },
      input,
      timeout: 20_000,
    });
    expect(existsSync(report), `the load hook wrote no report:\n${result.stderr}`).toBe(true);
    const loaded: unknown = JSON.parse(readFileSync(report, "utf8"));
    expect(Array.isArray(loaded)).toBe(true);
    return { ...result, loaded: (loaded as unknown[]).map(String) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** pnpm's store paths carry peer hashes in their names, so only the package directory itself counts. */
function loadedFrom(loaded: readonly string[], directory: string): string[] {
  return loaded.filter((url) => url.includes(directory));
}

describe("memory usage paths", () => {
  it.each([
    { args: ["--help"], status: 0 },
    { args: ["-h"], status: 0 },
    { args: ["mcp", "--help"], status: 0 },
    { args: ["no-such-command"], status: 1 },
  ])("memory $args prints the usage without the server", ({ args, status }) => {
    const result = runCli(args);

    expect(result.status).toBe(status);
    expect(result.stdout).toMatch(/USAGE.*memory mcp/u);
    expect(result.loaded.some((url) => url.endsWith("/src/commands/mcp.ts"))).toBe(true);
    expect(loadedFrom(result.loaded, "/node_modules/@modelcontextprotocol/")).toEqual([]);
    expect(loadedFrom(result.loaded, "/node_modules/typebox/")).toEqual([]);
    expect(result.loaded.filter((url) => url.endsWith("/src/mcp.ts"))).toEqual([]);
    expect(loadedFrom(result.loaded, "/packages/shared/")).toEqual([]);
  });

  it("memory mcp serves the server over stdio", () => {
    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "memory-test", version: "1.0.0" },
      },
    };
    const result = runCli(["mcp"], `${JSON.stringify(initialize)}\n`);

    expect(result.status).toBe(0);
    const response: unknown = JSON.parse(result.stdout.trim().split("\n")[0] ?? "");
    expect(response).toMatchObject({ id: 1, result: { serverInfo: { name: "memory" } } });
    expect(loadedFrom(result.loaded, "/node_modules/@modelcontextprotocol/")).not.toEqual([]);
  });
});
