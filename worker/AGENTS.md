# AGENTS.md

The remote MCP server: a Cloudflare Worker that serves the shared memory tools over Streamable HTTP for one owner.

## Shape

- `createMcpHandler` from `agents/mcp/server` builds a fresh SDK v2 `Server` per request. `McpAgent` is deprecated upstream, so it stays out.
- `@cloudflare/workers-oauth-provider` wraps everything. `/mcp` needs a token this Worker issued, and every other path is the Access sign-in in `src/access.ts`.
- The tool surface is the bound one: namespace from the `MEMORY` binding, profile from `MEMORY_PROFILE`. A binding has no namespace calls, so the namespace tools, `memory_profile_list` and `memory_delete_profile` are not served.
- `MEMORY_NAMESPACE` in `src/index.ts` and the `agentMemory` binding in `cloudflare.config.ts` name the same namespace. Change both together.

## Sign-in

- Consent is asked per MCP client before the redirect to Access, with the library's `beginConsent`, `approveConsent` and `beginUpstream` helpers. Without it a live Access session hands a code to any client that registered itself.
- The callback verifies the Access `id_token` signature, issuer, audience and expiry, then compares `email` with `OWNER_EMAIL`. The Access policy is the first gate and this check is the second.
- Deployment identity (`MCP_URL`, `OWNER_EMAIL`, `ACCESS_ISSUER`, the Access client) is secret, not config. The repository is public.

## Tracing

Each `tools/call` opens an `execute_tool <tool>` span through `tracing` from `cloudflare:workers`. Tool arguments and results are memory content, so they reach the span only when `MEMORY_TRACE_PAYLOADS` is `"true"`.

## Commands

The Worker has its own install. The root suite excludes it.

- `pnpm --dir worker install`
- `pnpm --dir worker typecheck`
- `pnpm --dir worker test`
- `pnpm --dir worker build`
- `pnpm --dir worker run deploy --secrets-file .env.secrets` (`pnpm deploy` is a pnpm command, not the script)

`cf dev` needs Cloudflare credentials even for local work, because the Agent Memory binding has no local simulation.
