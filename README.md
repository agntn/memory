# @agntn/memory

One interface over agent memory systems. Cloudflare Agent Memory over Workers bindings or HTTP, Mnemopi for local OMP setups, and the same twelve tools wired into Pi, OMP and MCP so an agent gets memory without you writing the plumbing three times.

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
```

Namespaces live at account level, so they get their own client:

```ts
const namespaces = new CloudflareNamespaceClient({
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
  apiToken: process.env.CLOUDFLARE_API_TOKEN!,
});

await namespaces.create("my-agent");
const page = await namespaces.list({ limit: 20, order: "name" });
await namespaces.delete("my-agent");
```

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

Pi and OMP each get a native extension with all twelve tools. They talk to Cloudflare over HTTP, so the host needs credentials:

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

Same twelve tools over the Model Context Protocol, same credentials, stdio transport:

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

An MCP client only ever sees the result text, so every result has to stand on its own. `memory_recall` prints the answer and then one JSON object per candidate memory, ids and scores included, because an answer you cannot trace back to a memory is a dead end. Candidate summaries are capped by the service, so recall takes an `expand` count that pulls the full content of the best-scoring candidates into the same response, and `memory_list` takes the same count for the first entries of a page. `memory_get` takes a list of up to 30 ids and returns one record per unique id in request order, one service read each, with a per-id error message where a read fails; the call itself errors only when every read fails. `memory_list` and `memory_get` print their records the same way recall does, one compact JSON object per line, and the list header says outright whether another page waits behind a cursor. Deleting a session or a profile tells you how much it removed, and says plainly when a session id matched nothing.

When Claude Code launches the MCP server, its injected `CLAUDE_PROJECT_DIR` and `CLAUDE_CODE_SESSION_ID` are hashed into a deterministic write `sessionId`. The readable key names the harness and project but does not expose the full path or conversation id. Other MCP hosts may still pass `sessionId` explicitly when running without a bound operational scope.

Two Cloudflare behaviours will bite you otherwise. An unknown memory id comes back as a generic 500, not a 404, so `memory_get` adds a line saying the id may simply not exist. Deleting a session that never existed succeeds quietly, which is why the delete counts what it found first. Both are in the tool descriptions, so an agent does not have to discover them halfway through a task.

What Cloudflare does not give you: editing a memory, listing profiles, batch reads, or any handle on the asynchronous ingest job. The tool descriptions say so instead of staying silent, and the multi-id `memory_get` is this package fanning out single reads, not a service batch endpoint.

## License

MIT
