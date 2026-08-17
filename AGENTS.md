# AGENTS.md

`@agntn/memory` gives one domain interface over agent-memory systems.

## Contract

- `MemoryProvider` owns namespaces and the profile lifecycle.
- `MemoryProfile` owns memory operations inside one isolated profile.
- A provider exposes only what its API actually supports. No optimistic capabilities.
- Local harness sources and remote API providers stay separate concerns.
- Registration is explicit through `registerAll()`. Importing anything has no side effects.
- Pi, OMP and MCP are one tool surface backed by `packages/shared/memory-tools.ts`.
- Pi and MCP share the schemas in `packages/shared/memory-tool-schemas.ts`. OMP rebuilds them with its host TypeBox because that is what validates OMP tool parameters, and `test/tool-schemas.test.ts` fails when the two copies drift.

## Tool results

- A result is text and nothing else. MCP clients never see `details`, so anything the caller needs has to be in the text.
- Say what the caller cannot control: the service assigns memory types, extraction is asynchronous, cascade deletes report nothing on their own.
- Only verified service rules go in descriptions and schemas. Verified so far: namespaces and profiles take lowercase letters, numbers and internal hyphens; `per_page` caps at 500; an unknown memory id returns a server error, not a 404; deleting a session that holds nothing still succeeds.
- Identifiers go into URL paths, so `.` and `..` are rejected. `encodeURIComponent` leaves dots alone and one dot segment moves a memory delete up to the profile endpoint.

## Cloudflare

The first provider follows the Cloudflare Agent Memory Workers and HTTP APIs documented on 2026-06-03. Agent Memory is private beta. Both binding and HTTP transports are supported. Keep validation limits aligned with current Cloudflare documentation, and prefer a limit you measured against the live API over one from the docs page.

## Commands

- `pnpm fmt`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm build`
- `pnpm test`
