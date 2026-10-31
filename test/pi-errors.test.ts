import type {
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { settle, useRetryTimers } from "./fake-timers.ts";
import memoryExtension from "../extensions/pi/memory.ts";
import { toolErrorMessage } from "../extensions/shared/tool-errors.ts";

const context = {
  cwd: "/workspace/memory-test",
  sessionManager: { getSessionId: () => "test-session" },
} as ExtensionToolContext;

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
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Pi execution errors", () => {
  it("sanitizes nested causes and stops at a cycle", async () => {
    vi.stubEnv("AGNTN_CLOUDFLARE_ACCOUNT_ID", "account");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
    const cause = new Error(`DNS${String.fromCodePoint(10, 0x2028, 0x202e)}failed`);
    cause.cause = cause;
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed", { cause });
    });
    const tool = tools().find((candidate) => candidate.name === "memory_namespace_list");
    if (!tool) throw new Error("Missing namespace list tool");
    useRetryTimers();
    const execution = tool
      .execute("call-1", {}, undefined, undefined, context)
      .catch((failure: unknown) => failure);
    await settle(execution);
    expect(String(await execution)).toContain("fetch failed: DNS   failed");
  });

  it("passes cancellation through to fetch", async () => {
    vi.stubEnv("AGNTN_CLOUDFLARE_ACCOUNT_ID", "account");
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

  it.each([
    [
      "every address refused",
      Object.assign(
        new AggregateError(
          [
            new Error("connect ECONNREFUSED ::1:59999"),
            new Error("connect ECONNREFUSED 127.0.0.1:59999"),
          ],
          "",
        ),
        { code: "ECONNREFUSED" },
      ),
      "fetch failed: connect ECONNREFUSED ::1:59999; connect ECONNREFUSED 127.0.0.1:59999",
    ],
    [
      "an aggregate with nothing but a code",
      Object.assign(new AggregateError([], ""), { code: "ECONNRESET" }),
      "fetch failed: ECONNRESET",
    ],
    [
      "a connect timeout",
      Object.assign(
        new Error("Connect Timeout Error (attempted address: example.com:443, timeout: 10000ms)"),
        { code: "UND_ERR_CONNECT_TIMEOUT" },
      ),
      "fetch failed: UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error (attempted address: example.com:443, timeout: 10000ms)",
    ],
    [
      "a self-signed certificate",
      Object.assign(new Error("self-signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }),
      "fetch failed: DEPTH_ZERO_SELF_SIGNED_CERT: self-signed certificate",
    ],
    [
      "a missing domain",
      Object.assign(new Error("getaddrinfo ENOTFOUND example.invalid"), { code: "ENOTFOUND" }),
      "fetch failed: getaddrinfo ENOTFOUND example.invalid",
    ],
    ["a numeric code", Object.assign(new Error("exited"), { code: 1 }), "fetch failed: exited"],
    [
      "control bytes in an address error",
      new AggregateError(
        [new Error(`connect${String.fromCodePoint(10, 0x1b)}[31mECONNREFUSED`)],
        "",
      ),
      "fetch failed: connect  [31mECONNREFUSED",
    ],
  ])("names the reason for %s", (_shape, cause, expected) => {
    expect(toolErrorMessage(new TypeError("fetch failed", { cause }))).toBe(expected);
  });

  it("does not serialize arbitrary cause fields", () => {
    expect(toolErrorMessage(new Error("failed", { cause: { apiToken: "do-not-leak" } }))).toBe(
      "failed",
    );
    expect(toolErrorMessage({ apiToken: "do-not-leak" })).toBe("Unknown error");
  });
  const unreachable = "No complete answer came back from Cloudflare Agent Memory";
  const readFailure = `${unreachable} after 3 attempts, which usually passes, so try the call again later`;
  const writeFailure = `${unreachable}, and a write that fails this way may still have landed, so repeat it only once a read shows it did not`;
  it.each([
    ["memory_namespace_list", {}, readFailure, 3],
    [
      "memory_remember",
      { namespace: "test", profile: "agent", content: "synthetic" },
      writeFailure,
      1,
    ],
    ["memory_recall", { namespace: "test", profile: "agent", query: "synthetic" }, readFailure, 3],
  ])("keeps the network cause in %s", async (name, params, failure, calls) => {
    useRetryTimers();
    vi.stubEnv("AGNTN_CLOUDFLARE_ACCOUNT_ID", "account");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
    const fetch = vi.fn(async () => {
      throw new TypeError("fetch failed", {
        cause: new Error("getaddrinfo ENOTFOUND example.invalid"),
      });
    });
    vi.stubGlobal("fetch", fetch);
    const tool = tools().find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`Missing tool: ${name}`);

    const execution = tool
      .execute("call-1", params, new AbortController().signal, undefined, context)
      .catch((cause: unknown) => cause);
    await settle(execution);

    expect(await execution).toHaveProperty(
      "message",
      `${failure}: fetch failed: getaddrinfo ENOTFOUND example.invalid`,
    );
    expect(fetch).toHaveBeenCalledTimes(calls);
  });
});
