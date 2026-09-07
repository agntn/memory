# @agntn/memory

One interface over agent memory systems. Cloudflare Agent Memory over Workers bindings or HTTP, Mnemopi for local OMP setups, and the same seventeen tools wired into Pi, OMP and MCP so an agent gets memory without you writing the plumbing three times.

## Install

```bash
pnpm add @agntn/memory
```

## Cloudflare Worker binding

```ts
import { CloudflareMemoryProvider } from "@agntn/memory";

const provider = new CloudflareMemoryProvider({ binding: env.MEMORY });
const profile = await provider.getProfile("user-123");
await profile.remember({ content: "The user prefers concise answers." });
```

## Cloudflare HTTP API

```ts
const provider = new CloudflareMemoryProvider({
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
  namespace: "my-agent",
  apiToken: process.env.CLOUDFLARE_API_TOKEN!,
});
const profileNames = await provider.listProfiles!();
```

Over HTTP the provider can also say which profiles its namespace holds. The Workers binding has no such call, so a binding-backed provider leaves `listProfiles` absent and reports `capabilities.listProfiles: false`.

Namespaces live at account level, so they get their own client:

```ts
const namespaces = new CloudflareNamespaceClient({
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
  apiToken: process.env.CLOUDFLARE_API_TOKEN!,
});

await namespaces.create("my-agent");
const page = await namespaces.list({ limit: 20, order: "name" });
const one = await namespaces.get("my-agent");
const profiles = await namespaces.listProfiles("my-agent", { limit: 20 });
await namespaces.delete("my-agent");
```

A profile shows up in that listing once something has been written to it, ordered by name, with the time it was first recorded.

There is no update or rename endpoint, so renaming means creating the new namespace, writing the memories again, and deleting the old one.

Names are strict: lowercase letters, numbers and internal hyphens, both for namespaces and profiles. `Ori_Notes` comes back as a 400, so this library rejects it before the request goes out. Agent Memory is still private beta, so treat the surface as something that can move.

## OMP Mnemopi

Mnemopi runs on Bun and this library does not, so you build the clients and hand them to the adapter:

```ts
import { homedir } from "node:os";
import { join } from "node:path";
import { MnemopiMemoryProvider } from "@agntn/memory";
import { Mnemopi } from "@oh-my-pi/pi-mnemopi";
import { BankManager } from "@oh-my-pi/pi-mnemopi/core";

const dataDir = join(homedir(), ".omp", "agent", "memories", "mnemopi");
const banks = new BankManager(dataDir);
const provider = new MnemopiMemoryProvider({
  listProfiles: () => banks.listBanks(),
  createClient: (profileName) =>
    new Mnemopi({
      dbPath:
        profileName === "default" ? join(dataDir, "mnemopi.db") : banks.getBankDbPath(profileName),
      bank: profileName,
      sessionId: profileName,
    }),
});
const profileNames = await provider.listProfiles();
const profile = await provider.getProfile(profileNames[0]!);
await profile.remember({ content: "Deploy with pnpm deploy." });
await provider.close();
```

`@oh-my-pi/pi-mnemopi` goes in the Bun app that builds the clients, not here. One memory profile is one Mnemopi bank, and a `sessionId` you pass has to match the client's fixed session.

## Cancellation

Every read and write takes an `AbortSignal`, so a call that nobody is waiting for stops instead of running to completion on your Cloudflare bill:

```ts
const controller = new AbortController();
const page = await profile.list({ limit: 20, signal: controller.signal });
```

Over HTTP the signal goes straight to `fetch` and kills the request in flight. A Workers binding and the Mnemopi client run in process and cannot be interrupted once they start, so there the signal decides whether the call happens at all. Pi, OMP and MCP already pass their own signal down, so an interrupted turn no longer leaves a recall running.

## Pi and OMP extensions

Pi and OMP each get a native extension with all seventeen tools. They talk to Cloudflare over HTTP, so the host needs credentials:

```bash
export CLOUDFLARE_ACCOUNT_ID="..."
export CLOUDFLARE_API_TOKEN="..."
```

By default, profile and memory calls expose `namespace` and `profile` for administrative, multi-profile use. A production agent should bind one operational scope instead:

```bash
export AGNTN_MEMORY_NAMESPACE="default"
export AGNTN_MEMORY_PROFILE="agent"
```

