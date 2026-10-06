import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";

const hook = resolve(import.meta.dirname, "record-loads.ts");

describe("record-loads", () => {
  it("keeps a report longer than a pipe takes at exit", () => {
    const directory = mkdtempSync(join(tmpdir(), "memory-loads-"));
    try {
      /** 600 modules of about 430 bytes after `node:util`, as the CLI loads it: a 250 KB report, past the 146 KB a piped stderr kept. */
      const modules = Array.from(
        { length: 600 },
        (_, index) => `data:text/javascript,export default ${index};//${"x".repeat(400)}`,
      );
      const script = join(directory, "load-many.mjs");
      writeFileSync(
        script,
        ['import "node:util";', ...modules.map((url) => `await import(${JSON.stringify(url)});`)]
          .map((line) => `${line}\n`)
          .join(""),
      );
      const report = join(directory, "loaded.json");
      const result = spawnSync(process.execPath, ["--import", hook, script], {
        encoding: "utf8",
        env: { ...process.env, MEMORY_RECORD_LOADS: report },
        timeout: 20_000,
      });

      expect(result.status, result.stderr).toBe(0);
      const loaded: unknown = JSON.parse(readFileSync(report, "utf8"));
      expect(loaded).toEqual([
        expect.stringMatching(/\/load-many\.mjs$/u),
        "node:util",
        ...modules,
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
