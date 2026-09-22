# Verified service behavior

What a run against the live Cloudflare Agent Memory API did. Keep the date where a number can drift.

## Names and limits

- Namespaces and profiles take lowercase letters, numbers and internal hyphens.
- `per_page` caps at 500 on memories and profiles and 1000 on namespaces, so the listings do not share one bound.
- `remember` takes at most 32,768 UTF-8 bytes of content, the same cap as one ingested message, and answers more with 400 `content must not exceed 32768 bytes`. The limits page names only the message cap.

## Listings and reads

- A profile listing orders by name, includes a profile once something was written to it, and ends with `cursor: null`.
- A memory listing pages by id from the oldest memory up, takes no order, and its cursor is the last id of the page.
- An unknown memory id returns a server error, not a 404. An unknown namespace name returns a real 404 from its own endpoint and from its profile listing.
- A summary always covers the whole profile, and its `sessionId` only picks the session named on its `Current session` line.

## Sessions

- Deleting a session that holds nothing still succeeds.
- `remember` without a `sessionId` stores `sessionId: null`. Pi, OMP and the MCP server under Claude Code or Grok stamp the harness session on a write that names none, so through the tools that case needs a host without one.
- `ingest` without a `sessionId`, or with `null`, files the extracted memories under a session the service derives from the message content, `hash-` and then the id, the same for the same messages in every profile, while the call itself returns nothing.

## Supersession

- A fact or instruction remembered on the topic of an existing one supersedes it: the older record leaves the listing and recall the moment the newer one is stored, stays readable by id, and has its `updatedAt` moved to the newer record's `createdAt`.
- The same content remembered twice is two records with the first superseded.
- Events accumulate.
- Deleting the newest version does not bring back the one it superseded.
- A session delete removes superseded memories the listing does not show.
- Ingesting the same messages again runs extraction again, and each extracted fact or instruction supersedes the stored version on its topic, so the listed ids change while the count can stay the same.

## Recall

- `recall` ranks the raw ingested messages next to the memories, as candidates with the same four fields: the message text as `summary`, verbatim with its newlines and cut at about 3,500 characters with an ellipsis, the ingest session or the derived `hash-` one as `sessionId`, and an id that is 26 Crockford base32 characters derived from the content, so its ULID time part decodes to an instant thousands of years off. A memory id is a ULID minted at write time, within 30 s of `createdAt` on 1,500 live records.
- `get` and `delete` answer a message id with the same server error as an unknown id, a listing never shows it, and a session delete removes it. Measured 2026-09-19: two message candidates in every recall on a 4,280-memory profile, ranked as high as second.
- The fused score separates a real hit from the rest by orders of magnitude, so recall trims the candidates under 1% of the best one when the call names no cap. Measured 2026-09-22 over 24-candidate responses: an answered query scored 0.98 on the first line and 0.0011 on the second, a well-matched one kept nine lines within one order of magnitude of the top, and an unanswerable one flattened every line onto the same 0.0000374 floor.
