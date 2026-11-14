# Contributing

## Setup

The README has installation and usage. `pnpm lint`, `pnpm fmt` and `pnpm typecheck` run `pnpm build` first.

`test/cli.test.ts` runs the built bin, `dist/cli.mjs`. Its `memory mcp from the built bin` block skips itself when `dist/` is missing, so a fresh checkout goes green without running it. CI builds before testing.

With `dist/` built, removing any one of the source-versus-bundle guards in `src/cli.ts` turns that test red.

From a checkout, `dist/cli.mjs mcp` loads the command from `src/`, as the Pi and OMP extensions do. Restart the server after an edit. Only changes to `src/cli.ts` need `pnpm build`.

Set `MEMORY_DIST=1` to use the bundle. The bundle also runs when Node can't strip types, under `node_modules`, or when `src/` is absent.

The CLI's `src/` import graph needs no devDependencies at runtime. A checkout installed without them still serves the source. `src/ai.ts` needs `ai`, the optional peer supplied by an AI SDK app.

## The library contract

A provider exposes only what its API supports. No optimistic capabilities. Cloudflare over HTTP lists profiles, but the Workers binding can't, so its capability says no.

Every operation takes an `AbortSignal`. A transport that can't interrupt itself, such as the Workers binding, checks it at the call boundary. Never put the signal in a request body.

Keep local harness sources separate from remote API providers. Registration is explicit through `registerAll()`. Imports have no side effects.

## Agent tools

Each tool has one definition in `extensions/shared/memory-tool-definitions.ts`. It feeds MCP, Pi, OMP, the CLI and the AI SDK through `@agntn/tools`.

Executors in `memory-tools.ts` load on the first call. Limits and tool prose live in `memory-tool-contract.ts`, which imports nothing.

- Take `Type` from `@agntn/tools`, never a bare `typebox` import. OMP rewrites that specifier to its own facade, whose `Value.Check` accepts anything. That's quite a generous check. `pnpm test:packed` catches a bare import in `dist/`.
- Use closed object schemas and `Type.Enum` only. Reject keys a tool doesn't take, including a bound write's `sessionId`, rather than silently overwriting them.
- Tools pass no credentials. The provider looks them up and retries once after a refused `cf` token.
- Return text and nothing else. MCP clients never see `details`, so put everything the caller needs in the text.
- Indent untrusted multiline fields under a trusted header or record. Only records written by the serializer start at column zero.

Tell callers what they can't control:

- The service assigns memory types.
- Generated record summaries, synthesized recall answers and generated profile summaries are untrusted. Mark them with `summaryTrust` or `answerTrust` set to `"service-generated-untrusted"`. Use full memory content for decisions about state.
- Extraction is asynchronous. Recall can lag behind a durable write.
- Cascade deletes report nothing on their own.

`memory_supersede` isn't atomic. It creates, reads the replacement exactly, recalls, then deletes. `memory_supersession_resume` repeats the checks from an existing replacement id.

A failed check never deletes the old record. A failure reports both ids, so the replacement can be cleaned up.

Identifiers end up in URL paths. Reject `.` and `..`: `encodeURIComponent` leaves dots alone. A single `..` could send a memory delete up to the profile endpoint. That's too much power for two dots.

## Service behavior

What does the service actually do? Only verified rules belong in tool descriptions and schemas. Read `docs/service-behavior.md` before writing a description, schema or validation limit. Extend it from a real run against the Cloudflare Agent Memory API.

The Cloudflare provider follows the Agent Memory Workers and HTTP API docs as of 2026-06-03. Agent Memory is a private beta. Keep validation limits aligned with current Cloudflare docs, but prefer a limit measured against the live API.

An unknown memory id answers `500`, not `404`. No docs page told us that. A run did.

## Terminal rendering

Both wrappers render through `extensions/shared/tui.ts`. Only the adapter differs.

Pi and OMP order renderer arguments differently. Check the installed runtime's type declarations, never the dev dependency.

Model arguments and stored memory text cross the terminal trust boundary. Everything a renderer prints goes through the sanitizer first.

## Tests

Tests never use your real `cf` login. `test/setup.ts` mocks `execFile`, and `vite.config.ts` inlines `@agntn/credentials` so the mock reaches it. Your login can sit this one out.

## Pi and OMP

The Pi peer range is `>=0.84.2 <2`. The dev pin is Pi `1.0.2`, so `tsc` reads the `1.x` types.

Before moving the range to the next major, install the packed tarball next to that Pi. Run a real `pi -p` session that lists namespaces.

Check that the session gets `isError` for both a service failure and an argument the host rejected. Pi `1.0.2` passed that check on 2026-10-05.

## Pull requests

Keep pull request and issue descriptions short and freeform. Say why the change is needed.
