# @agntn/memory

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/agntn/memory)

🧠 Seventeen tools, two backends. You ask to remember, it remembers.

## Why?

You want an agent that keeps facts between turns. Cloudflare speaks HTTP in one place and a Workers binding in another. They don't even list profiles the same way. OMP's Mnemopi only runs on Bun, so this is one `MemoryProvider` and seventeen tools instead of three copies of the plumbing.

## ✨ Features

- 🧩 **Two backends, one contract.** Cloudflare Agent Memory and OMP Mnemopi. `remember` and `recall` look the same from your code.
- 🔌 **HTTP or a Workers binding.** Same Cloudflare class. Binding has no `listProfiles`, HTTP does, so read `capabilities`.
- 🤖 **Seventeen tools an agent can call.** MCP, Pi and OMP, Cloudflare HTTP behind each. Mnemopi stays in the library.
- 🏷️ **Summaries are gossip.** The service writes them. Tools mark `summaryTrust: "service-generated-untrusted"`, and you decide from `content`.
- 🔁 **New facts bury old ones.** A fact or instruction on a topic the profile already holds supersedes it. The old memory leaves list and recall, `memory_get` still reads it by id.
- 🧵 **Ingest without a session still gets one.** The tools stamp the host's conversation session when they know it. Past that, Cloudflare derives one from the messages, `hash-` and then the id, the same for the same messages. Ingest the same messages twice and the second extraction supersedes the first, new ids under the same session. `remember` without a session stays `null`.
- 💬 **Recall ranks the messages too.** Ingest keeps every message verbatim, and recall ranks them next to the memories it extracted. A message candidate is marked `kind: message` with its text under the line. `memory_get` can't read it, `memory_session_delete` removes it with its session.
- 🎯 **Recall drops the noise.** Cloudflare ranks everything it holds, so a question it can't answer still comes back with ten lines. Anything under 1% of the best score goes out, and the header says how many went. Pass `candidates` when you want the tail anyway.
- 🩹 **A 502 isn't a verdict.** Reads try twice more on a 5xx or an answer that never arrives in full. Still failing? The error says come back later. Writes go out once, because a failed `remember` may have landed anyway. `get` leaves 500 alone. That's also how Cloudflare says it never had the id.
- 🛑 **Abort stops HTTP in flight.** Binding and Mnemopi check the signal at the door. Once they start, they finish.
- 🔐 **Bind one namespace and profile.** `AGNTN_MEMORY_NAMESPACE` and `AGNTN_MEMORY_PROFILE` together. The model cannot wander.
- ♻️ **Replace without a blind delete.** `memory_supersede` writes, waits for recall, then deletes. A failed check keeps both.
- 📛 **Cloudflare names are picky.** Lowercase letters, numbers, internal hyphens. `Ori_Notes` dies before the request leaves.
- 📦 **Import is inert.** Call `registerAll()` or construct the class. Nothing fills the registry on import.

## 📦 Install

Not on npm yet. From a clone:

```bash
pnpm install
```

Node.js 26 or newer.

## 🚀 First call

```bash
pnpm exec memory --help
```

```
Agent memory CLI (memory v0.1.0)

USAGE memory mcp

COMMANDS

  mcp    Run the memory MCP server over stdio

Use memory <command> --help for more information about a command.
```

That's the whole CLI. One subcommand. It speaks MCP and then sits there. Looking for `remember` on the command line? There isn't one. The tools do that. Help needs no key. Remembering does. After `pnpm install`, the binary is `pnpm exec memory`.

### Commands

| Command | What it does            | Example      |
| ------- | ----------------------- | ------------ |
| `mcp`   | The MCP server on stdio | `memory mcp` |

Credentials live in the environment, not in flags.

## 🧠 Library

```ts
import { CloudflareMemoryProvider } from "@agntn/memory";

const provider = new CloudflareMemoryProvider({ binding: env.MEMORY });
const profile = await provider.getProfile("user-123");
await profile.remember({ content: "Prefers short answers." });
await profile.recall("what does the user prefer?");
```

That's most of it, really. HTTP takes `accountId`, `namespace` and `apiToken` on the same class. Want Mnemopi in that snippet? You bring the Bun client. This package never imports it. `registerAll()` then `create()` if you want the registry. Pass an `AbortSignal`. An unknown memory id is a server error, not a 404.

## 🗺️ Providers

| Name         | What it wraps           | How you get it                               |
| ------------ | ----------------------- | -------------------------------------------- |
| `cloudflare` | Cloudflare Agent Memory | HTTP with an API token, or a Workers binding |
| `mnemopi`    | OMP Mnemopi             | You build the Bun clients and hand them over |

Mnemopi bank names allow letters, numbers, hyphens and underscores. The tools never talk to it. They always open Cloudflare over HTTP.

## 🤖 Agents

```bash
pnpm exec memory mcp
```

```json
{
  "mcpServers": {
    "memory": {
      "command": "pnpm",
      "args": ["exec", "memory", "mcp"],
      "env": {
        "AGNTN_CLOUDFLARE_ACCOUNT_ID": "...",
        "CLOUDFLARE_API_TOKEN": "...",
        "AGNTN_MEMORY_NAMESPACE": "default",
        "AGNTN_MEMORY_PROFILE": "agent"
      }
    }
  }
}
```

Seventeen tools across MCP, Pi and OMP, one executor table behind them. Pi does not load `.env`. If the two scope variables are missing, it reads `~/.pi/agent/memory-scope.json`.

No API token? Run `cf auth login` once and leave the token out. The tools borrow the cf CLI's OAuth session. `AGNTN_CLOUDFLARE_ACCOUNT_ID` stays only when that login reaches more than one account.

## 🚫 What this does not do

It does not edit a memory in place, list memories newest first, run Bun, or speak Mnemopi over MCP. Durable wiki files are `@agntn/wiki`, session transcripts are `@agntn/sessions`, and Cloudflare Agent Memory is still private beta.

## 🛠️ Development

```bash
pnpm install
pnpm lint        # builds first, then oxlint and oxfmt --check
pnpm typecheck
pnpm test        # vitest --run
pnpm build       # obuild
```

## 💛 Thanks

Without those two OSS programs this file would not exist. [Claude for Open Source](https://claude.com/contact-sales/claude-for-oss) and [Codex for Open Source](https://developers.openai.com/community/codex-for-oss). Thank you <3

## 📄 License

[MIT](./LICENSE)
