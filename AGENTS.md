# AGENTS.md

`@agntn/memory` gives one domain interface over agent-memory systems.

## Contract

- `MemoryProvider` owns namespaces and the profile lifecycle.
- `MemoryProfile` owns memory operations inside one isolated profile.
- A provider exposes only what its API actually supports. No optimistic capabilities.
- Every operation takes an `AbortSignal`. A transport that cannot interrupt itself checks the signal at the call boundary, and a signal never reaches a request body.
- Local harness sources and remote API providers stay separate concerns.
- Registration is explicit through `registerAll()`. Importing anything has no side effects.
- `src/commands/mcp.ts` imports the server and the SDK inside `run()`, because citty resolves the subcommand for `--help` and for an unknown command too. `test/cli.test.ts` runs those usage paths under a load hook.
- Pi, OMP and MCP are one tool surface backed by `packages/shared/memory-tools.ts`.
- Pi and MCP share the schemas in `packages/shared/memory-tool-schemas.ts`. OMP rebuilds them with its host TypeBox because that is what validates OMP tool parameters, and `test/tool-schemas.test.ts` fails when the two copies drift.

## Terminal rendering

- Both wrappers render through `packages/shared/tui.ts`, so a call reads the same in either harness. Only the adapter around it differs.
- The two harnesses order the renderer arguments differently: Pi passes `(args, theme, context)`, OMP passes `(args, options, theme)`. Verify the order in the installed runtime's declarations, never in the dev dependency.
- Pi keeps the failure flag out of the result object and reports it in the render context. OMP puts it in the result. A renderer that reads only `result.isError` marks a failed Pi call as done.
- Both harnesses print the call line and the result line in one container, so the result line carries no tool name.
- Recall, ingest and `memory_wait_for_recall` stream a progress line first. A partial result keeps the running icon, because an update is progress and not an outcome.
- Model arguments and stored memory text cross the terminal trust boundary. Everything a renderer prints goes through the sanitizer first.

## Tool results

- A result is text and nothing else. MCP clients never see `details`, so anything the caller needs has to be in the text.
- Untrusted multiline fields stay indented under a trusted header or record. Only serializer-owned records start at column zero.
- Say what the caller cannot control: the service assigns memory types, generated record summaries, synthesized recall answers, and generated profile summaries are untrusted, extraction is asynchronous, recall visibility can lag behind a durable write, and cascade deletes report nothing on their own. Serialized records and profile summaries mark generated prose with `summaryTrust: "service-generated-untrusted"`; recall uses `answerTrust: "service-generated-untrusted"` because the service does not map claims to candidate IDs. State decisions use full memory content.
- `memory_supersede` is a non-atomic sequence: create, exact read, recall, then delete. `memory_resume_supersession` repeats the checks from an existing replacement id without creating another record. A failed check never deletes the old record; a failed check or delete reports both ids and keeps the replacement available for cleanup.
- Only verified service rules go in descriptions and schemas. Verified so far: namespaces and profiles take lowercase letters, numbers and internal hyphens; `per_page` caps at 500 on memories and profiles and 1000 on namespaces, so the listings do not share one bound; a profile listing orders by name, includes a profile once something was written to it, and ends with `cursor: null`; an unknown memory id returns a server error, not a 404, while an unknown namespace name returns a real 404 from its own endpoint and from its profile listing; deleting a session that holds nothing still succeeds; a summary always covers the whole profile, and its `sessionId` only picks the session named on its `Current session` line; a memory listing pages by id from the oldest memory up, takes no order, and its cursor is the last id of the page; a fact or instruction remembered on the topic of an existing one supersedes it: the older record leaves the listing and recall the moment the newer one is stored, stays readable by id with its `updatedAt` moved to the newer record's `createdAt`, and the same content remembered twice is two records with the first superseded; events accumulate; deleting the newest version does not bring back the one it superseded; a session delete removes superseded memories the listing does not show; `remember` takes at most 32,768 UTF-8 bytes of content, the same cap as one ingested message, and answers more with 400 `content must not exceed 32768 bytes` while the limits page names only the message cap. `ingest` without a `sessionId`, or with `null`, files the extracted memories under a session the service derives from the message content, `hash-` and then the id, the same for the same messages in every profile, while the call itself returns nothing and `remember` without one stores `sessionId: null` (Pi, OMP and the MCP server under Claude Code or Grok stamp the harness session on a write that names none, so through the tools that case needs a host without one); ingesting the same messages again runs extraction again, and each extracted fact or instruction supersedes the stored version on its topic, so the listed ids change while the count can stay the same; `recall` ranks the raw ingested messages next to the memories, as candidates with the same four fields: the message text as `summary`, verbatim with its newlines and cut at about 3,500 characters with an ellipsis, the ingest session or the derived `hash-` one as `sessionId`, and an id that is 26 Crockford base32 characters derived from the content, so its ULID time part decodes to an instant thousands of years off, while a memory id is a ULID minted at write time, within 30 s of `createdAt` on 1,500 live records; the fused score separates a real hit from the rest by orders of magnitude, so recall trims the candidates under 1% of the best one when the call names no cap (measured 2026-09-22 over 24-candidate responses: an answered query scored 0.98 on the first line and 0.0011 on the second, a well-matched one kept nine lines within one order of magnitude of the top, and an unanswerable one flattened every line onto the same 0.0000374 floor); `get` and `delete` answer a message id with the same server error as an unknown id, a listing never shows it, and a session delete removes it (measured on 2026-09-19: two message candidates in every recall on a 4,280-memory profile, ranked as high as second).
- Identifiers go into URL paths, so `.` and `..` are rejected. `encodeURIComponent` leaves dots alone and one dot segment moves a memory delete up to the profile endpoint.

## Cloudflare

The first provider follows the Cloudflare Agent Memory Workers and HTTP APIs documented on 2026-06-03. Agent Memory is private beta. Both binding and HTTP transports are supported. Keep validation limits aligned with current Cloudflare documentation, and prefer a limit you measured against the live API over one from the docs page.

## Commands

- `pnpm fmt`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm build`
- `pnpm test`
