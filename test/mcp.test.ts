import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpServer } from "../src/mcp.ts";
import { memorySessionId } from "../packages/shared/memory-scope.ts";

const openConnections: Array<{ close(): Promise<void> }> = [];

const expectedNames = [
  "memory_namespace_list",
  "memory_namespace_create",
  "memory_namespace_delete",
  "memory_remember",
  "memory_ingest",
  "memory_recall",
  "memory_list",
  "memory_get",
  "memory_delete",
  "memory_summary",
  "memory_delete_session",
  "memory_delete_profile",
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
    expect(
      response.tools.find((tool) => tool.name === "memory_recall")?.annotations?.readOnlyHint,
    ).toBe(true);
    expect(
      response.tools.find((tool) => tool.name === "memory_delete_profile")?.annotations
        ?.destructiveHint,
    ).toBe(true);
  });

  it("binds operational tools to configured scope and harness session", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "account");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
    vi.stubEnv("AGNTN_MEMORY_NAMESPACE", "default");
    vi.stubEnv("AGNTN_MEMORY_PROFILE", "oritwoen");
    vi.stubEnv("CLAUDE_PROJECT_DIR", "/workspace/movie-enigma");
    vi.stubEnv("CLAUDE_CODE_SESSION_ID", "conversation-123");
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

  it("executes a tool against the configured Cloudflare namespace", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "account");
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

  it("reports an executor failure as a tool error", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
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