Pi does not load `.env` files. When the two environment variables are absent, its extension reads the non-secret scope from `$PI_CODING_AGENT_DIR/memory-scope.json` (default `~/.pi/agent/memory-scope.json`):

```json
{
  "namespace": "default",
  "profile": "agent"
}
```

Environment variables take precedence over this Pi-specific file.

Both variables are required together. In bound mode, ordinary recall/write/list/get/delete tools omit `namespace` and `profile`; the adapter injects them after argument validation, so the model cannot drift into another profile. Pi and OMP also derive write `sessionId` from the harness session and working directory. Bound MCP writes derive it from Claude Code's injected project and conversation identifiers. Caller-supplied write `sessionId` values are honored only in unbound administrative mode. Account-level namespace tools and explicit profile deletion remain administrative.

Pi loads `packages/pi/extensions/memory.ts`, OMP loads `packages/omp/extensions/memory.ts`. Reads use OMP's read approval tier, writes and deletes use the write tier.

## MCP server

Same seventeen tools over the Model Context Protocol, same credentials, stdio transport:

```bash
memory mcp
```

Register it with an MCP client:

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@agntn/memory", "mcp"],
      "env": {
        "CLOUDFLARE_ACCOUNT_ID": "...",
        "CLOUDFLARE_API_TOKEN": "...",
        "AGNTN_MEMORY_NAMESPACE": "default",
        "AGNTN_MEMORY_PROFILE": "agent"
      }
    }
  }
}
```

Or embed it in a host that owns its own transport:

```ts
import { createMcpServer } from "@agntn/memory/mcp";

const server = createMcpServer();
await server.connect(transport);
```

An MCP client only ever sees the result text, so every result has to stand on its own. `memory_recall` prints the service answer with `answerTrust: "service-generated-untrusted"` and indents its lines so they cannot impersonate candidate records, then prints one JSON object per candidate memory. Cloudflare does not identify which candidate IDs support the prose, so state decisions use full candidate `content` instead of the answer alone. `memory_summary` applies the same boundary to its generated Markdown: the result carries `summaryTrust: "service-generated-untrusted"`, says that supporting memory ids are unavailable, and keeps every line from the service indented. The service also generates each record's `summary`; serialized records mark it with the same `summaryTrust`. Use summaries for discovery, then read `content` before making a state decision. Summaries are capped, so recall takes an `expand` count that pulls the full content of candidates with the highest scores into the same response, and `memory_list` takes the same count for the first entries of a page. The service itself returns every candidate it ranked, tail scores included, so recall also takes a `candidates` cap that keeps only the highest scoring ones and says how many it trimmed. `memory_get` takes a list of up to 30 ids and returns one record per unique id in request order, one service read each, with an error message for each failed id; the call itself errors only when every read fails. `memory_list` and `memory_get` print their records the same way recall does, one compact JSON object per line with any full content indented below its record, and the list header says outright whether another page waits behind a cursor. Deleting a session or a profile tells you how much it removed, and says plainly when a session id matched nothing. `memory_wait_for_recall` takes the id from `memory_remember` and polls for that exact candidate with bounded backoff, so a long wait cannot hide the id of a write that already succeeded. `memory_supersede` uses that check between an exact read of the replacement and deletion of the old id. If a check or delete fails, it keeps the replacement and reports both ids instead of trying a risky rollback. `memory_resume_supersession` can finish that sequence from the existing replacement id, so a timeout does not force another copy or manual deletion.

When Claude Code launches the MCP server, its injected `CLAUDE_PROJECT_DIR` and `CLAUDE_CODE_SESSION_ID` are hashed into a deterministic write `sessionId`. The readable key names the harness and project but does not expose the full path or conversation id. Other MCP hosts may still pass `sessionId` explicitly when running without a bound operational scope.

Three Cloudflare behaviours will bite you otherwise. An unknown memory id comes back as a generic 500, not a 404, so `memory_get` adds a line saying the id may simply not exist. Deleting a session that never existed succeeds quietly, which is why the delete counts what it found first. And a durable write can take a while to appear in recall. The visibility check reports its measured wait, while timeout or host cancellation changes no memory.

What Cloudflare does not give you: editing a memory, batch reads, or any handle on the asynchronous ingest job. The tool descriptions say so instead of staying silent. `memory_get` with several ids, `memory_supersede`, and `memory_resume_supersession` are compositions inside this package, not service batch or update endpoints.

## License

MIT
