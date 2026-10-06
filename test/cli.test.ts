import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vite-plus/test";

const root = resolve(import.meta.dirname, "..");
const cli = resolve(root, "src/cli.ts");
const bin = resolve(root, "dist/cli.mjs");
const hook = resolve(root, "test/record-loads.ts");

const { MEMORY_DIST: _inherited, ...environment } = process.env;

const initialize = `${JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "memory-test", version: "1.0.0" },
  },
})}\n`;

/**
 * Run a CLI entry under the load hook. citty exits on its own, so the hook reports at exit.
 */
function runCli(
  args: readonly string[],
  options: Readonly<{
    entry?: string;
    env?: Readonly<Record<string, string>>;
    input?: string;
  }> = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "memory-loads-"));
  const report = join(directory, "loaded.json");
  try {
    const result = spawnSync(process.execPath, ["--import", hook, options.entry ?? cli, ...args], {
      cwd: root,
      encoding: "utf8",
      env: { ...environment, ...options.env, MEMORY_RECORD_LOADS: report },
      input: options.input,
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

/** The server name from the first line `memory mcp` answered, or undefined without a reply. */
function serverName(stdout: string): unknown {
  const line = stdout.trim().split("\n")[0];
  if (!line) return undefined;
  const response: unknown = JSON.parse(line);
  return (response as { result?: { serverInfo?: { name?: unknown } } }).result?.serverInfo?.name;
}

/** Which copy of the server a run of the bin in `base` loaded, judged by its `src/mcp.ts`. */
function servedFrom(loaded: readonly string[], base: string): "bundle" | "source" {
  return loaded.includes(pathToFileURL(join(base, "src/mcp.ts")).href) ? "source" : "bundle";
}

/** Copy the named package entries into a fresh directory, run `check` on it, then remove it. */
function withCopy(parent: string, entries: readonly string[], check: (copy: string) => void) {
  mkdirSync(parent, { recursive: true });
  const copy = mkdtempSync(join(parent, "memory-cli-"));
  try {
    for (const entry of entries) cpSync(join(root, entry), join(copy, entry), { recursive: true });
    check(copy);
  } finally {
    rmSync(copy, { recursive: true, force: true });
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
    const result = runCli(["mcp"], { input: initialize });

    expect(result.status).toBe(0);
    expect(serverName(result.stdout)).toBe("memory");
    expect(loadedFrom(result.loaded, "/node_modules/@modelcontextprotocol/")).not.toEqual([]);
  });
});

describe.skipIf(!existsSync(bin))("memory mcp from the built bin", () => {
  it("serves the live source inside a checkout", () => {
    const result = runCli(["mcp"], { entry: bin, input: initialize });

    expect(result.status).toBe(0);
    expect(serverName(result.stdout)).toBe("memory");
    expect(servedFrom(result.loaded, root)).toBe("source");
  });

  it("keeps the bundle under MEMORY_DIST=1", () => {
    const result = runCli(["mcp"], { entry: bin, env: { MEMORY_DIST: "1" }, input: initialize });

    expect(result.status).toBe(0);
    expect(serverName(result.stdout)).toBe("memory");
    expect(servedFrom(result.loaded, root)).toBe("bundle");
  });

  /** No load hook here, it's TypeScript too. A reply is proof enough, since `src/` can't load. */
  it("keeps the bundle when Node does not strip types", () => {
    const result = spawnSync(process.execPath, ["--no-strip-types", bin, "mcp"], {
      cwd: root,
      encoding: "utf8",
      env: environment,
      input: initialize,
      timeout: 20_000,
    });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(serverName(result.stdout)).toBe("memory");
  });

  it("keeps the bundle when the package sits under node_modules", () => {
    withCopy(
      join(root, "node_modules/.cache"),
      ["dist", "src", "packages", "package.json"],
      (copy) => {
        const result = runCli(["mcp"], { entry: join(copy, "dist/cli.mjs"), input: initialize });

        expect(result.status).toBe(0);
        expect(serverName(result.stdout)).toBe("memory");
        expect(servedFrom(result.loaded, copy)).toBe("bundle");
      },
    );
  });

  it("keeps the bundle in a package that ships no src", () => {
    withCopy(tmpdir(), ["dist", "packages", "package.json"], (copy) => {
      symlinkSync(join(root, "node_modules"), join(copy, "node_modules"), "dir");
      const result = runCli(["mcp"], { entry: join(copy, "dist/cli.mjs"), input: initialize });

      expect(result.status).toBe(0);
      expect(serverName(result.stdout)).toBe("memory");
    });
  });

  it("keeps the bundle in a checkout installed without devDependencies", () => {
    withCopy(tmpdir(), ["dist", "src", "packages", "package.json"], (copy) => {
      const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>;
      };
      for (const name of Object.keys(manifest.dependencies ?? {})) {
        mkdirSync(join(copy, "node_modules", name, ".."), { recursive: true });
        symlinkSync(join(root, "node_modules", name), join(copy, "node_modules", name), "dir");
      }
      const result = runCli(["mcp"], { entry: join(copy, "dist/cli.mjs"), input: initialize });

      expect(result.status).toBe(0);
      expect(serverName(result.stdout)).toBe("memory");
      expect(servedFrom(result.loaded, copy)).toBe("bundle");
    });
  });
});
