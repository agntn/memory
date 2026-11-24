import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  memorySessionId,
  shellMemoryHarness,
  shellMemorySessionId,
} from "../extensions/shared/memory-scope.ts";
import { runMemoryCli } from "../src/cli-run.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("memory CLI under an agent shell", () => {
  it.each([
    [{ OPENCODE_SESSION_ID: "ses_1" }, "opencode", "opencode"],
    [{ OPENCODE_SESSION_ID: " " }, undefined, undefined],
    [{ GROK_SESSION_ID: "g-1", OPENCODE_SESSION_ID: "ses_1" }, "grok", "grok"],
    [
      { CLAUDE_PROJECT_DIR: "/work", CLAUDE_CODE_SESSION_ID: "c-1", OPENCODE_SESSION_ID: "ses_1" },
      "claude",
      "claude",
    ],
    [{ CODEX_THREAD_ID: "019a0000-0000-7000-8000-000000000001" }, "codex", "codex"],
    [{ CODEX_THREAD_ID: " " }, undefined, undefined],
    [{ OPENCODE_SESSION_ID: "ses_1", CODEX_THREAD_ID: "t-1" }, "opencode", "opencode"],
    [
      { CLAUDE_PROJECT_DIR: "/work", CLAUDE_CODE_SESSION_ID: "c-1", CODEX_THREAD_ID: "t-1" },
      "claude",
      "claude",
    ],
  ])("reads %j as the %s harness", (env, harness, prefix) => {
    expect(shellMemoryHarness(env)).toBe(harness);
    expect(shellMemorySessionId(env, "/work")?.split("-")[0]).toBe(prefix);
  });

  it("stamps the opencode session and harness on a write from its shell", async () => {
    vi.stubEnv("AGNTN_CLOUDFLARE_ACCOUNT_ID", "account");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
    vi.stubEnv("GROK_SESSION_ID", "");
    vi.stubEnv("OPENCODE_SESSION_ID", "ses_e1ac4351effe0etgPhltR02sUD");
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({
          success: true,
          result: {
            id: "memory-opencode",
            type: "fact",
            summary: "remembered",
            content: "remembered",
            sessionId: null,
            createdAt: "2026-11-16T00:00:00.000Z",
            updatedAt: "2026-11-16T00:00:00.000Z",
          },
        });
      }),
    );
    vi.spyOn(process.stdout, "write").mockReturnValue(true);

    await runMemoryCli([
      "remember",
      "--namespace",
      "notes",
      "--profile",
      "main",
      "--content",
      "hi",
    ]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.sessionId).toBe(
      memorySessionId("opencode", process.cwd(), "ses_e1ac4351effe0etgPhltR02sUD"),
    );
    expect(String(bodies[0]?.content)).toContain("harness: opencode");
  });

  it("stamps the Codex thread and harness on a write from its shell", async () => {
    vi.stubEnv("AGNTN_CLOUDFLARE_ACCOUNT_ID", "account");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
    vi.stubEnv("GROK_SESSION_ID", "");
    vi.stubEnv("CODEX_THREAD_ID", "019a0000-0000-7000-8000-000000000001");
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({
          success: true,
          result: {
            id: "memory-codex",
            type: "fact",
            summary: "remembered",
            content: "remembered",
            sessionId: null,
            createdAt: "2026-11-24T00:00:00.000Z",
            updatedAt: "2026-11-24T00:00:00.000Z",
          },
        });
      }),
    );
    vi.spyOn(process.stdout, "write").mockReturnValue(true);

    await runMemoryCli([
      "remember",
      "--namespace",
      "notes",
      "--profile",
      "main",
      "--content",
      "hi",
    ]);

    expect(process.exitCode ?? 0).toBe(0);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.sessionId).toBe(
      memorySessionId("codex", process.cwd(), "019a0000-0000-7000-8000-000000000001"),
    );
    expect(String(bodies[0]?.content)).toContain("harness: codex");
  });
});
