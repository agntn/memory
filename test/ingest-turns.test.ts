import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { createTurnIngest, ingestMessages } from "../extensions/shared/memory-ingest-turns.ts";
import { configuredPiOpenBotChannels } from "../extensions/shared/memory-scope.ts";
import { DatabaseSync } from "node:sqlite";
import { openBotDatabasePath, openBotSegments } from "../extensions/shared/memory-openbot.ts";
import { createIngestRouter } from "../extensions/shared/memory-ingest-routes.ts";
import { remoteMemoryScope, remoteRepository } from "../extensions/shared/memory-project-scope.ts";
import { memoryToolExecutors } from "../extensions/shared/memory-tools.ts";

vi.mock("@earendil-works/pi-tui", () => ({ Text: class Text {} }));

type Handler = (event: unknown, ctx: unknown) => unknown;

/* Message content as the ingest sends it: the text, then its author when the host knows one. */
const stamped = (text: string, author?: string) =>
  author === undefined ? text : `${text}\n\nauthor: ${author}`;

type IngestSpy = { mock: { calls: Parameters<typeof memoryToolExecutors.ingest>[] } };

/* Calls outside `default/default`, the copy every message also gets, for tests about the scope. */
const scoped = (spy: IngestSpy) =>
  spy.mock.calls.filter(
    ([params]) => `${params.namespace}/${params.profile}` !== "default/default",
  );

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
  sessionManager: { getSessionId: () => "pi-session-123", getSessionFile: () => undefined },
  ui: { notify },
  getSystemPrompt: () => "You are Pi.",
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

/* What the agent reads when the project's namespace isn't there. */
const MISSING_ACME =
  "agntn/memory: namespace acme doesn't exist, so this session's conversation can't be ingested into acme/widgets. Create it with memory_namespace_create and the next ingest goes there.";

