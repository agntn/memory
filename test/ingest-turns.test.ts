import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piMemoryExtension from "../extensions/pi/memory.ts";
import { MemoryHttpError, MemoryNetworkError, MemoryServerError } from "../src/errors.ts";
import { ingestMessages } from "../extensions/shared/memory-ingest-turns.ts";
import { memoryToolExecutors } from "../extensions/shared/memory-tools.ts";

vi.mock("@earendil-works/pi-tui", () => ({ Text: class Text {} }));

type Handler = (event: unknown, ctx: unknown) => unknown;

afterEach(() => {
  notify.mockClear();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/* Load the Pi extension and keep the event handlers it registers. */
function loadPi(): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  piMemoryExtension({
    registerTool() {},
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI);
  return handlers;
}

const notify = vi.fn();
const ctx = {
  cwd: "/workspace/movie-enigma",
  sessionManager: { getSessionId: () => "pi-session-123" },
  ui: { notify },
};

/* Replay one exchange: the user's prompt, an assistant reply with a tool call, its result. */
async function exchange(handlers: Map<string, Handler>, prompt: string, at: number) {
  const messageEnd = handlers.get("message_end")!;
  await messageEnd({ message: { role: "user", content: prompt, timestamp: at } }, ctx);
  await messageEnd(
    {
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hidden" },
          { type: "text", text: `re: ${prompt}` },
          { type: "toolCall", id: "t", name: "read", arguments: {} },
        ],
        timestamp: at + 1,
      },
    },
    ctx,
  );
  await messageEnd({ message: { role: "toolResult", content: "file body", timestamp: at } }, ctx);
  await handlers.get("turn_end")!({}, ctx);
}

