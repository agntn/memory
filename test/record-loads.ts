import { writeFileSync } from "node:fs";
import { registerHooks } from "node:module";

/**
 * Every module URL Node loaded after this file, written at exit as one JSON array to the file
 * named by `MEMORY_RECORD_LOADS`. Not stderr: importing `node:util` reads `process.stderr` for
 * its ESM facade, libuv then makes a piped fd 2 non-blocking, and one `writeSync` stops where
 * the pipe is full, 146 KB here, short of the `mcp` control's report on a long checkout path.
 */
const loaded: string[] = [];
const report = process.env.MEMORY_RECORD_LOADS;
if (!report) throw new Error("MEMORY_RECORD_LOADS must name the file for the load report");

registerHooks({
  load(url, context, nextLoad) {
    loaded.push(url);
    return nextLoad(url, context);
  },
});

process.on("exit", () => {
  writeFileSync(report, JSON.stringify(loaded));
});
