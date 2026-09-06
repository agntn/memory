import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import memoryExtension from "../packages/pi/extensions/memory.ts";
import { toolErrorMessage } from "../packages/shared/tool-errors.ts";

const context = {
  cwd: "/workspace/memory-test",
  sessionManager: { getSessionId: () => "test-session" },
} as ExtensionContext;

function tools(): Pick<ToolDefinition, "name" | "execute">[] {
  const registered: Pick<ToolDefinition, "name" | "execute">[] = [];
  const api = {
    registerTool: ((tool) => {
      registered.push(tool);
    }) satisfies ExtensionAPI["registerTool"],
  };
  /** The extension only uses registerTool; the fixture omits the rest of the host. */
  memoryExtension(api as ExtensionAPI);
  return registered;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Pi execution errors", () => {
  it("sanitizes nested causes and stops at a cycle", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "account");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
    const cause = new Error(`DNS${String.fromCodePoint(10, 0x2028, 0x202e)}failed`);
    cause.cause = cause;
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed", { cause });
    });
    const tool = tools().find((candidate) => candidate.name === "memory_namespace_list");
    if (!tool) throw new Error("Missing namespace list tool");
    await expect(tool.execute("call-1", {}, undefined, undefined, context)).rejects.toThrow(
      "fetch failed: DNS   failed",
    );
  });

  it("passes cancellation through to fetch", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "account");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
    const signal = AbortSignal.abort(new Error("cancelled"));
    vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
      expect(init?.signal).toBe(signal);
      init?.signal?.throwIfAborted();
      throw new Error("Expected cancellation");
    });
    const tool = tools().find((candidate) => candidate.name === "memory_namespace_list");
    if (!tool) throw new Error("Missing namespace list tool");
    await expect(tool.execute("call-1", {}, signal, undefined, context)).rejects.toThrow(
      "cancelled",
    );
  });

  it("limits cause traversal to eight errors", () => {
    let error = new Error("8");
    for (let index = 7; index >= 0; index -= 1) error = new Error(String(index), { cause: error });
    expect(toolErrorMessage(error)).toBe("0: 1: 2: 3: 4: 5: 6: 7");
  });

  it("does not serialize arbitrary cause fields", () => {
    expect(toolErrorMessage(new Error("failed", { cause: { apiToken: "do-not-leak" } }))).toBe(
      "failed",
    );
    expect(toolErrorMessage({ apiToken: "do-not-leak" })).toBe("Unknown error");
  });
  it.each([
    ["memory_namespace_list", {}],
    ["memory_remember", { content: "synthetic" }],
    ["memory_recall", { query: "synthetic" }],
  ])("keeps the network cause in %s without retrying", async (name, params) => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "account");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
    const fetch = vi.fn(async () => {
      throw new TypeError("fetch failed", {
        cause: new Error("getaddrinfo ENOTFOUND example.invalid"),
      });
    });
    vi.stubGlobal("fetch", fetch);
    const tool = tools().find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`Missing tool: ${name}`);

    await expect(
      tool.execute(
        "call-1",
        { namespace: "test", profile: "agent", ...params },
        new AbortController().signal,
        undefined,
        context,
      ),
    ).rejects.toThrow("fetch failed: getaddrinfo ENOTFOUND example.invalid");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
