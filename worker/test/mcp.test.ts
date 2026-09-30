import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";

interface RecordedSpan {
  name: string;
  attributes: Record<string, unknown>;
  ended: boolean;
}

const spans: RecordedSpan[] = [];

vi.mock("cloudflare:workers", () => ({
  tracing: {
    startActiveSpan(name: string, run: (span: unknown) => unknown) {
      const recorded: RecordedSpan = { name, attributes: {}, ended: false };
      spans.push(recorded);
      return run({
        isTraced: true,
        setAttribute(key: string, value: unknown) {
          recorded.attributes[key] = value;
        },
        end() {
          recorded.ended = true;
        },
      });
    },
  },
}));

const { bindingMemoryBackend } = await import("../src/backend.ts");
const { createMemoryServer } = await import("../src/mcp.ts");

const stored = {
  id: "mem-1",
  type: "fact" as const,
  summary: "Ori prefers Node.js",
  content: "Ori runs TypeScript through node, not Bun.",
  sessionId: null,
  createdAt: new Date("2026-09-30T10:00:00.000Z"),
  updatedAt: new Date("2026-09-30T10:00:00.000Z"),
};

function fakeBinding() {
  const profile = {
    remember: vi.fn(async () => stored),
    ingest: vi.fn(async () => {}),
    recall: vi.fn(async () => ({ count: 0, candidates: [] })),
    list: vi.fn(async () => ({ memories: [] })),
    get: vi.fn(async () => stored),
    delete: vi.fn(async () => stored),
    deleteSession: vi.fn(async () => {}),
    getSummary: vi.fn(async () => ({ summary: "" })),
  };
  return {
    profile,
    binding: {
      getProfile: vi.fn(async () => profile),
      deleteProfile: vi.fn(async () => {}),
    },
  };
}

async function connect(binding: ReturnType<typeof fakeBinding>["binding"], tracePayloads = false) {
  const handler = createMcpHandler(() =>
    createMemoryServer({
      backend: bindingMemoryBackend("default", binding),
      scope: { namespace: "default", profile: "oritwoen" },
      tracePayloads,
    }),
  );
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: (input, init) => handler.fetch(new Request(input, init)),
    }),
  );
  return client;
}

afterEach(() => {
  spans.length = 0;
});

describe("remote memory server", () => {
  it("lists only the bound operational tools", async () => {
    const client = await connect(fakeBinding().binding);
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);

    expect(names).toContain("memory_recall");
    expect(names).toContain("memory_remember");
    expect(names.filter((name) => name.startsWith("memory_namespace_"))).toEqual([]);
    expect(names).not.toContain("memory_profile_list");
    expect(names).not.toContain("memory_delete_profile");
    for (const tool of tools) {
      expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain("namespace");
      expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain("profile");
    }
  });

  it("files a write under the bound profile and traces the call without payloads", async () => {
    const { binding, profile } = fakeBinding();
    const client = await connect(binding);
    const result = await client.callTool({
      name: "memory_remember",
      arguments: { content: "Ori runs TypeScript through node, not Bun." },
    });

    expect(result.isError).toBeFalsy();
    expect(binding.getProfile).toHaveBeenCalledWith("oritwoen");
    expect(profile.remember).toHaveBeenCalledWith({
      content: "Ori runs TypeScript through node, not Bun.",
      sessionId: undefined,
    });
    expect(JSON.stringify(result.content)).toContain("mem-1");
    expect(spans).toEqual([
      {
        name: "execute_tool memory_remember",
        attributes: {
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.type": "function",
          "gen_ai.tool.name": "memory_remember",
          "mcp.method.name": "tools/call",
        },
        ended: true,
      },
    ]);
  });

  it("records tool payloads only when asked to", async () => {
    const client = await connect(fakeBinding().binding, true);
    await client.callTool({ name: "memory_get", arguments: { memoryIds: ["mem-1"] } });

    const [span] = spans;
    expect(span?.attributes["gen_ai.tool.call.arguments"]).toBe('{"memoryIds":["mem-1"]}');
    expect(span?.attributes["gen_ai.tool.call.result"]).toContain("mem-1");
  });

  it("refuses a tool the remote surface does not serve and marks the span", async () => {
    const client = await connect(fakeBinding().binding);
    const result = await client.callTool({ name: "memory_namespace_delete", arguments: {} });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(
      "Unknown memory tool: memory_namespace_delete",
    );
    expect(spans[0]).toMatchObject({
      name: "execute_tool unknown",
      attributes: { "error.type": "tool_error" },
      ended: true,
    });
  });
});

describe("binding backend", () => {
  it("serves only its own namespace and no namespace management", async () => {
    const backend = bindingMemoryBackend("default", fakeBinding().binding);

    await expect(backend.provider("other")).rejects.toThrow(
      "This server is bound to namespace default",
    );
    await expect(backend.namespaces()).rejects.toThrow("no namespace management");
  });
});
