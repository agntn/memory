import { resolve } from "@agntn/credentials/cloudflare";

export interface CloudflareCredentials {
  accountId: string;
  apiToken: string;
}

/**
 * Map `@agntn/credentials` to the memory client. Keep it for one call: a cf token rotates.
 * @param options - `refresh` asks cf again before its cached token expires, after a 401.
 * @returns {Promise<CloudflareCredentials>} Credentials valid for the next request.
 */
export async function getCloudflareCredentials(
  options: Readonly<{ refresh?: boolean }> = {},
): Promise<CloudflareCredentials> {
  const { accountId, token } = await resolve(options);
  return { accountId, apiToken: token };
}
