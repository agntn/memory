import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CloudflareMemoryOptions, MemoryProvider } from "@agntn/memory";
import { type CloudflareCredentials, getCloudflareCredentials } from "./cloudflare-credentials.ts";
import { createMemoryToolExecutors } from "./memory-tools.ts";
import type { MemoryBackend, MemoryModule, NamespaceClient } from "./memory-tools.types.ts";

let memoryModulePromise: Promise<MemoryModule> | undefined;
let namespaceClientPromise: Promise<NamespaceClient> | undefined;
const providerPromises = new Map<string, Promise<MemoryProvider>>();
let credentialsKey: string | undefined;

function loadMemory(): Promise<MemoryModule> {
  if (!memoryModulePromise) {
    const sourceUrl = new URL("../../src/index.ts", import.meta.url);
    // Runtime-selected so a checkout uses current source while a published package uses dist.
    memoryModulePromise = existsSync(fileURLToPath(sourceUrl))
      ? import(sourceUrl.href).then((memory) => memory as MemoryModule)
      : import("@agntn/memory").then((memory) => memory as unknown as MemoryModule);
  }
  return memoryModulePromise;
}

/**
 * Resolve credentials and drop clients built for a token that is gone.
 *
 * A cf OAuth token rotates while the process lives, and every cached client
 * carries the token it was built with.
 * @returns {Promise<CloudflareCredentials>} Credentials for the next request.
 */
async function getCredentials(): Promise<CloudflareCredentials> {
  const credentials = await getCloudflareCredentials();
  const key = `${credentials.accountId}\n${credentials.apiToken}`;
  if (key !== credentialsKey) {
    credentialsKey = key;
    namespaceClientPromise = undefined;
    providerPromises.clear();
  }
  return credentials;
}

/** The Cloudflare HTTP API, authorized by the process credentials. */
export const apiMemoryBackend: MemoryBackend = {
  async namespaces() {
    const credentials = await getCredentials();
    namespaceClientPromise ??= loadMemory().then(
      (memory) => new memory.CloudflareNamespaceClient(credentials),
    );
    return namespaceClientPromise;
  },

  async provider(namespace) {
    const credentials = await getCredentials();
    let providerPromise = providerPromises.get(namespace);
    if (!providerPromise) {
      providerPromise = loadMemory().then((memory) => {
        memory.registerAll();
        return memory.create<CloudflareMemoryOptions>("cloudflare", {
          ...credentials,
          namespace,
        });
      });
      providerPromises.set(namespace, providerPromise);
    }
    return providerPromise;
  },
};

/** The operations Pi, OMP and the stdio MCP server run against the HTTP API. */
export const memoryToolExecutors = createMemoryToolExecutors(apiMemoryBackend);
