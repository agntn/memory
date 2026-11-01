import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { toolErrorMessage } from "../extensions/shared/tool-errors.ts";

interface CfState {
  whoami: Record<string, unknown>;
  token?: string;
  expiresAt?: string;
}

const credentialsFile = join(mkdtempSync(join(tmpdir(), "cf-oauth-")), "default.json");
let cf: CfState;

/* Answer `cf auth whoami` the way cf 1.0.0-beta.5 does for an OAuth login. */
function stubCf(): void {
  vi.mocked(execFile).mockClear();
  vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
    const [file, argv, , callback] = args as [
      string,
      string[],
      unknown,
      (error: Error | null, stdout: string, stderr: string) => void,
    ];
    expect([file, ...argv]).toEqual(["cf", "auth", "whoami"]);
    writeFileSync(
      credentialsFile,
      JSON.stringify({ oauth_token: cf.token, expiration_time: cf.expiresAt, scopes: [] }),
    );
    queueMicrotask(() => callback(null, JSON.stringify(cf.whoami), ""));
  }) as unknown as typeof execFile);
}

function loggedIn(accounts: string[]): Record<string, unknown> {
  return {
    authenticated: true,
    authSource: `OAuth token from ${credentialsFile}`,
    tokenValid: true,
    accounts: accounts.map((id) => ({ id, name: id })),
  };
}

async function loadCredentials(): Promise<
  typeof import("../extensions/shared/cloudflare-credentials.ts")
> {
  vi.resetModules();
  return import("../extensions/shared/cloudflare-credentials.ts");
}

/* A fresh Pi extension starts with an empty credential cache; its host only needs registerTool. */
async function piTool(name: string): Promise<Pick<ToolDefinition, "execute">> {
  vi.resetModules();
  const { default: memoryExtension } = await import("../extensions/pi/memory.ts");
  const registered: Pick<ToolDefinition, "name" | "execute">[] = [];
  memoryExtension({
    registerTool: (tool: Pick<ToolDefinition, "name" | "execute">) => registered.push(tool),
  } as unknown as ExtensionAPI);
  const tool = registered.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing ${name}`);
  return tool;
}

const piContext = {
  cwd: "/workspace/memory-test",
  sessionManager: { getSessionId: () => "test-session" },
} as ExtensionToolContext;

beforeEach(() => {
  cf = {
    whoami: loggedIn(["acct-1"]),
    token: "oauth-1",
    expiresAt: "2026-09-30T09:00:00.000Z",
  };
  stubCf();
  vi.useFakeTimers({ now: new Date("2026-09-30T08:00:00.000Z"), toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Cloudflare credentials", () => {
  it("renames the env token for the memory client and never asks cf", async () => {
    vi.stubEnv("AGNTN_CLOUDFLARE_ACCOUNT_ID", "env-account");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "env-token");
    const { getCloudflareCredentials } = await loadCredentials();

    await expect(getCloudflareCredentials()).resolves.toEqual({
      accountId: "env-account",
      apiToken: "env-token",
    });
    expect(execFile).not.toHaveBeenCalled();
  });

  it("falls back to CLOUDFLARE_ACCOUNT_ID after AGNTN_CLOUDFLARE_ACCOUNT_ID", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "wrangler-account");
    cf.whoami = loggedIn(["acct-1", "acct-2"]);
    const { getCloudflareCredentials } = await loadCredentials();

    await expect(getCloudflareCredentials()).resolves.toEqual({
      accountId: "wrangler-account",
      apiToken: "oauth-1",
    });

    vi.stubEnv("AGNTN_CLOUDFLARE_ACCOUNT_ID", "acct-2");
    await expect(getCloudflareCredentials()).resolves.toMatchObject({ accountId: "acct-2" });
  });

  it("names both ways out when cf is not installed", async () => {
    vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error) => void;
      queueMicrotask(() =>
        callback(Object.assign(new Error("spawn cf ENOENT"), { code: "ENOENT" })),
      );
    }) as unknown as typeof execFile);
    const { getCloudflareCredentials } = await loadCredentials();

    await expect(getCloudflareCredentials()).rejects.toThrow(
      "cf CLI not found. Set CLOUDFLARE_API_TOKEN, or run `cf auth login`",
    );
  });

  it("reports a credentials file it cannot parse without quoting it", async () => {
    vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
      const callback = args.at(-1) as (error: null, stdout: string) => void;
      writeFileSync(credentialsFile, "cfk_SECRET encrypted by the keyring");
      queueMicrotask(() => callback(null, JSON.stringify(loggedIn(["acct-1"]))));
    }) as unknown as typeof execFile);
    const { getCloudflareCredentials } = await loadCredentials();

    const error = await getCloudflareCredentials().catch((failure: unknown) => failure);
    const message = toolErrorMessage(error);
    expect(message).toContain("Cannot read the cf OAuth credentials file");
    expect(message).not.toContain("SECRET");
  });
});

describe("memory tools with the cf OAuth session", () => {
  it("send the current cf token and pick up a rotated one a minute early", async () => {
    const authorizations: (string | null)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        authorizations.push(new Headers(init?.headers).get("Authorization"));
        return Response.json({ success: true, result: [], result_info: {} });
      }),
    );
    vi.resetModules();
    const { memoryToolExecutors } = await import("../extensions/shared/memory-tools.ts");

    await memoryToolExecutors.listNamespaces({});
    cf.token = "oauth-2";
    cf.expiresAt = "2026-09-30T10:00:00.000Z";
    vi.setSystemTime(new Date("2026-09-30T08:59:30.000Z"));
    await memoryToolExecutors.listNamespaces({});

    expect(authorizations).toEqual(["Bearer oauth-1", "Bearer oauth-2"]);
    const urls = vi.mocked(fetch).mock.calls.map(([input]) => String(input));
    expect(urls.every((url) => url.includes("/accounts/acct-1/agent-memory/"))).toBe(true);
  });

  it("ask cf for a fresh token after a 401 and never resend the refused one", async () => {
    const authorizations: (string | null)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const authorization = new Headers(init?.headers).get("Authorization");
        authorizations.push(authorization);
        if (authorization === "Bearer oauth-1") {
          return Response.json(
            { success: false, errors: [{ code: 10000, message: "Authentication error" }] },
            { status: 401 },
          );
        }
        return Response.json({ success: true, result: [], result_info: {} });
      }),
    );
    const tool = await piTool("memory_namespace_list");

    await expect(tool.execute("call-1", {}, undefined, undefined, piContext)).rejects.toThrow(
      "Authentication error",
    );
    cf.token = "oauth-2";
    await tool.execute("call-2", {}, undefined, undefined, piContext);

    expect(authorizations).toEqual(["Bearer oauth-1", "Bearer oauth-2"]);
    expect(execFile).toHaveBeenCalledTimes(2);
  });
});
