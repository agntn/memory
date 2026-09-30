import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

export interface CloudflareCredentials {
  accountId: string;
  apiToken: string;
}

interface CfSession {
  accountIds: string[];
  apiToken: string;
  /** Milliseconds since the epoch; `undefined` when cf recorded no expiry. */
  expiresAt?: number;
}

const CF_OAUTH_SOURCE = "OAuth token from ";
const CF_TIMEOUT_MS = 30_000;
const CF_SETUP_HINT =
  "Set CLOUDFLARE_API_TOKEN, or run `cf auth login` to use the cf CLI's OAuth session";

let cfSession: CfSession | undefined;
let cfSessionPromise: Promise<CfSession> | undefined;

function envValue(name: string): string | undefined {
  const value = process.env[name];
  return value === "" ? undefined : value;
}

/**
 * Run `cf auth whoami` without the env token, which cf would report instead of its OAuth session.
 * @returns {Promise<string>} The JSON status cf prints.
 */
async function cfWhoami(): Promise<string> {
  const env = { ...process.env };
  delete env.CLOUDFLARE_API_TOKEN;
  try {
    return await new Promise((resolve, reject) => {
      execFile("cf", ["auth", "whoami"], { env, timeout: CF_TIMEOUT_MS }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      });
    });
  } catch (error) {
    const missing = isRecord(error) && error.code === "ENOENT";
    throw cfFailure(missing ? "cf CLI not found" : "cf auth whoami failed", error);
  }
}

function cfFailure(message: string, cause?: unknown): Error {
  return new Error(`${message}. ${CF_SETUP_HINT}`, cause === undefined ? {} : { cause });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/* The SyntaxError quotes the start of its input, so it never becomes a cause: the text reaches the model. */
function parseJson(text: string, failure: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw cfFailure(failure);
  }
}

/**
 * Read the OAuth token cf keeps in the file its status names.
 * @param source - The `authSource` line from `cf auth whoami`.
 * @returns {Promise<Record<string, unknown>>} The stored credentials with a token.
 */
async function readCfToken(
  source: unknown,
): Promise<Record<string, unknown> & { oauth_token: string }> {
  if (typeof source !== "string" || !source.startsWith(CF_OAUTH_SOURCE)) {
    throw cfFailure("cf CLI reports no OAuth session");
  }
  let text: string;
  try {
    text = await readFile(source.slice(CF_OAUTH_SOURCE.length), "utf8");
  } catch (error) {
    throw cfFailure("Cannot read the cf OAuth credentials file", error);
  }
  // An OS keyring keeps the file encrypted, and only cf can read it then.
  const stored = parseJson(text, "Cannot read the cf OAuth credentials file");
  if (!isRecord(stored) || typeof stored.oauth_token !== "string" || stored.oauth_token === "") {
    throw cfFailure("The cf OAuth credentials file holds no token");
  }
  return stored as Record<string, unknown> & { oauth_token: string };
}

function accountIds(accounts: unknown): string[] {
  if (!Array.isArray(accounts)) return [];
  return accounts.flatMap((account: unknown) =>
    isRecord(account) && typeof account.id === "string" ? [account.id] : [],
  );
}

/**
 * Ask cf for its OAuth session.
 *
 * `cf auth whoami` refreshes an expired access token before it reports, so the
 * credentials file it names holds a token that was valid at that moment. cf has
 * no command that prints the token itself.
 * @returns {Promise<CfSession>} The token, its expiry and the accounts it reaches.
 */
async function loadCfSession(): Promise<CfSession> {
  const status = parseJson(await cfWhoami(), "cf auth whoami did not print JSON");
  if (!isRecord(status) || status.authenticated !== true) {
    throw cfFailure("cf CLI is not logged in");
  }
  const stored = await readCfToken(status.authSource);
  const expiry =
    typeof stored.expiration_time === "string" ? Date.parse(stored.expiration_time) : NaN;
  return {
    accountIds: accountIds(status.accounts),
    apiToken: stored.oauth_token,
    ...(Number.isNaN(expiry) ? {} : { expiresAt: expiry }),
  };
}

function getCfSession(): Promise<CfSession> {
  if (cfSession?.expiresAt !== undefined && Date.now() < cfSession.expiresAt) {
    return Promise.resolve(cfSession);
  }
  cfSessionPromise ??= loadCfSession()
    .then((session) => {
      cfSession = session;
      return session;
    })
    .finally(() => {
      cfSessionPromise = undefined;
    });
  return cfSessionPromise;
}

function onlyAccount(ids: readonly string[]): string {
  if (ids.length === 1) return ids[0]!;
  throw new Error(
    ids.length === 0
      ? "Set CLOUDFLARE_ACCOUNT_ID: the cf OAuth session lists no accounts"
      : `Set CLOUDFLARE_ACCOUNT_ID: the cf OAuth session can reach ${ids.length} accounts`,
  );
}

/**
 * Resolve Cloudflare credentials for the memory tools.
 *
 * `CLOUDFLARE_API_TOKEN` wins when it is set. Without it the token comes from
 * the cf CLI's OAuth session and is fetched again once it expires, so the
 * caller must not keep it longer than one call. `CLOUDFLARE_ACCOUNT_ID` stays
 * optional with cf when the session reaches exactly one account.
 * @returns {Promise<CloudflareCredentials>} Credentials valid for the next request.
 */
export async function getCloudflareCredentials(): Promise<CloudflareCredentials> {
  const accountId = envValue("CLOUDFLARE_ACCOUNT_ID");
  const apiToken = envValue("CLOUDFLARE_API_TOKEN");
  if (apiToken !== undefined) {
    if (accountId === undefined) {
      throw new Error("Set CLOUDFLARE_ACCOUNT_ID alongside CLOUDFLARE_API_TOKEN");
    }
    return { accountId, apiToken };
  }
  const session = await getCfSession();
  return { accountId: accountId ?? onlyAccount(session.accountIds), apiToken: session.apiToken };
}