describe("Pi turn ingest", () => {
  it("stays off until a turn count is set", () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/nonexistent/agntn-memory-test");
    vi.stubEnv("AGNTN_MEMORY_NAMESPACE", "default");
    vi.stubEnv("AGNTN_MEMORY_PROFILE", "oritwoen");
    expect(loadPi().size).toBe(0);
  });

  it("ingests the new messages every second turn and the rest on shutdown", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/nonexistent/agntn-memory-test");
    vi.stubEnv("AGNTN_MEMORY_NAMESPACE", "default");
    vi.stubEnv("AGNTN_MEMORY_PROFILE", "oritwoen");
    vi.stubEnv("AGNTN_MEMORY_INGEST_TURNS", "2");
    const ingest = vi
      .spyOn(memoryToolExecutors, "ingest")
      .mockResolvedValue({ content: [{ type: "text", text: "submitted" }], details: {} });
    const handlers = loadPi();

    await exchange(handlers, "one", 0);
    expect(ingest).not.toHaveBeenCalled();
    await exchange(handlers, "two", 1_000);
    await exchange(handlers, "three", 2_000);
    await handlers.get("session_shutdown")!({ reason: "quit" }, ctx);

    const sessionId = expect.stringMatching(/^pi-movie-enigma-[0-9a-f]{16}$/);
    expect(ingest.mock.calls.map(([params]) => params)).toEqual([
      {
        namespace: "default",
        profile: "oritwoen",
        sessionId,
        messages: [
          { role: "user", content: "one", timestamp: "1970-01-01T00:00:00.000Z" },
          { role: "assistant", content: "re: one", timestamp: "1970-01-01T00:00:00.001Z" },
          { role: "user", content: "two", timestamp: "1970-01-01T00:00:01.000Z" },
          { role: "assistant", content: "re: two", timestamp: "1970-01-01T00:00:01.001Z" },
        ],
      },
      {
        namespace: "default",
        profile: "oritwoen",
        sessionId,
        messages: [
          { role: "user", content: "three", timestamp: "1970-01-01T00:00:02.000Z" },
          { role: "assistant", content: "re: three", timestamp: "1970-01-01T00:00:02.001Z" },
        ],
      },
    ]);
  });

  it("sends a refused batch again on the next try", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/nonexistent/agntn-memory-test");
    vi.stubEnv("AGNTN_MEMORY_NAMESPACE", "default");
    vi.stubEnv("AGNTN_MEMORY_PROFILE", "oritwoen");
    vi.stubEnv("AGNTN_MEMORY_INGEST_TURNS", "1");
    const ingest = vi
      .spyOn(memoryToolExecutors, "ingest")
      .mockRejectedValueOnce(new MemoryServerError("Cloudflare answered\u001B[2J 503", 503))
      .mockResolvedValue({ content: [{ type: "text", text: "submitted" }], details: {} });
    const handlers = loadPi();

    await exchange(handlers, "one", 0);
    await handlers.get("session_shutdown")!({ reason: "quit" }, ctx);

    expect(notify).toHaveBeenCalledWith(
      "Memory ingest failed, 2 messages wait for the next try: Cloudflare answered [2J 503",
      "warning",
    );
    expect(ingest).toHaveBeenCalledTimes(2);
    expect(ingest.mock.calls[1]![0].messages.map(({ content }) => content)).toEqual([
      "one",
      "re: one",
    ]);
  });

  it("never sends a batch twice when it may have landed", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/nonexistent/agntn-memory-test");
    vi.stubEnv("AGNTN_MEMORY_NAMESPACE", "default");
    vi.stubEnv("AGNTN_MEMORY_PROFILE", "oritwoen");
    vi.stubEnv("AGNTN_MEMORY_INGEST_TURNS", "1");
    const ingest = vi
      .spyOn(memoryToolExecutors, "ingest")
      .mockRejectedValueOnce(new MemoryNetworkError("socket hang up"))
      .mockRejectedValueOnce(new MemoryHttpError("unreadable 200", 200))
      .mockResolvedValue({ content: [{ type: "text", text: "submitted" }], details: {} });
    const handlers = loadPi();

    await exchange(handlers, "one", 0);
    await handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
    await exchange(handlers, "two", 1_000);
    await handlers.get("session_shutdown")!({ reason: "quit" }, ctx);

    expect(ingest).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledWith(
      "Memory ingest may have landed, so 2 messages won't be sent again: socket hang up",
      "warning",
    );
  });

  it("says a batch refused on shutdown is gone", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/nonexistent/agntn-memory-test");
    vi.stubEnv("AGNTN_MEMORY_NAMESPACE", "default");
    vi.stubEnv("AGNTN_MEMORY_PROFILE", "oritwoen");
    vi.stubEnv("AGNTN_MEMORY_INGEST_TURNS", "5");
    vi.spyOn(memoryToolExecutors, "ingest").mockRejectedValue(new MemoryServerError("down", 503));
    const handlers = loadPi();

    await exchange(handlers, "one", 0);
    await handlers.get("session_shutdown")!({ reason: "quit" }, ctx);

    expect(notify).toHaveBeenCalledWith(
      "Memory ingest failed, 2 messages were not ingested: down",
      "warning",
    );
  });

  it("reads ingestTurns from Pi's scope file", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "agntn-memory-pi-"));
    try {
      writeFileSync(
        join(agentDir, "memory-scope.json"),
        JSON.stringify({ namespace: "default", profile: "oritwoen", ingestTurns: 5 }),
      );
      vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
      expect([...loadPi().keys()]).toEqual(["message_end", "turn_end", "session_shutdown"]);
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("refuses a turn count without a scope or a whole number", () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/nonexistent/agntn-memory-test");
    vi.stubEnv("AGNTN_MEMORY_INGEST_TURNS", "3");
    expect(loadPi).toThrow("AGNTN_MEMORY_INGEST_TURNS needs a memory scope to ingest into");
    vi.stubEnv("AGNTN_MEMORY_INGEST_TURNS", "2.5");
    expect(loadPi).toThrow("AGNTN_MEMORY_INGEST_TURNS must be a whole number of turns");
  });

  it("cuts a long message at the service's byte cap without splitting a character", () => {
    const chunks = ingestMessages({ role: "user", content: "ą".repeat(20_000) });
    expect(chunks.map(({ content }) => new TextEncoder().encode(content).length)).toEqual([
      32_768, 7_232,
    ]);
    expect(chunks.map(({ content }) => content).join("")).toBe("ą".repeat(20_000));
  });
});
