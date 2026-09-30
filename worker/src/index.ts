import { env } from "cloudflare:workers";
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { type AccessEnv, accessHandler } from "./access.ts";
import { bindingMemoryBackend } from "./backend.ts";
import { createMemoryServer } from "./mcp.ts";

/** The namespace the `MEMORY` binding is configured with in `cloudflare.config.ts`. */
export const MEMORY_NAMESPACE = "default";

/** Everything outside `/mcp` reaches the Access sign-in; `/mcp` needs a token this Worker issued. */
export default new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: {
    fetch(request, workerEnv, ctx) {
      const handler = createMcpHandler(
        () =>
          createMemoryServer({
            backend: bindingMemoryBackend(MEMORY_NAMESPACE, workerEnv.MEMORY),
            scope: { namespace: MEMORY_NAMESPACE, profile: workerEnv.MEMORY_PROFILE },
            tracePayloads: (workerEnv.MEMORY_TRACE_PAYLOADS as string) === "true",
          }),
        { allowedHostnames: [new URL(workerEnv.MCP_URL).hostname] },
      );
      return handler(request, workerEnv, ctx);
    },
  },
  defaultHandler: {
    fetch: (request, workerEnv) => accessHandler.fetch(request, workerEnv as unknown as AccessEnv),
  },
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  clientIdMetadataDocumentEnabled: true,
  resourceMetadata: { resource: env.MCP_URL, resource_name: "Agent memory" },
});
