import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piMemoryExtension from "../extensions/pi/memory.ts";
import {
  MemoryHttpError,
  MemoryNetworkError,
  MemoryNotFoundError,
  MemoryServerError,
} from "../src/errors.ts";
import { execFileSync } from "node:child_process";
import { ingestMessages } from "../extensions/shared/memory-ingest-turns.ts";
import { remoteMemoryScope } from "../extensions/shared/memory-project-scope.ts";
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
  it("ingests every tenth turn when nothing sets a count", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/nonexistent/agntn-memory-test");
    vi.stubEnv("AGNTN_MEMORY_NAMESPACE", "default");
    vi.stubEnv("AGNTN_MEMORY_PROFILE", "oritwoen");
    vi.stubEnv("AGNTN_MEMORY_INGEST_TURNS", "");
    const ingest = vi
      .spyOn(memoryToolExecutors, "ingest")
      .mockResolvedValue({ content: [{ type: "text", text: "submitted" }], details: {} });
    const handlers = loadPi();

    for (let turn = 0; turn < 9; turn += 1) await exchange(handlers, `turn ${turn}`, turn);
    expect(ingest).not.toHaveBeenCalled();
    await exchange(handlers, "turn 9", 9);
    await handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
    expect(ingest).toHaveBeenCalledOnce();
    expect(ingest.mock.calls[0]![0].messages).toHaveLength(20);
  });

  it("switches off with a count of 0", () => {
    vi.stubEnv("AGNTN_MEMORY_NAMESPACE", "default");
    vi.stubEnv("AGNTN_MEMORY_PROFILE", "oritwoen");
    expect(loadPi().size).toBe(0);
  });

  it("ingests into the project its remote names, upstream before origin", async () => {
    const repo = mkdtempSync(join(tmpdir(), "agntn-memory-repo-"));
    try {
      execFileSync("git", ["init", "-q", repo]);
      execFileSync("git", [
        "-C",
        repo,
        "remote",
        "add",
        "origin",
        "git@github.com:oritwoen/Fork.git",
      ]);
      execFileSync("git", [
        "-C",
        repo,
        "remote",
        "add",
        "upstream",
        "https://github.com/agntn/my.repo",
      ]);
      vi.stubEnv("PI_CODING_AGENT_DIR", "/nonexistent/agntn-memory-test");
      vi.stubEnv("AGNTN_MEMORY_NAMESPACE", "aeitwoen");
      vi.stubEnv("AGNTN_MEMORY_PROFILE", "oritwoen");
      vi.stubEnv("AGNTN_MEMORY_INGEST_TURNS", "1");
      const ingest = vi
        .spyOn(memoryToolExecutors, "ingest")
        .mockResolvedValue({ content: [{ type: "text", text: "submitted" }], details: {} });
      const handlers = loadPi();
      const inRepo = { ...ctx, cwd: repo };

      await handlers.get("message_end")!({ message: { role: "user", content: "hi" } }, inRepo);
      await handlers.get("turn_end")!({}, inRepo);
      await handlers.get("session_shutdown")!({ reason: "quit" }, inRepo);

      expect(ingest.mock.calls[0]![0]).toMatchObject({ namespace: "agntn", profile: "my-repo" });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("falls back to the bound scope when the project's namespace doesn't exist", async () => {
    const repo = mkdtempSync(join(tmpdir(), "agntn-memory-repo-"));
    try {
      execFileSync("git", ["init", "-q", repo]);
      execFileSync("git", [
        "-C",
        repo,
        "remote",
        "add",
        "origin",
        "https://github.com/oritwoen/website.git",
      ]);
      vi.stubEnv("PI_CODING_AGENT_DIR", "/nonexistent/agntn-memory-test");
      vi.stubEnv("AGNTN_MEMORY_NAMESPACE", "aeitwoen");
      vi.stubEnv("AGNTN_MEMORY_PROFILE", "oritwoen");
      vi.stubEnv("AGNTN_MEMORY_INGEST_TURNS", "1");
      const ingest = vi
        .spyOn(memoryToolExecutors, "ingest")
        .mockRejectedValueOnce(new MemoryNotFoundError("namespace 'oritwoen' not found", 404))
        .mockResolvedValue({ content: [{ type: "text", text: "submitted" }], details: {} });
      const handlers = loadPi();
      const inRepo = { ...ctx, cwd: repo };

      for (const content of ["one", "two"]) {
        await handlers.get("message_end")!({ message: { role: "user", content } }, inRepo);
        await handlers.get("turn_end")!({}, inRepo);
        await handlers.get("session_shutdown")!({ reason: "quit" }, inRepo);
      }

      expect(ingest.mock.calls.map(([params]) => `${params.namespace}/${params.profile}`)).toEqual([
        "oritwoen/website",
        "aeitwoen/oritwoen",
        "aeitwoen/oritwoen",
      ]);
      expect(notify).toHaveBeenCalledWith(
        "Memory namespace oritwoen doesn't exist, so this session ingests into aeitwoen/oritwoen. Create it with memory_namespace_create to keep oritwoen/website apart.",
        "warning",
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("ingests nothing with neither a remote nor a bound scope", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/nonexistent/agntn-memory-test");
    vi.stubEnv("AGNTN_MEMORY_INGEST_TURNS", "1");
    const ingest = vi.spyOn(memoryToolExecutors, "ingest");
    const handlers = loadPi();

    await exchange(handlers, "one", 0);
    await handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
    expect(ingest).not.toHaveBeenCalled();
  });

  it("keeps the unsent chunks after one that may have landed", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/nonexistent/agntn-memory-test");
    vi.stubEnv("AGNTN_MEMORY_NAMESPACE", "default");
    vi.stubEnv("AGNTN_MEMORY_PROFILE", "oritwoen");
    vi.stubEnv("AGNTN_MEMORY_INGEST_TURNS", "5");
    const ingest = vi
      .spyOn(memoryToolExecutors, "ingest")
      .mockRejectedValueOnce(new MemoryNetworkError("socket hang up"))
      .mockResolvedValue({ content: [{ type: "text", text: "submitted" }], details: {} });
    const handlers = loadPi();
    const messageEnd = handlers.get("message_end")!;
    for (let index = 0; index < 501; index += 1) {
      await messageEnd({ message: { role: "user", content: `m${index}` } }, ctx);
    }

    await handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
    await handlers.get("session_shutdown")!({ reason: "quit" }, ctx);

    expect(ingest.mock.calls.map(([params]) => params.messages.length)).toEqual([500, 1]);
    expect(ingest.mock.calls[1]![0].messages[0]!.content).toBe("m500");
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
      vi.stubEnv("AGNTN_MEMORY_INGEST_TURNS", "");
      expect([...loadPi().keys()]).toEqual(["message_end", "turn_end", "session_shutdown"]);
      writeFileSync(
        join(agentDir, "memory-scope.json"),
        JSON.stringify({ namespace: "default", profile: "oritwoen", ingestTurns: 0 }),
      );
      expect(loadPi().size).toBe(0);
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("takes a scope file that sets only the interval", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "agntn-memory-pi-"));
    try {
      writeFileSync(join(agentDir, "memory-scope.json"), JSON.stringify({ ingestTurns: 5 }));
      vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
      vi.stubEnv("AGNTN_MEMORY_INGEST_TURNS", "");
      const tools: string[] = [];
      piMemoryExtension({
        registerTool(tool: { name: string }) {
          tools.push(tool.name);
        },
        on() {},
      } as unknown as ExtensionAPI);
      expect(tools).toContain("memory_namespace_list");
      writeFileSync(join(agentDir, "memory-scope.json"), JSON.stringify({ namespace: "default" }));
      expect(loadPi).toThrow("must define both namespace and profile");
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("refuses a turn count that isn't a whole number", () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/nonexistent/agntn-memory-test");
    vi.stubEnv("AGNTN_MEMORY_INGEST_TURNS", "2.5");
    expect(loadPi).toThrow("AGNTN_MEMORY_INGEST_TURNS must be a whole number of turns");
  });

  it("reads owner and repository from https, ssh and scp remotes only", () => {
    expect(
      [
        "https://github.com/agntn/memory",
        "https://github.com/agntn/memory.git/",
        "ssh://git@github.com/agntn/memory.git",
        "git@github.com-aei:agntn/memory.git",
        "https://gitlab.com/Group/Sub/My_Repo.git",
        "/home/ori/Projekty/memory",
        "file:///home/ori/agntn/memory",
        "https://github.com/agntn",
      ].map((url) => remoteMemoryScope(url)),
    ).toEqual([
      { namespace: "agntn", profile: "memory" },
      { namespace: "agntn", profile: "memory" },
      { namespace: "agntn", profile: "memory" },
      { namespace: "agntn", profile: "memory" },
      { namespace: "group", profile: "my-repo" },
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("cuts a long message at the service's byte cap without splitting a character", () => {
    const chunks = ingestMessages({ role: "user", content: "ą".repeat(20_000) });
    expect(chunks.map(({ content }) => new TextEncoder().encode(content).length)).toEqual([
      32_768, 7_232,
    ]);
    expect(chunks.map(({ content }) => content).join("")).toBe("ą".repeat(20_000));
  });
});
