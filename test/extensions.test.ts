import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI as PiExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult, ExtensionAPI as OmpExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import * as OmpTypebox from "@oh-my-pi/omptype/typebox";
import piMemoryExtension from "../packages/pi/extensions/memory.ts";
import ompMemoryExtension from "../packages/omp/extensions/memory.ts";
import type { RegisteredTool } from "./extensions.types.ts";
import { memoryToolExecutors } from "../packages/shared/memory-tools.ts";

vi.mock("@earendil-works/pi-tui", () => ({
  Text: class Text {},
}));
vi.mock("@oh-my-pi/pi-tui", () => ({
  Text: class Text {},
}));

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

function listLimit(tools: RegisteredTool[]): number | undefined {
  const parameters = tools.find((tool) => tool.name === "memory_list")?.parameters;
  return (
    parameters?.properties?.limit?.maximum ??
    parameters?.ir?.props?.find((property) => property.key === "limit")?.val?.max
  );
}

function requiredFields(tool: RegisteredTool): string[] {
  const required = tool.parameters.required;
  if (Array.isArray(required)) return required;
  return (
    tool.parameters.ir?.props
      ?.filter((property) => property.opt === false)
      .map((property) => property.key)
      .filter((key): key is string => typeof key === "string") ?? []
  );
}

