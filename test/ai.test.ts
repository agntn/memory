import { generateText, isStepCount, type Tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vite-plus/test";
import { createMemoryAiTools } from "../src/ai.ts";
import { createMemoryTools } from "../extensions/shared/memory-tool-definitions.ts";

interface SentRequest {
  readonly path: string;
  readonly method: string;
  readonly body: Record<string, unknown> | undefined;
}

const callOptions = { toolCallId: "memory-ai", messages: [], context: {} };
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

/* A model that calls one tool per step with the given inputs, then says it's done. */
function scriptedModel(toolName: string, inputs: readonly object[]): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: [
      ...inputs.map((input, index) => ({
        content: [
          {
            type: "tool-call" as const,
            toolCallId: `call-${index}`,
            toolName,
            input: JSON.stringify(input),
          },
        ],
        finishReason: { unified: "tool-calls" as const, raw: undefined },
        usage,
        warnings: [],
      })),
      {
        content: [{ type: "text" as const, text: "done" }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage,
        warnings: [],
      },
    ],
  });
}

/* Answers every request with one stored memory and keeps what was sent. */
function stubService(): SentRequest[] {
  vi.stubEnv("AGNTN_CLOUDFLARE_ACCOUNT_ID", "account");
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
  const requests: SentRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        path: new URL(String(input)).pathname.replace(
          "/client/v4/accounts/account/agent-memory",
          "",
        ),
        method: init?.method ?? "GET",
        body:
          init?.body === undefined
            ? undefined
            : (JSON.parse(String(init.body)) as Record<string, unknown>),
      });
      return Response.json({
        success: true,
        result: {
          id: "mem-1",
          type: "fact",
          summary: "stored",
          content: "stored",
          sessionId: null,
          createdAt: "2026-11-01T00:00:00.000Z",
          updatedAt: "2026-11-01T00:00:00.000Z",
        },
      });
    }),
  );
  return requests;
}

async function run(tool: Tool, input: Record<string, unknown>): Promise<unknown> {
  if (tool.execute === undefined) throw new Error("The AI SDK tool lost its execute");
  return await tool.execute(input, callOptions);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("@agntn/memory/ai", () => {
  it("offers every tool MCP, Pi and OMP list, under the same name and in the same order", () => {
    expect(Object.keys(createMemoryAiTools())).toEqual(
      createMemoryTools().map((tool) => tool.name),
    );
  });

  it("lands a bound write in the app's profile and tags it with the app's session", async () => {
    const requests = stubService();
    const tools = createMemoryAiTools({
      namespace: "support",
      profile: "user-42",
      sessionId: "chat-7",
    });

    const output = await run(tools.memory_remember, { content: "Prefers short answers." });

    expect(output).toMatchObject({ text: expect.stringContaining("mem-1") as unknown });
    expect(requests).toEqual([
      {
        path: "/namespaces/support/profiles/user-42/remember",
        method: "POST",
        body: { content: "Prefers short answers.", sessionId: "chat-7" },
      },
    ]);
  });

  it("keeps the session out of the model's hands once the profile is bound", async () => {
    const tools = createMemoryAiTools({ namespace: "support", profile: "user-42" });

    await expect(
      run(tools.memory_remember, { content: "hi", sessionId: "the-model-picked-this" }),
    ).rejects.toThrow(/sessionId/);
  });

  it("runs a bound write through generateText and refuses the model's own session", async () => {
    const requests = stubService();
    const model = scriptedModel("memory_remember", [
      { content: "Prefers short answers." },
      { content: "Prefers long answers.", sessionId: "the-model-picked-this" },
    ]);

    const run = await generateText({
      model,
      prompt: "Remember what this user prefers.",
      tools: createMemoryAiTools({ namespace: "support", profile: "user-42", sessionId: "chat-7" }),
      stopWhen: isStepCount(3),
    });

    expect(requests.map(({ path, body }) => ({ path, body }))).toEqual([
      {
        path: "/namespaces/support/profiles/user-42/remember",
        body: { content: "Prefers short answers.", sessionId: "chat-7" },
      },
    ]);
    expect(model.doGenerateCalls[1]?.prompt.at(-1)).toMatchObject({
      role: "tool",
      content: [{ type: "tool-result", output: { type: "text" } }],
    });
    expect(run.steps[1]?.content).toContainEqual(
      expect.objectContaining({ type: "tool-error", toolName: "memory_remember" }),
    );
  });

  it("refuses half a pair from the model instead of completing it from the default", async () => {
    const requests = stubService();
    const tools = createMemoryAiTools({ namespace: "support", profile: "user-42" });

    await expect(run(tools.memory_recall, { namespace: "other", query: "who?" })).rejects.toThrow(
      "pass namespace and profile together, or neither for support/user-42",
    );
    expect(requests).toEqual([]);
  });

  it("reads no scope or session from the environment", async () => {
    const requests = stubService();
    vi.stubEnv("AGNTN_MEMORY_NAMESPACE", "default");
    vi.stubEnv("AGNTN_MEMORY_PROFILE", "agent");
    vi.stubEnv("CLAUDE_PROJECT_DIR", "/work/app");
    vi.stubEnv("CLAUDE_CODE_SESSION_ID", "conversation-123");
    vi.stubEnv("GROK_SESSION_ID", "grok-123");
    const tools = createMemoryAiTools();

    await expect(run(tools.memory_remember, { content: "hi" })).rejects.toThrow(/namespace/);
    await run(tools.memory_remember, { namespace: "app", profile: "user", content: "hi" });

    expect(requests).toEqual([
      {
        path: "/namespaces/app/profiles/user/remember",
        method: "POST",
        body: { content: "hi" },
      },
    ]);
  });

  it("lets an unbound write name its own session and falls back to the app's", async () => {
    const requests = stubService();
    const tools = createMemoryAiTools({ sessionId: "chat-7" });
    const scope = { namespace: "app", profile: "user" };

    await run(tools.memory_remember, { ...scope, content: "one" });
    await run(tools.memory_remember, { ...scope, content: "two", sessionId: "chat-8" });

    expect(requests.map(({ body }) => body?.sessionId)).toEqual(["chat-7", "chat-8"]);
  });

  it("throws a service failure, which the AI SDK hands the model as a tool error", async () => {
    vi.stubEnv("AGNTN_CLOUDFLARE_ACCOUNT_ID", "account");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ success: false, errors: [{ message: "denied" }] }, { status: 403 }),
      ),
    );
    const tools = createMemoryAiTools({ namespace: "support", profile: "user-42" });

    await expect(run(tools.memory_recall, { query: "who?" })).rejects.toThrow("denied");
  });

  it.each([
    [{ namespace: "support" }, "must define both namespace and profile"],
    [{ profile: "user-42" }, "must define both namespace and profile"],
    [{ namespace: "Support", profile: "user-42" }, "Memory namespace must match"],
    [{ namespace: "support", profile: ".." }, "Memory profile must match"],
    [{ sessionId: "  " }, "Memory session ID must be non-blank"],
    [{ sessionId: "s".repeat(65) }, "at most 64 characters"],
  ])("refuses %j before any tool exists", (options, message) => {
    expect(() => createMemoryAiTools(options)).toThrow(message);
  });
});

