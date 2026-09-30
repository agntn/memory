import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
  worker: {
    name: "agntn-memory",
    compatibilityDate: "2026-09-25",
    // agents keeps the MCP auth context in AsyncLocalStorage; CIMD client lookups need public fetch.
    compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
    entrypoint,
    env: {
      // Must match MEMORY_NAMESPACE in src/index.ts.
      MEMORY: bindings.agentMemory({ namespace: "default" }),
      OAUTH_KV: bindings.kv(),
      MEMORY_PROFILE: bindings.text("oritwoen"),
      MEMORY_TRACE_PAYLOADS: bindings.text("false"),
      // Deployment identity stays out of the repository.
      MCP_URL: bindings.secret(),
      OWNER_EMAIL: bindings.secret(),
      ACCESS_ISSUER: bindings.secret(),
      ACCESS_CLIENT_ID: bindings.secret(),
      ACCESS_CLIENT_SECRET: bindings.secret(),
      CONSENT_SECRET: bindings.secret(),
    },
    observability: {
      enabled: true,
      traces: { enabled: true },
    },
  },
});
