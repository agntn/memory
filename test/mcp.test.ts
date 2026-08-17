import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpServer } from "../src/mcp.ts";

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

  it("executes a tool against the configured Cloudflare namespace", async () => {
    const urls: string[] = [];
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "account");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        urls.push(String(input));
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
      arguments: { namespace: "mcp-remember-test", profile: "agent", content: "one" },
    });

    expect(response.isError).not.toBe(true);
    expect(response).not.toHaveProperty("structuredContent");
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/namespaces/mcp-remember-test/profiles/agent/remember");
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