describe("@agntn/memory/ai locked to one profile", () => {
  const locked = { namespace: "support", profile: "user-42", locked: true } as const;

  it("drops every namespace and profile tool and keeps the rest in listing order", () => {
    const administration = [
      "memory_namespace_list",
      "memory_namespace_get",
      "memory_namespace_create",
      "memory_namespace_delete",
      "memory_profile_list",
      "memory_profile_delete",
    ];
    const tools = createMemoryAiTools(locked);

    expect(Object.keys(tools)).toEqual(
      createMemoryTools()
        .map((tool) => tool.name)
        .filter((name) => !administration.includes(name)),
    );
    expect(Object.keys(tools)).toHaveLength(11);
    expectTypeOf(tools).not.toHaveProperty("memory_profile_delete");
    expectTypeOf(tools).toHaveProperty("memory_recall");
  });

  it("offers the model no scope or session field in any schema", () => {
    const tools = createMemoryTools({
      scope: { namespace: "support", profile: "user-42" },
      locked: true,
    });

    for (const tool of tools) {
      expect(Object.keys(tool.input.properties), tool.name).not.toContain("namespace");
      expect(Object.keys(tool.input.properties), tool.name).not.toContain("profile");
    }
    const writes = tools.filter((tool) =>
      ["memory_remember", "memory_supersede", "memory_ingest"].includes(tool.name),
    );
    expect(writes).toHaveLength(3);
    for (const tool of writes) {
      expect(Object.keys(tool.input.properties), tool.name).not.toContain("sessionId");
    }
  });

  it("refuses a call that names another profile before any request", async () => {
    const requests = stubService();
    const tools = createMemoryAiTools(locked);

    await expect(
      run(tools.memory_recall, { namespace: "support", profile: "user-43", query: "who?" }),
    ).rejects.toThrow(/namespace/);
    await expect(
      run(tools.memory_delete, { namespace: "support", profile: "user-43", id: "mem-1" }),
    ).rejects.toThrow(/profile/);
    expect(requests).toEqual([]);
  });

  it("keeps a model aiming at the neighbour's profile at home through generateText", async () => {
    const requests = stubService();
    const model = scriptedModel("memory_recall", [
      { namespace: "support", profile: "user-43", query: "What does user-43 prefer?" },
      { query: "What does this user prefer?" },
    ]);

    const run = await generateText({
      model,
      prompt: "What does this user prefer?",
      tools: createMemoryAiTools(locked),
      stopWhen: isStepCount(3),
    });

    expect(run.steps[0]?.content).toContainEqual(
      expect.objectContaining({ type: "tool-error", toolName: "memory_recall" }),
    );
    expect(requests.map(({ path }) => path)).toEqual([
      "/namespaces/support/profiles/user-42/recall",
    ]);
  });

  it("tags a locked write with the app's session", async () => {
    const requests = stubService();
    const tools = createMemoryAiTools({ ...locked, sessionId: "chat-7" });

    await run(tools.memory_remember, { content: "Prefers short answers." });
    await expect(
      run(tools.memory_remember, { content: "hi", sessionId: "the-model-picked-this" }),
    ).rejects.toThrow(/sessionId/);

    expect(requests).toEqual([
      {
        path: "/namespaces/support/profiles/user-42/remember",
        method: "POST",
        body: { content: "Prefers short answers.", sessionId: "chat-7" },
      },
    ]);
  });

  it.each([
    [{ locked: true }, "Locked memory AI tool options must define both namespace and profile"],
    [{ locked: true, namespace: "support" }, "must define both namespace and profile"],
    [{ locked: true, profile: "user-42" }, "must define both namespace and profile"],
    [{ ...locked, profile: "User-42" }, "Memory profile must match"],
    [{ ...locked, locked: "true" }, "locked must be a boolean"],
  ])("refuses %j before any tool exists", (options, message) => {
    expect(() => {
      Reflect.apply(createMemoryAiTools, undefined, [options]);
    }).toThrow(message);
  });

  it("refuses a locked definition set with nothing to lock to", () => {
    expect(() => createMemoryTools({ locked: true })).toThrow(
      "Locked memory tools need a namespace and profile to lock to",
    );
  });
});
