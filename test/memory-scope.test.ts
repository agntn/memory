import { createHash } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import { memorySessionId } from "../extensions/shared/memory-scope.ts";

describe("memorySessionId", () => {
  it.each([
    ["claude", "/workspace/movie-enigma", "conversation-123"],
    ["pi", "/workspace/zażółć-gęślą-jaźń", ""],
    ["omp", "/", "\uD800 lone surrogate"],
    ["grok", "/workspace/😀", "a".repeat(64)],
  ])("keeps the %s digest byte for byte with node:crypto", (harness, cwd, conversationId) => {
    const oracle = createHash("sha256")
      .update(`${harness}\0${cwd}\0${conversationId}`)
      .digest("hex")
      .slice(0, 16);

    expect(memorySessionId(harness, cwd, conversationId).slice(-16)).toBe(oracle);
  });
});
