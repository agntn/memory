import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { settle, useRetryTimers } from "./fake-timers.ts";
import { createMcpServer } from "../src/mcp.ts";
import { memorySessionId } from "../packages/shared/memory-scope.ts";

const openConnections: Array<{ close(): Promise<void> }> = [];

function storedMemory(id: string): Record<string, unknown> {
  return {
    id,
    type: "fact",
    summary: `summary ${id}`,
    content: `content ${id}`,
    sessionId: null,
    createdAt: "2026-08-17T00:00:00.000Z",
    updatedAt: "2026-08-17T00:00:00.000Z",
  };
}

const expectedNames = [
  "memory_namespace_list",
  "memory_namespace_get",
  "memory_namespace_create",
  "memory_namespace_delete",
  "memory_profile_list",
  "memory_remember",
  "memory_supersede",
  "memory_supersession_resume",
  "memory_recall_wait",
  "memory_ingest",
  "memory_recall",
  "memory_list",
  "memory_get",
  "memory_delete",
  "memory_summary",
  "memory_session_delete",
  "memory_profile_delete",
];

async function connectTestClient(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer();
  const client = new Client({ name: "memory-test", version: "1.0.0" });
  openConnections.push(client, server);
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

afterEach(async () => {
  await Promise.all(openConnections.splice(0).map((connection) => connection.close()));
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("memory MCP server", () => {
  it("discovers the complete memory tool surface", async () => {
    const client = await connectTestClient();

    const response = await client.listTools();

    expect(response.tools.map((tool) => tool.name)).toEqual(expectedNames);
    expect(
      response.tools.find((tool) => tool.name === "memory_remember")?.inputSchema,
    ).toMatchObject({
      type: "object",
      required: expect.arrayContaining(["namespace", "profile", "content"]),
    });
    expect(response.tools.find((tool) => tool.name === "memory_supersede")).toMatchObject({
      inputSchema: {
        required: expect.arrayContaining([
          "namespace",
          "profile",
          "oldMemoryId",
          "content",
          "query",
          "timeoutSeconds",
        ]),
      },
      annotations: { destructiveHint: true, idempotentHint: false },
    });
    expect(response.tools.find((tool) => tool.name === "memory_supersession_resume")).toMatchObject(
      {
        inputSchema: {
          required: expect.arrayContaining([
            "namespace",
            "profile",
            "oldMemoryId",
            "replacementMemoryId",
            "content",
            "query",
            "timeoutSeconds",
          ]),
        },
        annotations: { destructiveHint: true, idempotentHint: false },
      },
    );
    expect(
      response.tools.find((tool) => tool.name === "memory_recall_wait")?.annotations?.readOnlyHint,
    ).toBe(true);
    expect(
      response.tools.find((tool) => tool.name === "memory_recall")?.annotations?.readOnlyHint,
    ).toBe(true);
    expect(
      response.tools.find((tool) => tool.name === "memory_profile_delete")?.annotations
        ?.destructiveHint,
    ).toBe(true);
  });

  it("executes the recall visibility check through the shared MCP path", async () => {
    vi.stubEnv("AGNTN_CLOUDFLARE_ACCOUNT_ID", "account");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith("/memories/mem-1")) {
          return Response.json({ success: true, result: storedMemory("mem-1") });
        }
        bodies.push(JSON.parse(String(init?.body)) as unknown);
        return Response.json({
          success: true,
          result: {
            count: 1,
            answer: "ready",
            candidates: [{ id: "mem-1", summary: "ready", sessionId: null, score: 1 }],
          },
        });
      }),
    );
    const client = await connectTestClient();

    const response = await client.callTool({
      name: "memory_recall_wait",
      arguments: {
        namespace: "default",
        profile: "agent",
        memoryId: "mem-1",
        query: "durable marker",
        timeoutSeconds: 30,
      },
    });

    expect(response.isError).not.toBe(true);
    expect(response.content).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining('Memory "mem-1" reached recall in default/agent'),
      }),
    ]);
    expect(bodies).toEqual([
      { query: "durable marker", thinkingLevel: "low", responseLength: "short" },
    ]);
  });

  it("stores and verifies a replacement before deleting the old memory", async () => {
    vi.stubEnv("AGNTN_CLOUDFLARE_ACCOUNT_ID", "account");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        requests.push({
          url,
          method: init?.method ?? "GET",
          ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) as unknown }),
        });
        if (url.endsWith("/recall")) {
          return Response.json({
            success: true,
            result: {
              count: 1,
              answer: "ready",
              candidates: [{ id: "mem-new", summary: "replacement", sessionId: null, score: 1 }],
            },
          });
        }
        const old = url.endsWith("/memories/mem-old");
        return Response.json({
          success: true,
          result: {
            id: old ? "mem-old" : "mem-new",
            type: "fact",
            summary: old ? "old" : "replacement",
            content: old ? "old checkpoint" : "new checkpoint",
            sessionId: null,
            createdAt: "2026-08-28T00:00:00.000Z",
            updatedAt: "2026-08-28T00:00:00.000Z",
          },
        });
      }),
    );
    const client = await connectTestClient();

    const response = await client.callTool({
      name: "memory_supersede",
      arguments: {
        namespace: "default",
        profile: "agent",
        oldMemoryId: "mem-old",
        content: "new checkpoint",
        query: "new checkpoint",
        timeoutSeconds: 30,
      },
    });

    expect(response.isError).not.toBe(true);
    expect(response.content).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringMatching(/mem-old[\s\S]*mem-new|mem-new[\s\S]*mem-old/),
      }),
    ]);
    expect(requests.map(({ url, method }) => ({ path: new URL(url).pathname, method }))).toEqual([
      {
        path: "/client/v4/accounts/account/agent-memory/namespaces/default/profiles/agent/remember",
        method: "POST",
      },
      {
        path: "/client/v4/accounts/account/agent-memory/namespaces/default/profiles/agent/memories/mem-new",
        method: "GET",
      },
      {
        path: "/client/v4/accounts/account/agent-memory/namespaces/default/profiles/agent/recall",
        method: "POST",
      },
      {
        path: "/client/v4/accounts/account/agent-memory/namespaces/default/profiles/agent/memories/mem-old",
        method: "DELETE",
      },
    ]);
  });

  it("resumes a supersession through MCP without another write", async () => {
    vi.stubEnv("AGNTN_CLOUDFLARE_ACCOUNT_ID", "account");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
    const requests: Array<{ url: string; method: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, method: init?.method ?? "GET" });
        if (url.endsWith("/recall")) {
          return Response.json({
            success: true,
            result: {
              count: 1,
              answer: "ready",
              candidates: [{ id: "mem-new", summary: "replacement", sessionId: null, score: 1 }],
            },
          });
        }
        return Response.json({
          success: true,
          result: {
            id: "mem-new",
            type: "fact",
            summary: "replacement",
            content: "new checkpoint",
            sessionId: null,
            createdAt: "2026-09-02T00:00:00.000Z",
            updatedAt: "2026-09-02T00:00:00.000Z",
          },
        });
      }),
    );
    const client = await connectTestClient();

    const response = await client.callTool({
      name: "memory_supersession_resume",
      arguments: {
        namespace: "default",
        profile: "agent",
        oldMemoryId: "mem-old",
        replacementMemoryId: "mem-new",
        content: "new checkpoint",
        query: "new checkpoint",
        timeoutSeconds: 30,
      },
    });

    expect(response.isError).not.toBe(true);
    expect(response.content).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining(
          'Resumed supersession of memory "mem-old" with replacement "mem-new"',
        ),
      }),
    ]);
    expect(requests.map(({ url, method }) => ({ path: new URL(url).pathname, method }))).toEqual([
      {
        path: "/client/v4/accounts/account/agent-memory/namespaces/default/profiles/agent/memories/mem-new",
        method: "GET",
      },
      {
        path: "/client/v4/accounts/account/agent-memory/namespaces/default/profiles/agent/recall",
        method: "POST",
      },
      {
        path: "/client/v4/accounts/account/agent-memory/namespaces/default/profiles/agent/memories/mem-old",
        method: "DELETE",
      },
    ]);
  });

  it("keeps a long recall wait alive with MCP progress", async () => {
    vi.useFakeTimers();
    vi.stubEnv("AGNTN_CLOUDFLARE_ACCOUNT_ID", "account");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
    const startedAt = performance.now();
    let recalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).endsWith("/memories/mem-progress")) {
          return Response.json({ success: true, result: storedMemory("mem-progress") });
        }
        recalls += 1;
        const ready = performance.now() - startedAt >= 65_000;
        return Response.json({
          success: true,
          result: {
            count: ready ? 1 : 0,
            answer: ready ? "ready" : "waiting",
            candidates: ready
              ? [{ id: "mem-progress", summary: "ready", sessionId: null, score: 1 }]
              : [],
          },
        });
      }),
    );
    const client = await connectTestClient();
    const updates: Array<{ progress: number; total?: number; message?: string }> = [];

    const pending = client.callTool(
      {
        name: "memory_recall_wait",
        arguments: {
          namespace: "default",
          profile: "agent",
          memoryId: "mem-progress",
          query: "durable marker",
          timeoutSeconds: 90,
        },
      },
      undefined,
      {
        onprogress: (update) => updates.push(update),
        resetTimeoutOnProgress: true,
      },
    );
    const settled = pending.then(
      (response) => ({ response }),
      (error: unknown) => ({ error }),
    );
    await vi.waitFor(() => expect(recalls).toBe(1));
    await vi.advanceTimersByTimeAsync(70_000);

    const outcome = await settled;
    expect(outcome).toEqual({
      response: expect.objectContaining({
        content: [
          expect.objectContaining({
            text: expect.stringContaining('Memory "mem-progress" reached recall in default/agent'),
          }),
        ],
      }),
    });
    expect(updates).toEqual([
      { progress: 30_000, total: 90_000, message: "Waiting for memory to reach recall" },
      { progress: 60_000, total: 90_000, message: "Waiting for memory to reach recall" },
    ]);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(updates).toHaveLength(2);
  });

  it("gives the outbound request the caller's cancellation signal", async () => {
    vi.stubEnv("AGNTN_CLOUDFLARE_ACCOUNT_ID", "account");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
    const signals: Array<AbortSignal | null | undefined> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        signals.push(init?.signal);
        return Response.json({ success: true, result: { summary: "nothing yet" } });
      }),
    );
    const client = await connectTestClient();

    const response = await client.callTool({
      name: "memory_summary",
      arguments: { namespace: "default", profile: "oritwoen" },
    });

    expect(response.isError).not.toBe(true);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });

  it("binds operational tools to configured scope and harness session", async () => {
    vi.stubEnv("AGNTN_CLOUDFLARE_ACCOUNT_ID", "account");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
    vi.stubEnv("AGNTN_MEMORY_NAMESPACE", "default");
    vi.stubEnv("AGNTN_MEMORY_PROFILE", "oritwoen");
    vi.stubEnv("CLAUDE_PROJECT_DIR", "/workspace/movie-enigma");
    vi.stubEnv("CLAUDE_CODE_SESSION_ID", "conversation-123");
    vi.stubEnv("GROK_SESSION_ID", "grok-conversation-999");
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({
          url: String(input),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return Response.json({
          success: true,
          result: {
            id: "memory-scoped",
            type: "fact",
            summary: "remembered",
            content: "remembered",
            sessionId: null,
            createdAt: "2026-08-18T00:00:00.000Z",
            updatedAt: "2026-08-18T00:00:00.000Z",
          },
        });
      }),
    );
    const client = await connectTestClient();

    const tools = await client.listTools();
    const rememberSchema = tools.tools.find((tool) => tool.name === "memory_remember")?.inputSchema;
    expect(rememberSchema).toMatchObject({ type: "object", required: ["content"] });
    expect(rememberSchema?.properties).not.toHaveProperty("namespace");
    expect(rememberSchema?.properties).not.toHaveProperty("profile");
    expect(rememberSchema?.properties).not.toHaveProperty("sessionId");
    const supersedeSchema = tools.tools.find(
      (tool) => tool.name === "memory_supersede",
    )?.inputSchema;
    expect(supersedeSchema).toMatchObject({
      type: "object",
      required: ["oldMemoryId", "content", "query", "timeoutSeconds"],
    });
    expect(supersedeSchema?.properties).not.toHaveProperty("namespace");
    expect(supersedeSchema?.properties).not.toHaveProperty("profile");
    expect(supersedeSchema?.properties).not.toHaveProperty("sessionId");

    const response = await client.callTool({
      name: "memory_remember",
      arguments: { content: "one canonical memory", sessionId: "model-selected-session" },
    });

    expect(response.isError).not.toBe(true);
    expect(requests).toEqual([
      {
        url: expect.stringContaining("/namespaces/default/profiles/oritwoen/remember"),
        body: {
          content: "one canonical memory",
          sessionId: memorySessionId("claude", "/workspace/movie-enigma", "conversation-123"),
        },
      },
    ]);
  });

  it("falls back to the Grok session when no Claude session is in the environment", async () => {
    vi.stubEnv("AGNTN_CLOUDFLARE_ACCOUNT_ID", "account");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
    vi.stubEnv("AGNTN_MEMORY_NAMESPACE", "default");
    vi.stubEnv("AGNTN_MEMORY_PROFILE", "oritwoen");
    vi.stubEnv("CLAUDE_PROJECT_DIR", "");
    vi.stubEnv("CLAUDE_CODE_SESSION_ID", "");
    vi.stubEnv("GROK_SESSION_ID", "grok-conversation-123");
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({
          url: String(input),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return Response.json({
          success: true,
          result: {
            id: "memory-grok",
            type: "fact",
            summary: "remembered",
            content: "remembered",
            sessionId: null,
            createdAt: "2026-08-25T00:00:00.000Z",
            updatedAt: "2026-08-25T00:00:00.000Z",
          },
        });
      }),
    );
    const client = await connectTestClient();

    const response = await client.callTool({
      name: "memory_remember",
      arguments: { content: "one canonical memory" },
    });

    expect(response.isError).not.toBe(true);
    expect(requests).toEqual([
      {
        url: expect.stringContaining("/namespaces/default/profiles/oritwoen/remember"),
        body: {
          content: "one canonical memory",
          sessionId: memorySessionId("grok", process.cwd(), "grok-conversation-123"),
        },
      },
    ]);
  });

  it("executes a tool against the configured Cloudflare namespace", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubEnv("AGNTN_CLOUDFLARE_ACCOUNT_ID", "account");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({
          url: String(input),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return Response.json({
          success: true,
          result: {
            id: "memory-1",
            type: "fact",
            summary: "remembered",
            content: "remembered",
            sessionId: null,
            createdAt: "2026-08-17T00:00:00.000Z",
            updatedAt: "2026-08-17T00:00:00.000Z",
          },
        });
      }),
    );
    const client = await connectTestClient();

    const response = await client.callTool({
      name: "memory_remember",
      arguments: {
        namespace: "mcp-remember-test",
        profile: "agent",
        content: "one",
        sessionId: "caller-owned-session",
      },
    });

    expect(response.isError).not.toBe(true);
    expect(response).not.toHaveProperty("structuredContent");
    expect(requests).toEqual([
      {
        url: expect.stringContaining("/namespaces/mcp-remember-test/profiles/agent/remember"),
        body: { content: "one", sessionId: "caller-owned-session" },
      },
    ]);
  });

  it("rejects arguments that do not match the published schema", async () => {
    const client = await connectTestClient();

    const response = await client.callTool({
      name: "memory_list",
      arguments: { namespace: "mcp-schema-test", profile: "agent", type: "not-a-memory-type" },
    });

    expect(response.isError).toBe(true);
    expect(response.content).toEqual([
      { type: "text", text: expect.stringContaining("Invalid arguments") },
    ]);
  });

  it("rejects a namespace that Cloudflare would not accept", async () => {
    const client = await connectTestClient();

    const response = await client.callTool({
      name: "memory_namespace_create",
      arguments: { namespace: "Invalid Namespace" },
    });

    expect(response.isError).toBe(true);
    expect(response.content).toEqual([
      { type: "text", text: expect.stringContaining("Invalid arguments at /namespace") },
    ]);
  });

  it("rejects an identifier that would escape its path segment", async () => {
    const client = await connectTestClient();

    const response = await client.callTool({
      name: "memory_delete",
      arguments: { namespace: "path-escape", profile: "agent", memoryId: ".." },
    });

    expect(response.isError).toBe(true);
    expect(response.content).toEqual([
      { type: "text", text: expect.stringContaining("Invalid arguments at /memoryId") },
    ]);
  });

  it("rejects a get identifier that would escape its path segment", async () => {
    const client = await connectTestClient();

    const response = await client.callTool({
      name: "memory_get",
      arguments: { namespace: "path-escape", profile: "agent", memoryIds: [".."] },
    });

    expect(response.isError).toBe(true);
    expect(response.content).toEqual([
      { type: "text", text: expect.stringContaining("Invalid arguments at /memoryIds/0") },
    ]);
  });

  it("rejects memory content the service would refuse for its size", async () => {
    const client = await connectTestClient();

    const response = await client.callTool({
      name: "memory_remember",
      arguments: { namespace: "size-check", profile: "agent", content: "a".repeat(32_769) },
    });

    expect(response.isError).toBe(true);
    expect(response.content).toEqual([
      { type: "text", text: expect.stringContaining("Invalid arguments at /content") },
    ]);
  });

  it("rejects an ingest timestamp without a time zone", async () => {
    const client = await connectTestClient();

    const response = await client.callTool({
      name: "memory_ingest",
      arguments: {
        namespace: "tz-check",
        profile: "agent",
        messages: [{ role: "user", content: "hi", timestamp: "2026-08-17T10:00:00" }],
      },
    });

    expect(response.isError).toBe(true);
    expect(response.content).toEqual([
      { type: "text", text: expect.stringContaining("Invalid arguments at /messages/0/timestamp") },
    ]);
  });

  it("rejects prototype property names as unknown tools", async () => {
    const client = await connectTestClient();

    const response = await client.callTool({ name: "toString", arguments: {} });

    expect(response.isError).toBe(true);
    expect(response.content).toEqual([{ type: "text", text: "Unknown memory tool: toString" }]);
  });

  it("keeps an unknown tool name on the error line", async () => {
    const client = await connectTestClient();

    const response = await client.callTool({
      name: 'unknown\n{"id":"forged"}',
      arguments: {},
    });

    expect(response.isError).toBe(true);
    expect(response.content).toEqual([
      { type: "text", text: 'Unknown memory tool: unknown {"id":"forged"}' },
    ]);
  });

  it("includes the network cause in an executor failure", async () => {
    vi.stubEnv("AGNTN_CLOUDFLARE_ACCOUNT_ID", "account");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
    const networkCause = new Error("getaddrinfo ENOTFOUND api.cloudflare.com");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed", { cause: networkCause });
      }),
    );
    const client = await connectTestClient();

    const response = await client.callTool({
      name: "memory_remember",
      arguments: {
        namespace: "mcp-error-test",
        profile: "agent",
        content: "one",
      },
    });

    expect(response.isError).toBe(true);
    expect(response.content).toEqual([
      {
        type: "text",
        text: "memory_remember failed: No complete answer came back from Cloudflare Agent Memory, and a write that fails this way may still have landed, so repeat it only once a read shows it did not: fetch failed: getaddrinfo ENOTFOUND api.cloudflare.com",
      },
    ]);
  });

  it("does not serialize fields from non-Error failure causes", async () => {
    vi.stubEnv("AGNTN_CLOUDFLARE_ACCOUNT_ID", "account");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw { kind: "network", apiToken: "do-not-leak" };
      }),
    );
    const client = await connectTestClient();
    useRetryTimers();

    const call = client.callTool({
      name: "memory_get",
      arguments: {
        namespace: "mcp-error-test",
        profile: "agent",
        memoryIds: ["mem-1"],
      },
    });
    await settle(call);
    const response = await call;

    expect(response.isError).toBe(true);
    expect(response.content).toEqual([
      {
        type: "text",
        text: "memory_get failed: No complete answer came back from Cloudflare Agent Memory after 3 attempts, which usually passes, so try the call again later",
      },
    ]);
    expect(JSON.stringify(response)).not.toContain("do-not-leak");
  });

  it("reports an executor failure as a tool error", async () => {
    vi.stubEnv("AGNTN_CLOUDFLARE_ACCOUNT_ID", "");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
    const client = await connectTestClient();

    const response = await client.callTool({
      name: "memory_namespace_list",
      arguments: {},
    });

    expect(response.isError).toBe(true);
    expect(response.content).toEqual([
      { type: "text", text: expect.stringContaining("memory_namespace_list failed:") },
    ]);
  });
});
