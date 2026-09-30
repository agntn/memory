import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toolErrorMessage } from "../packages/shared/tool-errors.ts";

interface CfState {
  whoami: Record<string, unknown>;
  token?: string;
  expiresAt?: string;
}

const credentialsFile = join(mkdtempSync(join(tmpdir(), "cf-oauth-")), "default.json");
let cf: CfState;
let cfEnv: NodeJS.ProcessEnv[];

/* Answer `cf auth whoami` the way cf 1.0.0-beta.5 does for an OAuth login. */
function stubCf(): void {
  cfEnv = [];
  vi.mocked(execFile).mockClear();
  vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
    const [file, argv, options, callback] = args as [
      string,
      string[],
      { env: NodeJS.ProcessEnv },
      (error: Error | null, stdout: string, stderr: string) => void,
    ];
    expect([file, ...argv]).toEqual(["cf", "auth", "whoami"]);
    cfEnv.push(options.env);
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
  typeof import("../packages/shared/cloudflare-credentials.ts")
> {
  vi.resetModules();
  return import("../packages/shared/cloudflare-credentials.ts");
}

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
  it("prefers the env token and never asks cf", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "env-account");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "env-token");
    const { getCloudflareCredentials } = await loadCredentials();

    await expect(getCloudflareCredentials()).resolves.toEqual({
      accountId: "env-account",
      apiToken: "env-token",
    });
    expect(execFile).not.toHaveBeenCalled();
  });

  it("still needs an account id beside an env token", async () => {
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "env-token");
    const { getCloudflareCredentials } = await loadCredentials();

    await expect(getCloudflareCredentials()).rejects.toThrow(
      "Set CLOUDFLARE_ACCOUNT_ID alongside CLOUDFLARE_API_TOKEN",
    );
  });

  it("takes the token and the only account from the cf OAuth session", async () => {
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
    const { getCloudflareCredentials } = await loadCredentials();

    await expect(getCloudflareCredentials()).resolves.toEqual({
      accountId: "acct-1",
      apiToken: "oauth-1",
    });
    expect(cfEnv[0]).not.toHaveProperty("CLOUDFLARE_API_TOKEN");
  });

  it("asks for an account id when the cf session reaches several", async () => {
    cf.whoami = loggedIn(["acct-1", "acct-2"]);
    const { getCloudflareCredentials } = await loadCredentials();

    await expect(getCloudflareCredentials()).rejects.toThrow(
      "Set CLOUDFLARE_ACCOUNT_ID: the cf OAuth session can reach 2 accounts",
    );

    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct-2");
    await expect(getCloudflareCredentials()).resolves.toEqual({
      accountId: "acct-2",
      apiToken: "oauth-1",
    });
  });

  it("reuses the cf token until it expires, then reads the refreshed one", async () => {
    const { getCloudflareCredentials } = await loadCredentials();

    await getCloudflareCredentials();
    vi.setSystemTime(new Date("2026-09-30T08:59:59.000Z"));
    await expect(getCloudflareCredentials()).resolves.toMatchObject({ apiToken: "oauth-1" });
    expect(execFile).toHaveBeenCalledTimes(1);

    cf.token = "oauth-2";
    cf.expiresAt = "2026-09-30T10:00:00.000Z";
    vi.setSystemTime(new Date("2026-09-30T09:00:00.000Z"));
    await expect(getCloudflareCredentials()).resolves.toMatchObject({ apiToken: "oauth-2" });
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it("runs cf once for concurrent callers", async () => {
    const { getCloudflareCredentials } = await loadCredentials();

    const results = await Promise.all([getCloudflareCredentials(), getCloudflareCredentials()]);

    expect(results.map((result) => result.apiToken)).toEqual(["oauth-1", "oauth-1"]);
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("asks cf again after a failed attempt", async () => {
    cf.whoami = { authenticated: false, error: "Not logged in" };
    const { getCloudflareCredentials } = await loadCredentials();

    await expect(getCloudflareCredentials()).rejects.toThrow(
      "cf CLI is not logged in. Set CLOUDFLARE_API_TOKEN, or run `cf auth login`",
    );

    cf.whoami = loggedIn(["acct-1"]);
    await expect(getCloudflareCredentials()).resolves.toMatchObject({ apiToken: "oauth-1" });
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

  it("refuses a cf session that authenticates with something other than OAuth", async () => {
    cf.whoami = {
      ...loggedIn(["acct-1"]),
      authSource: "CLOUDFLARE_API_TOKEN environment variable",
    };
    const { getCloudflareCredentials } = await loadCredentials();

    await expect(getCloudflareCredentials()).rejects.toThrow("cf CLI reports no OAuth session");
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
  it("send the current cf token and pick up a rotated one", async () => {
    const authorizations: (string | null)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        authorizations.push(new Headers(init?.headers).get("Authorization"));
        return Response.json({ success: true, result: [], result_info: {} });
      }),
    );
    vi.resetModules();
    const { memoryToolExecutors } = await import("../packages/shared/memory-tools.ts");

    await memoryToolExecutors.listNamespaces({});
    cf.token = "oauth-2";
    cf.expiresAt = "2026-09-30T10:00:00.000Z";
    vi.setSystemTime(new Date("2026-09-30T09:00:00.000Z"));
    await memoryToolExecutors.listNamespaces({});

    expect(authorizations).toEqual(["Bearer oauth-1", "Bearer oauth-2"]);
    const urls = vi.mocked(fetch).mock.calls.map(([input]) => String(input));
    expect(urls.every((url) => url.includes("/accounts/acct-1/agent-memory/"))).toBe(true);
  });
});