/* A checkout whose origin names a project nobody made a namespace for. */
function widgetsRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "agntn-memory-repo-"));
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", "https://github.com/acme/widgets"]);
  return repo;
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
    expect(scoped(ingest)).toHaveLength(1);
    expect(scoped(ingest)[0]![0].messages).toHaveLength(20);
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

      expect(scoped(ingest).map(([params]) => `${params.namespace}/${params.profile}`)).toEqual([
        "agntn/my-repo",
        "default/agntn",
      ]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("copies a project's turns to its owner in default, one run each", async () => {
    const ingest = vi
      .spyOn(memoryToolExecutors, "ingest")
      .mockResolvedValue({ content: [{ type: "text", text: "submitted" }], details: {} });
    const host = (cwd: string) => ({
      cwd,
      sessionFile: () => undefined,
      systemPrompt: () => "",
      warn: () => {},
    });
    const repo = mkdtempSync(join(tmpdir(), "agntn-memory-repo-"));
    try {
      execFileSync("git", ["init", "-q", repo]);
      execFileSync("git", [
        "-C",
        repo,
        "remote",
        "add",
        "origin",
        "https://github.com/danielroe/forges.git",
      ]);
      const turns = createTurnIngest(50);
      const router = createIngestRouter({});
      for (const content of ["one", "two"]) {
        turns.add(router.route({ role: "user", content }, host(repo)));
      }
      await turns.flush({ warn: notify });
      execFileSync("git", [
        "-C",
        repo,
        "remote",
        "set-url",
        "origin",
        "https://github.com/default/x.git",
      ]);
      const own = createIngestRouter({});
      turns.add(own.route({ role: "user", content: "three" }, host(repo)));
      await turns.flush({ warn: notify });

      expect(
        scoped(ingest).map(([params]) => [
          `${params.namespace}/${params.profile}`,
          params.messages.map(({ content }) => content),
        ]),
      ).toEqual([
        ["danielroe/forges", ["one", "two"]],
        ["default/danielroe", ["one", "two"]],
        ["default/x", ["three"]],
      ]);
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

      expect(scoped(ingest).map(([params]) => `${params.namespace}/${params.profile}`)).toEqual([
        "oritwoen/website",
        "aeitwoen/oritwoen",
        "default/oritwoen",
        "aeitwoen/oritwoen",
        "default/oritwoen",
      ]);
      expect(notify).toHaveBeenCalledWith(
        "Memory namespace oritwoen doesn't exist, so oritwoen/website goes to aeitwoen/oritwoen until it does.",
        "warning",
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("tells the agent about a missing project namespace on its first run", async () => {
    const repo = widgetsRepo();
    try {
      vi.stubEnv("AGNTN_MEMORY_NAMESPACE", "notes");
      vi.stubEnv("AGNTN_MEMORY_PROFILE", "main");
      vi.stubEnv("AGNTN_MEMORY_INGEST_TURNS", "1");
      const getNamespace = vi
        .spyOn(memoryToolExecutors, "getNamespace")
        .mockRejectedValue(new MemoryNotFoundError("namespace 'acme' not found", 404));
      vi.spyOn(memoryToolExecutors, "ingest").mockRejectedValue(
        new MemoryNotFoundError("namespace 'acme' not found", 404),
      );
      const handlers = loadPi();
      const inRepo = { ...ctx, cwd: repo };
      const start = handlers.get("before_agent_start")!;

      await handlers.get("session_start")!({ reason: "startup" }, inRepo);
      expect(await start({}, inRepo)).toEqual({
        message: { customType: "agntn-memory", content: MISSING_ACME, display: true },
      });
      expect(getNamespace.mock.calls.map(([params]) => params)).toEqual([{ namespace: "acme" }]);

      await handlers.get("message_end")!({ message: { role: "user", content: "one" } }, inRepo);
      await handlers.get("session_shutdown")!({ reason: "quit" }, inRepo);
      expect(notify).toHaveBeenCalledWith(
        "Memory namespace acme doesn't exist, so acme/widgets goes to notes/main until it does.",
        "warning",
      );
      expect(await start({}, inRepo)).toBeUndefined();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("holds the first run five seconds for the answer, then tells the agent on the next", async () => {
    const repo = widgetsRepo();
    try {
      vi.stubEnv("AGNTN_MEMORY_INGEST_TURNS", "1");
      const lookup = Promise.withResolvers<never>();
      vi.spyOn(memoryToolExecutors, "getNamespace").mockReturnValue(lookup.promise);
      const inRepo = { ...ctx, cwd: repo };
      const start = loadPi().get("before_agent_start")!;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

      const first = Promise.resolve(start({}, inRepo));
      await vi.advanceTimersByTimeAsync(4999);
      const early = await Promise.race([first, Promise.resolve("still waiting")]);
      await vi.advanceTimersByTimeAsync(1);
      expect([early, await first]).toEqual(["still waiting", undefined]);

      lookup.reject(new MemoryNotFoundError("namespace 'acme' not found", 404));
      await vi.advanceTimersByTimeAsync(0);
      expect(await start({}, inRepo)).toEqual({
        message: { customType: "agntn-memory", content: MISSING_ACME, display: true },
      });
      expect(await start({}, inRepo)).toBeUndefined();
    } finally {
      vi.useRealTimers();
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it.each([
    ["exists", () => Promise.resolve({ content: [], details: {} })],
    ["can't be checked", () => Promise.reject(new MemoryServerError("down", 503))],
  ])("says nothing when the project's namespace %s", async (_case, answer) => {
    const repo = widgetsRepo();
    try {
      vi.stubEnv("AGNTN_MEMORY_INGEST_TURNS", "1");
      const getNamespace = vi.spyOn(memoryToolExecutors, "getNamespace").mockImplementation(answer);
      const inRepo = { ...ctx, cwd: repo };
      const start = loadPi().get("before_agent_start")!;

      expect(await start({}, inRepo)).toBeUndefined();
      expect(getNamespace).toHaveBeenCalledTimes(1);
      expect(await start({}, inRepo)).toBeUndefined();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("goes back to the project once the agent creates its namespace", async () => {
    const repo = widgetsRepo();
    try {
      vi.stubEnv("AGNTN_MEMORY_NAMESPACE", "notes");
      vi.stubEnv("AGNTN_MEMORY_PROFILE", "main");
      vi.stubEnv("AGNTN_MEMORY_INGEST_TURNS", "1");
      let exists = false;
      const ingest = vi.spyOn(memoryToolExecutors, "ingest").mockImplementation(async (params) => {
        if (params.namespace === "acme" && !exists)
          throw new MemoryNotFoundError("namespace 'acme' not found", 404);
        return { content: [{ type: "text", text: "submitted" }], details: {} };
      });
      const handlers = loadPi();
      const inRepo = { ...ctx, cwd: repo };
      const said = async (content: string) => {
        await handlers.get("message_end")!({ message: { role: "user", content } }, inRepo);
        await handlers.get("session_shutdown")!({ reason: "quit" }, inRepo);
        return scoped(ingest)
          .splice(0)
          .map(([params]) => `${params.namespace}/${params.profile}`);
      };
      const result = async (toolName: string, isError: boolean) =>
        handlers.get("tool_result")!({ toolName, isError, input: { namespace: "acme" } }, inRepo);
      const note = {
        message: { customType: "agntn-memory", content: MISSING_ACME, display: true },
      };
      const start = handlers.get("before_agent_start")!;

      expect(await said("one")).toEqual(["acme/widgets", "notes/main", "default/acme"]);
      expect(await start({}, inRepo)).toEqual(note);
      await result("memory_namespace_create", true);
      await result("memory_namespace_get", false);
      ingest.mockClear();
      expect(await said("two")).toEqual(["notes/main", "default/acme"]);

      await result("memory_namespace_create", false);
      ingest.mockClear();
      expect(await said("three")).toEqual(["acme/widgets", "notes/main", "default/acme"]);
      expect(await start({}, inRepo)).toEqual(note);

      exists = true;
      await result("memory_namespace_create", false);
      ingest.mockClear();
      expect(await said("four")).toEqual(["acme/widgets", "default/acme"]);
      expect(await start({}, inRepo)).toBeUndefined();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("drops the note for a namespace the agent created before reading it", async () => {
    const repo = widgetsRepo();
    try {
      vi.stubEnv("AGNTN_MEMORY_NAMESPACE", "notes");
      vi.stubEnv("AGNTN_MEMORY_PROFILE", "main");
      vi.stubEnv("AGNTN_MEMORY_INGEST_TURNS", "1");
      vi.spyOn(memoryToolExecutors, "ingest").mockRejectedValueOnce(
        new MemoryNotFoundError("namespace 'acme' not found", 404),
      );
      const handlers = loadPi();
      const inRepo = { ...ctx, cwd: repo };

      await handlers.get("message_end")!({ message: { role: "user", content: "one" } }, inRepo);
      await handlers.get("session_shutdown")!({ reason: "quit" }, inRepo);
      await handlers.get("tool_result")!(
        { toolName: "memory_namespace_create", isError: false, input: { namespace: "acme" } },
        inRepo,
      );
      expect(await handlers.get("before_agent_start")!({}, inRepo)).toBeUndefined();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("sends a batch again when its namespace was created while the 404 was on its way", async () => {
    const refusal = Promise.withResolvers<never>();
    const ingest = vi
      .spyOn(memoryToolExecutors, "ingest")
      .mockReturnValueOnce(refusal.promise)
      .mockResolvedValue({ content: [{ type: "text", text: "submitted" }], details: {} });
    const onMissing = vi.fn();
    const turns = createTurnIngest(50, { onMissing });
    const scope = { namespace: "acme", profile: "widgets" };
    const fallback = { namespace: "notes", profile: "main" };
    turns.add([{ scope, message: { role: "user", content: "one" }, fallback }]);

    const flushed = turns.flush({ warn: notify });
    await vi.waitFor(() => {
      expect(ingest).toHaveBeenCalledTimes(1);
    });
    turns.created("acme");
    refusal.reject(new MemoryNotFoundError("namespace 'acme' not found", 404));
    await flushed;

    expect(ingest.mock.calls.map(([params]) => `${params.namespace}/${params.profile}`)).toEqual([
      "acme/widgets",
      "acme/widgets",
    ]);
    expect([onMissing.mock.calls, notify.mock.calls]).toEqual([[], []]);
  });

  it("sends to default/default alone with neither a remote nor a bound scope", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/nonexistent/agntn-memory-test");
    vi.stubEnv("AGNTN_MEMORY_INGEST_TURNS", "1");
    const ingest = vi
      .spyOn(memoryToolExecutors, "ingest")
      .mockResolvedValue({ content: [{ type: "text", text: "submitted" }], details: {} });
    const handlers = loadPi();

    await exchange(handlers, "one", 0);
    await handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
    expect(
      ingest.mock.calls.map(([params]) => [
        `${params.namespace}/${params.profile}`,
        params.messages.map(({ content }) => content),
      ]),
    ).toEqual([["default/default", [stamped("one"), stamped("re: one")]]]);
  });

  it("keeps OpenBot's injected blocks out of default/default too", () => {
    const agents = mkdtempSync(join(tmpdir(), "agntn-memory-openbot-"));
    try {
      const cwd = join(agents, "agent-rhea");
      mkdirSync(join(cwd, ".pi", "agntn"), { recursive: true });
      writeFileSync(
        join(cwd, ".pi", "agntn", "memory.json"),
        JSON.stringify({ namespace: "rheatwoen" }),
      );
      const host = {
        cwd,
        sessionFile: () => undefined,
        systemPrompt: () => '<agent_profile>\n{"id":"agent-rhea","name":"Rhea"}\n</agent_profile>',
        warn: () => {},
      };
      const blocks = "<openbot_saved_memories>\nold fact\n</openbot_saved_memories>";
      const route = (content: string) =>
        createIngestRouter({})
          .route({ role: "user", content }, host)
          .map(({ scope, message }) => [`${scope.namespace}/${scope.profile}`, message.content]);

      expect(route(blocks)).toEqual([]);
      expect(route(`${blocks}\nShip it`)).toEqual([["default/default", "Ship it"]]);
    } finally {
      rmSync(agents, { recursive: true, force: true });
    }
  });

  it.each([
    ["default/default", ["agntn/memory", "default/default", "default/agntn"]],
    ["default/agntn", ["agntn/memory", "default/agntn", "default/default"]],
  ])(
    "sends a message once when the fallback %s is a profile it already goes to",
    async (bound, targets) => {
      const ingest = vi
        .spyOn(memoryToolExecutors, "ingest")
        .mockRejectedValueOnce(new MemoryNotFoundError("namespace 'agntn' not found", 404))
        .mockResolvedValue({ content: [{ type: "text", text: "submitted" }], details: {} });
      const repo = mkdtempSync(join(tmpdir(), "agntn-memory-repo-"));
      try {
        execFileSync("git", ["init", "-q", repo]);
        execFileSync("git", [
          "-C",
          repo,
          "remote",
          "add",
          "origin",
          "https://github.com/agntn/memory.git",
        ]);
        const host = {
          cwd: repo,
          sessionFile: () => undefined,
          systemPrompt: () => "",
          warn: () => {},
        };
        const [namespace, profile] = bound.split("/") as [string, string];
        const router = createIngestRouter({ fallback: { namespace, profile } });
        const turns = createTurnIngest(50);
        for (const content of ["one", "two"])
          turns.add(router.route({ role: "user", content }, host));
        await turns.flush({ warn: notify });
        turns.add(router.route({ role: "user", content: "three" }, host));
        await turns.flush({ warn: notify });

        expect(
          ingest.mock.calls.map(([params]) => [
            `${params.namespace}/${params.profile}`,
            params.messages.map(({ content }) => content),
          ]),
        ).toEqual([
          [targets[0], ["one", "two"]],
          [targets[1], ["one", "two"]],
          [targets[2], ["one", "two"]],
          [targets[1], ["three"]],
          [targets[2], ["three"]],
        ]);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    },
  );

  it("copies every message to default/default once, after the scoped runs", async () => {
    const ingest = vi
      .spyOn(memoryToolExecutors, "ingest")
      .mockResolvedValue({ content: [{ type: "text", text: "submitted" }], details: {} });
    const turns = createTurnIngest(50);
    const host = {
      cwd: "/nonexistent",
      sessionFile: () => undefined,
      systemPrompt: () => "",
      warn: () => {},
    };
    for (const fallback of [
      { namespace: "aeitwoen", profile: "oritwoen" },
      { namespace: "default", profile: "default" },
    ]) {
      turns.add(
        createIngestRouter({ fallback }).route({ role: "user", content: fallback.namespace }, host),
      );
    }
    await turns.flush({ warn: notify });

    expect(
      ingest.mock.calls.map(([params]) => [
        `${params.namespace}/${params.profile}`,
        params.messages.map(({ content }) => content),
      ]),
    ).toEqual([
      ["aeitwoen/oritwoen", ["aeitwoen"]],
      ["default/default", ["aeitwoen", "default"]],
    ]);
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

    expect(scoped(ingest).map(([params]) => params.messages.length)).toEqual([500, 1]);
    expect(scoped(ingest)[1]![0].messages[0]!.content).toBe(stamped("m500"));
  });

  it("ingests the new messages every second turn and the rest on shutdown", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/nonexistent/agntn-memory-test");
    vi.stubEnv("AGNTN_MEMORY_NAMESPACE", "default");
    vi.stubEnv("AGNTN_MEMORY_PROFILE", "oritwoen");
    vi.stubEnv("AGNTN_MEMORY_INGEST_TURNS", "2");
    vi.stubEnv("AGNTN_MEMORY_FIELDS", '{"platform":"web"}');
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
    expect(scoped(ingest).map(([params]) => params)).toEqual([
      {
        namespace: "default",
        profile: "oritwoen",
        sessionId,
        messages: [
          { role: "user", content: stamped("one"), timestamp: "1970-01-01T00:00:00.000Z" },
          { role: "assistant", content: stamped("re: one"), timestamp: "1970-01-01T00:00:00.001Z" },
          { role: "user", content: stamped("two"), timestamp: "1970-01-01T00:00:01.000Z" },
          { role: "assistant", content: stamped("re: two"), timestamp: "1970-01-01T00:00:01.001Z" },
        ],
      },
      {
        namespace: "default",
        profile: "oritwoen",
        sessionId,
        messages: [
          { role: "user", content: stamped("three"), timestamp: "1970-01-01T00:00:02.000Z" },
          {
            role: "assistant",
            content: stamped("re: three"),
            timestamp: "1970-01-01T00:00:02.001Z",
          },
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
      "Memory ingest failed, 4 messages wait for the next try: Cloudflare answered [2J 503",
      "warning",
    );
    expect(scoped(ingest)).toHaveLength(2);
    expect(scoped(ingest)[1]![0].messages.map(({ content }) => content)).toEqual([
      stamped("one"),
      stamped("re: one"),
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

    expect(scoped(ingest)).toHaveLength(2);
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
      "Memory ingest failed, 4 messages were not ingested: down",
      "warning",
    );
  });

  it("reads ingestTurns from Pi's scope file", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "agntn-memory-pi-"));
    mkdirSync(join(agentDir, "agntn"), { recursive: true });
    try {
      writeFileSync(
        join(agentDir, "agntn", "memory.json"),
        JSON.stringify({ namespace: "default", profile: "oritwoen", ingestTurns: 5 }),
      );
      vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
      vi.stubEnv("AGNTN_MEMORY_INGEST_TURNS", "");
      expect([...loadPi().keys()]).toEqual([
        "session_start",
        "before_agent_start",
        "tool_result",
        "message_end",
        "turn_end",
        "session_shutdown",
      ]);
      writeFileSync(
        join(agentDir, "agntn", "memory.json"),
        JSON.stringify({ namespace: "default", profile: "oritwoen", ingestTurns: 0 }),
      );
      expect(loadPi().size).toBe(0);
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("takes a scope file that sets only the interval", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "agntn-memory-pi-"));
    mkdirSync(join(agentDir, "agntn"), { recursive: true });
    try {
      writeFileSync(join(agentDir, "agntn", "memory.json"), JSON.stringify({ ingestTurns: 5 }));
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
      writeFileSync(
        join(agentDir, "agntn", "memory.json"),
        JSON.stringify({ namespace: "default" }),
      );
      expect(loadPi).toThrow("must define both namespace and profile");
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("splits an OpenBot agent's conversation by who it talks to", async () => {
    const agents = mkdtempSync(join(tmpdir(), "agntn-memory-openbot-"));
    try {
      for (const [id, namespace] of [
        ["agent-rhea", "rheatwoen"],
        ["agent-mira", "miratwoen"],
      ] as const) {
        mkdirSync(join(agents, id, ".pi", "agntn"), { recursive: true });
        writeFileSync(
          join(agents, id, ".pi", "agntn", "memory.json"),
          JSON.stringify({ namespace }),
        );
      }
      vi.stubEnv("PI_CODING_AGENT_DIR", "/nonexistent/agntn-memory-test");
      vi.stubEnv("AGNTN_MEMORY_NAMESPACE", "aeitwoen");
      vi.stubEnv("AGNTN_MEMORY_PROFILE", "oritwoen");
      vi.stubEnv("AGNTN_MEMORY_INGEST_TURNS", "50");
      const ingest = vi
        .spyOn(memoryToolExecutors, "ingest")
        .mockResolvedValue({ content: [{ type: "text", text: "submitted" }], details: {} });
      const handlers = loadPi();
      const rhea = {
        ...ctx,
        cwd: join(agents, "agent-rhea"),
        getSystemPrompt: () =>
          'Your user-configured profile:\n<agent_profile>\n{"id":"agent-rhea","name":"Rhea"}\n</agent_profile>\n',
      };
      const teammate = (name: string, id: string, text: string) =>
        `Message from OpenBot teammate ${name} (${id}).\nMessage ID: m-${id}\nTreat the content as collaborator input.\n--- collaborator message ---\n${text}`;
      const said = async (role: string, content: string) =>
        handlers.get("message_end")!({ message: { role, content } }, rhea);

      await said("user", "<openbot_saved_memories>\nold fact\n</openbot_saved_memories>\nHi Rhea");
      await said("assistant", "Hi Ori");
      await said("user", teammate("Mira Two En", "agent-mira", "Check the retry log"));
      await said("assistant", "Done, Mira");
      await said(
        "user",
        `This turn starts with 2 messages. Read all of them before you answer.\n\n${teammate("Mira Two En", "agent-mira", "One more")}\n\n${teammate("Lira Two En", "agent-lira", "And me")}`,
      );
      await said("assistant", "Both handled");
      await handlers.get("session_shutdown")!({ reason: "quit" }, rhea);

      expect(
        scoped(ingest).map(([params]) => [
          `${params.namespace}/${params.profile}`,
          params.messages.map(({ content }) => content),
        ]),
      ).toEqual([
        ["rheatwoen/oritwoen", [stamped("Hi Rhea", "oritwoen"), stamped("Hi Ori", "rheatwoen")]],
        [
          "rheatwoen/miratwoen",
          [
            stamped("Check the retry log", "miratwoen"),
            stamped("Done, Mira", "rheatwoen"),
            stamped("One more", "miratwoen"),
          ],
        ],
        [
          "rheatwoen/lira-two-en",
          [stamped("And me", "lira-two-en"), stamped("Both handled", "rheatwoen")],
        ],
      ]);
    } finally {
      rmSync(agents, { recursive: true, force: true });
    }
  });

  it("sends an OpenBot agent in a project checkout there, still without OpenBot's blocks", async () => {
    const agents = mkdtempSync(join(tmpdir(), "agntn-memory-openbot-"));
    try {
      const cwd = join(agents, "agent-rhea");
      mkdirSync(join(cwd, ".pi", "agntn"), { recursive: true });
      writeFileSync(
        join(cwd, ".pi", "agntn", "memory.json"),
        JSON.stringify({ namespace: "rheatwoen" }),
      );
      execFileSync("git", ["init", "-q", cwd]);
      execFileSync("git", [
        "-C",
        cwd,
        "remote",
        "add",
        "origin",
        "https://github.com/agntn/memory.git",
      ]);
      vi.stubEnv("PI_CODING_AGENT_DIR", "/nonexistent/agntn-memory-test");
      vi.stubEnv("AGNTN_MEMORY_NAMESPACE", "aeitwoen");
      vi.stubEnv("AGNTN_MEMORY_PROFILE", "oritwoen");
      vi.stubEnv("AGNTN_MEMORY_INGEST_TURNS", "50");
      const ingest = vi
        .spyOn(memoryToolExecutors, "ingest")
        .mockResolvedValue({ content: [{ type: "text", text: "submitted" }], details: {} });
      const handlers = loadPi();
      const rhea = {
        ...ctx,
        cwd,
        getSystemPrompt: () =>
          '<agent_profile>\n{"id":"agent-rhea","name":"Rhea"}\n</agent_profile>',
      };

      await handlers.get("message_end")!(
        {
          message: {
            role: "user",
            content: "<openbot_saved_memories>\nold fact\n</openbot_saved_memories>\nShip it",
          },
        },
        rhea,
      );
      await handlers.get("session_shutdown")!({ reason: "quit" }, rhea);

      expect(scoped(ingest)[0]![0]).toMatchObject({
        namespace: "agntn",
        profile: "memory",
        messages: [{ role: "user", content: stamped("Ship it", "oritwoen") }],
      });
    } finally {
      rmSync(agents, { recursive: true, force: true });
    }
  });

  it("keeps a channel mapped to null and still loads", () => {
    const piDir = mkdtempSync(join(tmpdir(), "agntn-memory-pi-"));
    try {
      mkdirSync(join(piDir, "agntn"), { recursive: true });
      writeFileSync(
        join(piDir, "agntn", "memory.json"),
        JSON.stringify({ openbotChannels: { c0: null, c1: "puzzles/gsmg" } }),
      );
      vi.stubEnv("PI_CODING_AGENT_DIR", piDir);
      vi.stubEnv("AGNTN_MEMORY_INGEST_TURNS", "");
      expect([...configuredPiOpenBotChannels()]).toEqual([
        ["c0", null],
        ["c1", { namespace: "puzzles", profile: "gsmg" }],
      ]);
      expect(loadPi().size).toBe(6);
    } finally {
      rmSync(piDir, { recursive: true, force: true });
    }
  });

  it("sends each message to its own fallback when the project's namespace is missing", async () => {
    const ingest = vi
      .spyOn(memoryToolExecutors, "ingest")
      .mockRejectedValueOnce(new MemoryNotFoundError("namespace 'puzzles' not found", 404))
      .mockResolvedValue({ content: [{ type: "text", text: "submitted" }], details: {} });
    const turns = createTurnIngest(50);
    const project = { namespace: "puzzles", profile: "gsmg" };
    turns.add([
      {
        scope: project,
        message: { role: "user", content: "from Ori" },
        fallback: { namespace: "rheatwoen", profile: "oritwoen" },
      },
      {
        scope: project,
        message: { role: "user", content: "from Mira" },
        fallback: { namespace: "rheatwoen", profile: "miratwoen" },
      },
    ]);
    await turns.flush({ warn: notify });

    expect(
      scoped(ingest).map(([params]) => [
        `${params.namespace}/${params.profile}`,
        params.messages.map(({ content }) => content),
      ]),
    ).toEqual([
      ["puzzles/gsmg", ["from Ori", "from Mira"]],
      ["rheatwoen/oritwoen", ["from Ori"]],
      ["rheatwoen/miratwoen", ["from Mira"]],
    ]);
  });

  it("keeps channel sessions out of the remote's project unless the map names one", () => {
    const agents = mkdtempSync(join(tmpdir(), "agntn-memory-openbot-"));
    try {
      const cwd = join(agents, "agent-rhea");
      mkdirSync(join(cwd, ".pi", "agntn"), { recursive: true });
      writeFileSync(
        join(cwd, ".pi", "agntn", "memory.json"),
        JSON.stringify({ namespace: "rheatwoen" }),
      );
      execFileSync("git", ["init", "-q", cwd]);
      execFileSync("git", [
        "-C",
        cwd,
        "remote",
        "add",
        "origin",
        "https://github.com/acme/shared.git",
      ]);
      const sessionFile = join(agents, "session.jsonl");
      const databasePath = join(agents, "openbot.db");
      const db = new DatabaseSync(databasePath);
      db.exec(`
        CREATE TABLE projection_channel_contexts (channel_id TEXT, agent_id TEXT, thread_id TEXT, session_id TEXT);
        CREATE TABLE projection_channel_tasks (task_id TEXT PRIMARY KEY, channel_id TEXT, task_json TEXT);
        CREATE TABLE projection_channel_assignments (assignment_id TEXT PRIMARY KEY, channel_id TEXT, task_id TEXT, delivery_id TEXT, assignment_json TEXT);
        CREATE TABLE projection_channel_messages (channel_id TEXT, message_id TEXT, sequence INTEGER, message_json TEXT);
      `);
      db.prepare(
        "INSERT INTO projection_channel_contexts VALUES ('channel1', 'agent-rhea', 't1', ?)",
      ).run(sessionFile);
      db.close();
      const router = createIngestRouter({
        fallback: { namespace: "aeitwoen", profile: "oritwoen" },
        openBotDatabase: databasePath,
        openBotChannels: new Map([["channel1", null]]),
      });
      const routed = router.route(
        { role: "user", content: "hi" },
        {
          cwd,
          sessionFile: () => sessionFile,
          systemPrompt: () =>
            '<agent_profile>\n{"id":"agent-rhea","name":"Rhea"}\n</agent_profile>',
          warn: () => {},
        },
      );
      expect(routed.map(({ scope }) => `${scope.namespace}/${scope.profile}`)).toEqual([
        "rheatwoen/oritwoen",
        "default/default",
      ]);
    } finally {
      rmSync(agents, { recursive: true, force: true });
    }
  });

  it("sends an OpenBot agent's project conversation there without a personal scope", async () => {
    const agents = mkdtempSync(join(tmpdir(), "agntn-memory-openbot-"));
    try {
      const cwd = join(agents, "agent-rhea");
      mkdirSync(join(cwd, ".pi", "agntn"), { recursive: true });
      writeFileSync(
        join(cwd, ".pi", "agntn", "memory.json"),
        JSON.stringify({ namespace: "rheatwoen" }),
      );
      execFileSync("git", ["init", "-q", cwd]);
      execFileSync("git", [
        "-C",
        cwd,
        "remote",
        "add",
        "origin",
        "https://github.com/agntn/memory.git",
      ]);
      vi.stubEnv("PI_CODING_AGENT_DIR", "/nonexistent/agntn-memory-test");
      vi.stubEnv("AGNTN_MEMORY_INGEST_TURNS", "50");
      const ingest = vi
        .spyOn(memoryToolExecutors, "ingest")
        .mockResolvedValue({ content: [{ type: "text", text: "submitted" }], details: {} });
      const handlers = loadPi();
      const rhea = {
        ...ctx,
        cwd,
        getSystemPrompt: () =>
          '<agent_profile>\n{"id":"agent-rhea","name":"Rhea"}\n</agent_profile>',
      };

      await handlers.get("message_end")!({ message: { role: "user", content: "Ship it" } }, rhea);
      await handlers.get("message_end")!(
        { message: { role: "assistant", content: "Shipped" } },
        rhea,
      );
      await handlers.get("session_shutdown")!({ reason: "quit" }, rhea);

      expect(scoped(ingest)[0]![0]).toMatchObject({
        namespace: "agntn",
        profile: "memory",
        messages: [
          { role: "user", content: stamped("Ship it") },
          { role: "assistant", content: stamped("Shipped", "rheatwoen") },
        ],
      });
    } finally {
      rmSync(agents, { recursive: true, force: true });
    }
  });

  it("writes a missing agent namespace file from the template", async () => {
    const agents = mkdtempSync(join(tmpdir(), "agntn-memory-openbot-"));
    try {
      const cwd = join(agents, "agent-iona");
      mkdirSync(cwd);
      vi.stubEnv("PI_CODING_AGENT_DIR", "/nonexistent/agntn-memory-test");
      vi.stubEnv("AGNTN_MEMORY_NAMESPACE", "aeitwoen");
      vi.stubEnv("AGNTN_MEMORY_PROFILE", "oritwoen");
      vi.stubEnv("AGNTN_MEMORY_INGEST_TURNS", "1");
      vi.stubEnv("AGNTN_MEMORY_AGENT_NAMESPACE", "team-{name}");
      const ingest = vi
        .spyOn(memoryToolExecutors, "ingest")
        .mockResolvedValue({ content: [{ type: "text", text: "submitted" }], details: {} });
      const handlers = loadPi();
      const iona = {
        ...ctx,
        cwd,
        getSystemPrompt: () =>
          '<agent_profile>\n{"id":"agent-iona","name":"Iona"}\n</agent_profile>',
      };

      await handlers.get("message_end")!({ message: { role: "user", content: "hi" } }, iona);
      await handlers.get("session_shutdown")!({ reason: "quit" }, iona);

      expect(scoped(ingest)[0]![0]).toMatchObject({
        namespace: "team-iona",
        profile: "oritwoen",
      });
      expect(JSON.parse(readFileSync(join(cwd, ".pi", "agntn", "memory.json"), "utf8"))).toEqual({
        namespace: "team-iona",
      });
      expect(notify).toHaveBeenCalledWith(
        `OpenBot agent Iona had no namespace file, so ${join(cwd, ".pi", "agntn", "memory.json")} now says team-iona.`,
        "warning",
      );
    } finally {
      rmSync(agents, { recursive: true, force: true });
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
        "https://0123abcd.artifacts.cloudflare.net/git/puzzles/gsmg.git",
        "/home/ori/Projekty/memory",
        "file:///home/ori/agntn/memory",
        "https://github.com/agntn",
      ].map((url) => remoteMemoryScope(url)),
    ).toEqual([
      { namespace: "agntn", profile: "memory" },
      { namespace: "agntn", profile: "memory" },
      { namespace: "agntn", profile: "memory" },
      { namespace: "agntn", profile: "memory" },
      { namespace: "sub", profile: "my-repo" },
      { namespace: "puzzles", profile: "gsmg" },
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("names the repository as the remote spells it, for the repository field", () => {
    expect(
      [
        "https://github.com/agntn/memory.git/",
        "git@github.com-aei:agntn/memory.git",
        "https://gitlab.com/Group/Sub/My_Repo.git",
        "/home/ori/Projekty/memory",
        "https://github.com/agntn",
        "https://github.com/agntn/memory\u202Etxt.git",
      ].map((url) => remoteRepository(url)),
    ).toEqual(["agntn/memory", "agntn/memory", "Sub/My_Repo", undefined, undefined, undefined]);
  });

  it("files channel tasks under who gave them, from OpenBot's records", async () => {
    const root = mkdtempSync(join(tmpdir(), "agntn-memory-openbot-"));
    try {
      const agents = join(root, "Agents");
      for (const [id, namespace] of [
        ["agent-rhea", "rheatwoen"],
        ["agent-mira", "miratwoen"],
      ] as const) {
        mkdirSync(join(agents, id, ".pi", "agntn"), { recursive: true });
        writeFileSync(
          join(agents, id, ".pi", "agntn", "memory.json"),
          JSON.stringify({ namespace }),
        );
      }
      const sessionFile = join(root, "session.jsonl");
      const databasePath = join(root, "openbot.db");
      const db = new DatabaseSync(databasePath);
      db.exec(`
        CREATE TABLE projection_channel_contexts (channel_id TEXT, agent_id TEXT, thread_id TEXT, session_id TEXT);
        CREATE TABLE projection_channel_tasks (task_id TEXT PRIMARY KEY, channel_id TEXT, task_json TEXT);
        CREATE TABLE projection_channel_assignments (assignment_id TEXT PRIMARY KEY, channel_id TEXT, task_id TEXT, delivery_id TEXT, assignment_json TEXT);
        CREATE TABLE projection_channel_messages (channel_id TEXT, message_id TEXT, sequence INTEGER, message_json TEXT);
      `);
      db.prepare(
        "INSERT INTO projection_channel_contexts VALUES ('c1', 'agent-rhea', 't1', ?)",
      ).run(sessionFile);
      const task = (id: string, json: object) => {
        db.prepare("INSERT INTO projection_channel_tasks VALUES (?, 'c1', ?)").run(
          id,
          JSON.stringify(json),
        );
      };
      const assign = (id: string, taskId: string, agentId: string) => {
        db.prepare("INSERT INTO projection_channel_assignments VALUES (?, 'c1', ?, ?, ?)").run(
          id,
          taskId,
          id,
          JSON.stringify({ agentId }),
        );
      };
      task("from-ori", {
        instruction: "Plan the release",
        parentTaskId: null,
        requestMessageId: "m-ori",
        ownerAgentId: "agent-rhea",
      });
      task("mira-root", {
        instruction: "Coordinate the sweep",
        parentTaskId: null,
        requestMessageId: "m-x",
        ownerAgentId: "agent-mira",
      });
      task("from-mira", {
        instruction: "Check the retry log",
        parentTaskId: "mira-root",
        requestMessageId: "m-y",
        ownerAgentId: "agent-rhea",
      });
      assign("a1", "from-ori", "agent-rhea");
      assign("a2", "mira-root", "agent-mira");
      assign("a3", "from-mira", "agent-rhea");
      db.prepare("INSERT INTO projection_channel_messages VALUES ('c1', 'm-ori', 1, ?)").run(
        JSON.stringify({ author: { kind: "member", id: "user", name: "Ori" } }),
      );
      db.close();

      vi.stubEnv("PI_CODING_AGENT_DIR", "/nonexistent/agntn-memory-test");
      vi.stubEnv("AGNTN_MEMORY_NAMESPACE", "aeitwoen");
      vi.stubEnv("AGNTN_MEMORY_PROFILE", "oritwoen");
      vi.stubEnv("AGNTN_MEMORY_INGEST_TURNS", "50");
      vi.stubEnv("AGNTN_MEMORY_FIELDS", '{"platform":"web"}');
      vi.spyOn(process, "argv", "get").mockReturnValue([
        "node",
        "pi",
        "--extension",
        join(root, "provider-state", "openbot-pi-abc123", "mcp.mjs"),
      ]);
      const ingest = vi
        .spyOn(memoryToolExecutors, "ingest")
        .mockResolvedValue({ content: [{ type: "text", text: "submitted" }], details: {} });
      const handlers = loadPi();
      const rhea = {
        ...ctx,
        cwd: join(agents, "agent-rhea"),
        sessionManager: { getSessionId: () => "s", getSessionFile: () => sessionFile },
        getSystemPrompt: () =>
          '<agent_profile>\n{"id":"agent-rhea","name":"Rhea"}\n</agent_profile>',
      };
      const said = async (role: string, content: string) =>
        handlers.get("message_end")!({ message: { role, content } }, rhea);

      await said("user", "Plan the release");
      await said("assistant", "Planned");
      await said("user", "Check the retry log");
      await said("assistant", "Checked");
      await handlers.get("session_shutdown")!({ reason: "quit" }, rhea);

      expect(
        scoped(ingest).map(([params]) => [
          `${params.namespace}/${params.profile}`,
          params.messages.map(({ content }) => content),
        ]),
      ).toEqual([
        [
          "rheatwoen/oritwoen",
          [stamped("Plan the release", "oritwoen"), stamped("Planned", "rheatwoen")],
        ],
        [
          "rheatwoen/miratwoen",
          [stamped("Check the retry log", "miratwoen"), stamped("Checked", "rheatwoen")],
        ],
      ]);

      const piDir = join(root, "pi");
      mkdirSync(join(piDir, "agntn"), { recursive: true });
      writeFileSync(
        join(piDir, "agntn", "memory.json"),
        JSON.stringify({ openbotChannels: { c1: "puzzles/gsmg" } }),
      );
      vi.stubEnv("PI_CODING_AGENT_DIR", piDir);
      ingest.mockClear();
      const mapped = loadPi();
      await mapped.get("message_end")!(
        { message: { role: "user", content: "Check the retry log" } },
        rhea,
      );
      await mapped.get("session_shutdown")!({ reason: "quit" }, rhea);
      expect(scoped(ingest).map(([params]) => `${params.namespace}/${params.profile}`)).toEqual([
        "puzzles/gsmg",
        "default/puzzles",
      ]);
      expect(await loadPi().get("before_agent_start")!({}, rhea)).toBeUndefined();

      vi.stubEnv("PI_CODING_AGENT_DIR", "/nonexistent/agntn-memory-test");
      const unmapped = loadPi();
      expect(await unmapped.get("before_agent_start")!({}, rhea)).toEqual({
        message: {
          customType: "agntn-memory",
          content: expect.stringContaining("OpenBot channel (c1) has no entry in openbotChannels"),
          display: true,
        },
      });
      expect(await unmapped.get("before_agent_start")!({}, rhea)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds OpenBot's database from the extension it loads into Pi", () => {
    expect(
      openBotDatabasePath([
        "pi",
        "--extension",
        "/data/OpenBot/provider-state/openbot-pi-x1/mcp.mjs",
      ]),
    ).toBe(join("/data/OpenBot", "openbot.db"));
    expect(openBotDatabasePath(["pi", "--extension", "/home/me/ext.ts"])).toBeUndefined();
  });

  it("reads the sender of a channel request and a channel reply", () => {
    expect(
      [
        "Request from OpenBot teammate Mira (agent-mira), sent from another conversation. It is not a message from the user.\n\nRun the sweep",
        "Reply from channel member Lira (agent:agent-lira) to your message. It is not a message from the user.\n\nSweep done",
        "Plain words from the person",
      ].map((text) => openBotSegments(text)),
    ).toEqual([
      [{ senderName: "Mira", senderId: "agent-mira", text: "Run the sweep" }],
      [{ senderName: "Lira", senderId: "agent-lira", text: "Sweep done" }],
      [{ text: "Plain words from the person" }],
    ]);
  });

  it("leaves room for the author when it cuts a long message", () => {
    const chunks = ingestMessages({ role: "user", content: "ą".repeat(20_000) }, "rheatwoen");
    const sizes = chunks.map(({ content }) => new TextEncoder().encode(content).length);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(32_768);
    expect(chunks.every(({ content }) => content.endsWith("\n\nauthor: rheatwoen"))).toBe(true);
  });

  it("drops a timestamp past year 9999 instead of a message the service refuses", () => {
    expect(ingestMessages({ role: "user", content: "hi", timestamp: 8e15 })).toEqual([
      { role: "user", content: "hi" },
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
