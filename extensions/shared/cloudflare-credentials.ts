import type { CredentialSource } from "@agntn/credentials";
import { resolve } from "@agntn/credentials/cloudflare";

export interface CloudflareCredentials {
  accountId: string;
  apiToken: string;
}

/** The credentials plus where the token came from, which decides whether a retry after a 401 can help. */
export interface ResolvedCloudflareCredentials extends CloudflareCredentials {
  source: CredentialSource;
}

/**
 * Map `@agntn/credentials` to the memory client. Keep it for one call: a cf token rotates.
 * @param options - `refresh` asks cf again before its cached token expires, after a 401.
 * @returns {Promise<ResolvedCloudflareCredentials>} Credentials valid for the next request, and their source.
 */
export async function getCloudflareCredentials(
  options: Readonly<{ refresh?: boolean }> = {},
): Promise<ResolvedCloudflareCredentials> {
  const { accountId, token, source } = await resolve(options);
  return { accountId, apiToken: token, source };
}
