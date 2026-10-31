# AGENTS.md

`@agntn/memory` gives one domain interface over agent-memory systems.

## Contract

- `MemoryProvider` owns namespaces and the profile lifecycle.
- `MemoryProfile` owns memory operations inside one isolated profile.
- A provider exposes only what its API actually supports. No optimistic capabilities.
- Every operation takes an `AbortSignal`. A transport that cannot interrupt itself checks the signal at the call boundary, and a signal never reaches a request body.
- Local harness sources and remote API providers stay separate concerns.
- Registration is explicit through `registerAll()`. Importing anything has no side effects.
- `src/cli.ts` serves a bare `memory mcp` itself, before `runCli` from `@agntn/tools/cli` reads the line, so the SDK loads only for the server. `--help` builds every tool command without it, and `test/cli.test.ts` runs those usage paths under a load hook.
- Inside a checkout `dist/cli.mjs mcp` loads the command from `src/`, as the Pi and OMP extensions do, so a local server needs a restart after an edit and no build. It keeps the bundle under `MEMORY_DIST=1`, when Node doesn't strip types, under `node_modules` and without `src/`. `src/` imports no devDependency at runtime, and the case for a checkout installed without them holds it to that. An edit to `src/cli.ts` itself still needs `pnpm build`. With `dist/` built, as CI's test job does before `pnpm test`, `test/cli.test.ts` goes red without any one of those guards. A clean checkout skips those cases.
- MCP, Pi, OMP and the CLI get one definition per tool from `extensions/shared/memory-tool-definitions.ts`, wired through `@agntn/tools`. The executors in `memory-tools.ts` load with the first call, so limits and tool prose live in `memory-tool-contract.ts`, which imports nothing.
- Schemas take `Type` from `@agntn/tools`, never a bare `typebox` import: OMP rewrites that specifier to its own facade, whose `Value.Check` accepts anything. `defineTool` takes only closed objects and `Type.Enum`, so a key a tool doesn't take, a bound write's `sessionId` included, gets refused instead of overwritten.
- Pi peers run `>=0.84.2 <2`, and the dev pin sits on 1.0.2 so `tsc` reads the 1.x types. On 2026-10-05 a packed tarball installed next to Pi 1.0.2, and a real `pi -p` session listed namespaces and came back with `isError` for both a service failure and an argument the host rejected. The next major gets the same session before the fence moves.

## Terminal rendering

- Both wrappers render through `extensions/shared/tui.ts`, so a call reads the same in either harness. Only the adapter around it differs.
- The two harnesses order the renderer arguments differently: Pi passes `(args, theme, context)`, OMP passes `(args, options, theme)`. Verify the order in the installed runtime's declarations, never in the dev dependency.
- Pi keeps the failure flag out of the result object and reports it in the render context. OMP puts it in the result. A renderer that reads only `result.isError` marks a failed Pi call as done.
- Both harnesses print the call line and the result line in one container, so the result line carries no tool name.
- Recall, ingest and `memory_recall_wait` stream a progress line first. A partial result keeps the running icon, because an update is progress and not an outcome.
- Model arguments and stored memory text cross the terminal trust boundary. Everything a renderer prints goes through the sanitizer first.

## Tool results

- A result is text and nothing else. MCP clients never see `details`, so anything the caller needs has to be in the text.
- Untrusted multiline fields stay indented under a trusted header or record. Only serializer-owned records start at column zero.
- Say what the caller cannot control: the service assigns memory types, generated record summaries, synthesized recall answers, and generated profile summaries are untrusted, extraction is asynchronous, recall visibility can lag behind a durable write, and cascade deletes report nothing on their own. Serialized records and profile summaries mark generated prose with `summaryTrust: "service-generated-untrusted"`; recall uses `answerTrust: "service-generated-untrusted"` because the service does not map claims to candidate IDs. State decisions use full memory content.
- `memory_supersede` is a non-atomic sequence: create, exact read, recall, then delete. `memory_supersession_resume` repeats the checks from an existing replacement id without creating another record. A failed check never deletes the old record; a failed check or delete reports both ids and keeps the replacement available for cleanup.
- Only verified service rules go in descriptions and schemas. [docs/service-behavior.md](docs/service-behavior.md) holds what is measured: names and limits, listing and read shapes, sessions, supersession, and how recall scores candidates and returns ingested messages. Read it before writing a tool description, a schema or a validation limit, and extend it from a run.
- Identifiers go into URL paths, so `.` and `..` are rejected. `encodeURIComponent` leaves dots alone and one dot segment moves a memory delete up to the profile endpoint.

## Cloudflare

The first provider follows the Cloudflare Agent Memory Workers and HTTP APIs documented on 2026-06-03. Agent Memory is private beta. Both binding and HTTP transports are supported. Over HTTP a read gets three tries on a 5xx or an answer that never arrives in full, except a read by id on 500, which is how the service answers an unknown id. A write goes out once, and its error says it may have landed anyway. Keep validation limits aligned with current Cloudflare documentation, and prefer a limit you measured against the live API over one from the docs page.

The tools take `CLOUDFLARE_API_TOKEN` first. Without it `extensions/shared/cloudflare-credentials.ts` borrows the cf CLI's OAuth session: `cf auth whoami` refreshes an expired token and names the credentials file. The token rotates while a server runs, so cached clients are rebuilt when it changes. `test/setup.ts` mocks `execFile`, so the suite never borrows a contributor's login. The account comes only from `AGNTN_CLOUDFLARE_ACCOUNT_ID`: `CLOUDFLARE_ACCOUNT_ID` belongs to cf and wrangler and is never read.

## Commands

- `pnpm fmt`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm build`
- `pnpm test`
