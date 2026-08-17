import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI as PiExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI as OmpExtensionAPI } from "@oh-my-pi/pi-coding-agent";
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

function requiresNamespace(tool: RegisteredTool): boolean {
  const required = tool.parameters.required;
  return (
    (Array.isArray(required) && required.includes("namespace")) ||
    tool.parameters.ir?.props?.some(
      (property) => property.key === "namespace" && property.opt === false,
    ) === true
  );
}

describe("memory extensions", () => {
  it("registers the complete Pi tool surface", () => {
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