function requiresNamespace(tool: RegisteredTool): boolean {
  return requiredFields(tool).includes("namespace");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("memory extensions", () => {
  it("registers the complete Pi tool surface", () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/nonexistent/agntn-memory-test");
    const tools: RegisteredTool[] = [];
    piMemoryExtension({
      registerTool(tool: RegisteredTool) {
        tools.push(tool);
      },
    } as unknown as PiExtensionAPI);

    expect(tools.map((tool) => tool.name)).toEqual(expectedNames);
    expect(listLimit(tools)).toBe(100);
    expect(
      tools.filter((tool) => tool.name !== "memory_namespace_list").every(requiresNamespace),
    ).toBe(true);
    expect(requiresNamespace(tools[0]!)).toBe(false);
  });

  it("registers the complete OMP tool surface with native approvals", () => {
    const tools: RegisteredTool[] = [];
    ompMemoryExtension({
      typebox: OmpTypebox,
      registerTool(tool: RegisteredTool) {
        tools.push(tool);
      },
    } as unknown as OmpExtensionAPI);

    expect(tools.map((tool) => tool.name)).toEqual(expectedNames);
    expect(listLimit(tools)).toBe(100);
    expect(
      tools.filter((tool) => tool.name !== "memory_namespace_list").every(requiresNamespace),
    ).toBe(true);
    expect(requiresNamespace(tools[0]!)).toBe(false);
    expect(tools.map((tool) => tool.approval)).toEqual([
      "read",
      "write",
      "write",
      "write",
      "write",
      "read",
      "read",
      "read",
      "write",
      "read",
      "write",
      "write",
    ]);
  });

  it("binds Pi operational tools to the canonical scope and session", async () => {
    vi.stubEnv("AGNTN_MEMORY_NAMESPACE", "default");
    vi.stubEnv("AGNTN_MEMORY_PROFILE", "oritwoen");
    const tools: RegisteredTool[] = [];
    piMemoryExtension({
      registerTool(tool: RegisteredTool) {
        tools.push(tool);
      },
    } as unknown as PiExtensionAPI);
    const remember = tools.find((tool) => tool.name === "memory_remember") as
      | (RegisteredTool & {
          execute(...args: unknown[]): Promise<AgentToolResult<Record<string, unknown>>>;
        })
      | undefined;
    expect(remember).toBeDefined();
    expect(requiresNamespace(remember!)).toBe(false);
    expect(requiredFields(remember!)).toEqual(["content"]);
    const execute = vi
      .spyOn(memoryToolExecutors, "remember")
      .mockResolvedValue({ content: [{ type: "text", text: "remembered" }], details: {} });

    await remember!.execute("call-1", { content: "canonical" }, undefined, undefined, {
      cwd: "/workspace/movie-enigma",
      sessionManager: { getSessionId: () => "pi-session-123" },
    });

    expect(execute).toHaveBeenCalledWith({
      namespace: "default",
      profile: "oritwoen",
      content: "canonical",
      sessionId: expect.stringMatching(/^pi-movie-enigma-[0-9a-f]{16}$/),
    });
  });

  it("binds Pi operational tools from its agent-local scope file", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "agntn-memory-pi-"));
    try {
      writeFileSync(
        join(agentDir, "memory-scope.json"),
        JSON.stringify({ namespace: "default", profile: "oritwoen" }),
      );
      vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
      const tools: RegisteredTool[] = [];
      piMemoryExtension({
        registerTool(tool: RegisteredTool) {
          tools.push(tool);
        },
      } as unknown as PiExtensionAPI);
      const remember = tools.find((tool) => tool.name === "memory_remember") as
        | (RegisteredTool & {
            execute(...args: unknown[]): Promise<AgentToolResult<Record<string, unknown>>>;
          })
        | undefined;
      expect(remember).toBeDefined();
      expect(requiredFields(remember!)).toEqual(["content"]);
      expect(requiresNamespace(remember!)).toBe(false);
      const execute = vi
        .spyOn(memoryToolExecutors, "remember")
        .mockResolvedValue({ content: [{ type: "text", text: "remembered" }], details: {} });

      await remember!.execute("call-1", { content: "canonical" }, undefined, undefined, {
        cwd: "/workspace/movie-enigma",
        sessionManager: { getSessionId: () => "pi-session-file" },
      });

      expect(execute).toHaveBeenCalledWith({
        namespace: "default",
        profile: "oritwoen",
        content: "canonical",
        sessionId: expect.stringMatching(/^pi-movie-enigma-[0-9a-f]{16}$/),
      });
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("binds OMP operational tools to the canonical scope and session", async () => {
    vi.stubEnv("AGNTN_MEMORY_NAMESPACE", "default");
    vi.stubEnv("AGNTN_MEMORY_PROFILE", "oritwoen");
    const tools: RegisteredTool[] = [];
    ompMemoryExtension({
      typebox: OmpTypebox,
      registerTool(tool: RegisteredTool) {
        tools.push(tool);
      },
    } as unknown as OmpExtensionAPI);
    const remember = tools.find((tool) => tool.name === "memory_remember") as
      | (RegisteredTool & {
          execute(...args: unknown[]): Promise<AgentToolResult<Record<string, unknown>>>;
        })
      | undefined;
    expect(remember).toBeDefined();
    expect(requiresNamespace(remember!)).toBe(false);
    expect(requiredFields(remember!)).toEqual(["content"]);
    const execute = vi
      .spyOn(memoryToolExecutors, "remember")
      .mockResolvedValue({ content: [{ type: "text", text: "remembered" }], details: {} });

    await remember!.execute("call-1", { content: "canonical" }, undefined, undefined, {
      cwd: "/workspace/movie-enigma",
      sessionManager: { getSessionId: () => "omp-session-123" },
    });

    expect(execute).toHaveBeenCalledWith({
      namespace: "default",
      profile: "oritwoen",
      content: "canonical",
      sessionId: expect.stringMatching(/^omp-movie-enigma-[0-9a-f]{16}$/),
    });
  });

  it("selects the Cloudflare namespace independently for every tool call", async () => {
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
            id: `memory-${urls.length}`,
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

    try {
      await memoryToolExecutors.remember({
        namespace: "first",
        profile: "agent",
        content: "one",
      });
      await memoryToolExecutors.remember({
        namespace: "second",
        profile: "agent",
        content: "two",
      });
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }

    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("/namespaces/first/profiles/agent/remember");
    expect(urls[1]).toContain("/namespaces/second/profiles/agent/remember");
  });

  it("ignores empty optional strings emitted by an extension host", async () => {
    const urls: string[] = [];
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "account");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        urls.push(String(input));
        return Response.json({ success: true, result: [] });
      }),
    );

    try {
      await memoryToolExecutors.list({
        namespace: "empty-option-test",
        profile: "agent",
        limit: 1,
        cursor: "",
        sessionId: "",
      });
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }

    expect(urls).toEqual([
      "https://api.cloudflare.com/client/v4/accounts/account/agent-memory/namespaces/empty-option-test/profiles/agent/memories?per_page=1",
    ]);
  });
});
