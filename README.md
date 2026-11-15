# @agntn/memory

Give an agent a way to remember facts between conversations. `@agntn/memory` provides one library contract for Cloudflare Agent Memory and OMP Mnemopi, plus memory tools for MCP, Pi, OMP, and the AI SDK.

> **Experimental and unstable.** APIs and behavior can change. Cloudflare Agent Memory is in private beta.

## Try it

You need Node.js 26 or newer and pnpm. Install from a clone. The package may not be available on npm yet.

```bash
git clone https://github.com/agntn/memory.git
cd memory
pnpm install
pnpm build
```

Check the provider registry without credentials:

```bash
node --input-type=module -e "import { registerAll, providers } from '@agntn/memory'; registerAll(); console.log(providers())"
```

Expected output:

```text
[ 'cloudflare', 'mnemopi' ]
```

Importing the package doesn't register providers. Call `registerAll()` explicitly, or construct a provider directly. Registration only sets up the registry. It doesn't connect to a backend.

## Remember and recall

In a Cloudflare Worker with a configured Memory binding:

```ts
import { CloudflareMemoryProvider } from "@agntn/memory";

const provider = new CloudflareMemoryProvider({ binding: env.MEMORY });
const profile = await provider.getProfile("user-123");

await profile.remember({ content: "Prefers short answers." });
const results = await profile.recall("What does the user prefer?");
console.log(results);
```

Over HTTP, you can leave credentials out. The library has finally caught up with its own tools, so you don't have to copy what they already find. On each request, `@agntn/credentials` looks up omitted fields in the environment or your `cf auth login`. Explicit values win, and passing both skips lookup. `new CloudflareNamespaceClient()` works without options too.

```ts
const provider = new CloudflareMemoryProvider({ namespace: "default" });
```

Mnemopi requires Bun clients that you supply. The package doesn't import them for you.

| Provider     | Backend                 | Connection              |
| ------------ | ----------------------- | ----------------------- |
| `cloudflare` | Cloudflare Agent Memory | Workers binding or HTTP |
| `mnemopi`    | OMP Mnemopi             | Supplied Bun clients    |

Check provider `capabilities` before relying on backend-specific features. For example, Cloudflare HTTP supports listing profiles, but the Workers binding doesn't.

## Use with an agent

The MCP, Pi, and OMP tools use Cloudflare over HTTP. The AI SDK tools can also go through a Workers binding. They don't expose Mnemopi. The CLI now gives every agent tool a command, built from the same definitions.

Drop the `memory_` prefix and use hyphens: `memory_remember` becomes `memory remember`. Arguments are flags, like `--content "Prefers short answers."`. Pass arrays and objects as JSON. Run `memory <command> --help` for the flags. You get exactly the text the agent sees, which makes the terminal a handy place to try things. Use `--json` for structured details.

The agent doesn't get the whole job anymore. `memory mcp` still runs the MCP server over stdio.

From the checkout, configure an MCP client with:

```json
{
  "mcpServers": {
    "memory": {
      "command": "pnpm",
      "args": ["exec", "memory", "mcp"],
      "env": {
        "AGNTN_CLOUDFLARE_ACCOUNT_ID": "your-account-id",
        "CLOUDFLARE_API_TOKEN": "your-api-token",
        "AGNTN_MEMORY_NAMESPACE": "default",
        "AGNTN_MEMORY_PROFILE": "agent"
      }
    }
  }
}
```

Run the command from the checkout so `pnpm` can find the package. Pi doesn't load `.env`, so without these variables it checks `~/.pi/agent/agntn/memory.json`.

Pi also ingests the conversation on its own, no tool call needed. Every tenth turn, what you and the model wrote since the last batch goes to `memory_ingest` under the session ID. Pi counts a turn as one model response with its tool calls.

Thinking, tool calls and tool results stay out, and whatever's left when the session ends goes in one last batch.

The batch lands in the project, not on you. A checkout whose `upstream` or `origin` remote is `github.com/agntn/memory` ingests into `agntn/memory`, and `upstream` wins on a fork. No remote? Then it's the scope above. The working directory alone doesn't count, since folders get renamed and moved. Neither one? Nothing gets sent.

OpenBot agents get a split of their own. Pi spots one by the `<agent_profile>` OpenBot puts in the prompt. The agent's namespace comes from `.pi/agntn/memory.json` in its folder, like `{"namespace": "iona"}`.

The profile is whoever's talking: your messages go to your profile, a teammate's to that teammate's namespace. Replies follow the last speaker, so Iona's chat with Mira lands in `iona/mira`.

Channels need one more trick. A lead's `channel_assign` reaches the member as plain text, no sender attached, so Pi reads OpenBot's own database, read-only, to see who gave each task. It files under whoever assigned it, even after the channel picks a new lead.

A channel about one project can skip the split and go straight there. Map its id, which survives a rename, in `openbotChannels`:

```json
{ "openbotChannels": { "bd143301-73a8-411f-9f4a-ecf8635ccac3": "puzzles/gsmg" } }
```

A channel with no project gets `null`. A channel missing from the map still works, it just splits by agent. The agent hears about it once per session, id included, so you can add it.

Ingest keeps the envelope out of the conversation. In OpenBot, a message ends with only `author` when Pi knows who wrote it: you, a teammate or the agent itself. Outside OpenBot, it adds nothing. The service doesn't need another memory saying the harness is Pi. The session ID already names the harness and project.

Agents delete things now and then. A missing file comes back from `agentNamespace` in `~/.pi/agent/agntn/memory.json` or `AGNTN_MEMORY_AGENT_NAMESPACE`, `{name}` by default, and Pi tells you it wrote one. `"{name}-bot"` turns Iona into `iona-bot`. Saved memories OpenBot pastes into a message stay out, so old facts don't come back as news.

Cloudflare creates profiles on the first write, but not namespaces. When the project's namespace is missing, Pi says so once and uses your scope for the rest of the session. `memory_namespace_create` keeps the project apart next time.

Change the interval with `AGNTN_MEMORY_INGEST_TURNS` or `"ingestTurns"` in `agntn/memory.json`. `0` switches it off. A refused batch shows a warning and waits for the next try. One that may have landed, like a dropped connection, is never sent twice.

The variables set the default: omit both namespace and profile to use `default/agent`. Half a pair is no pair at all: pass both to read or write another profile, or the call is refused.

Writes keep the host's session ID wherever they go, and the model can't pass `sessionId` as an argument. A default should be a starting point, not a fence.

Give `memory_remember` up to four `copies` and one call stores the same content and session in each profile. Pasting the same finding twice can finally retire. The main record lands first, but the writes aren't atomic. If a copy fails, the error shows what landed and which profiles still need a retry.

Opt in with `copySource: true` and copies get a parent. Each one ends with `Copied from memory "<id>" in <namespace>/<profile>.` after a blank line. The main record stays untouched.

That's handy once the tool result is gone. Cloudflare's remember API takes only content and a session ID, so the reference has to live in the content. It marks origin, not independent confirmation, and won't follow later edits. If the line would push a copy past 32768 bytes, nothing is written. Without the flag, copies stay verbatim.

Set `AGNTN_MEMORY_FIELDS` once for MCP, CLI, Pi or OMP. Give it a JSON object of strings:

```json
{ "author": "support-bot", "platform": "web" }
```

The host signs every write, and the agent can't forge that signature. `memory_remember` and `memory_supersede` also accept optional `fields` for what the agent knows, like author and source. No more typing provenance into shared entries by hand.

Every write ends with a blank line and one block of `key: value` lines. Host fields come first, then caller fields, each in object order. A caller key the host already writes passes only with the same value. Anything else is refused before a write. Copies get the fields too, before any `Copied from memory` line.

Two fields fill themselves in: `harness` and `repository`. Pi and OMP write `pi` and `omp`. Pi under OpenBot also adds `app: openbot`. The MCP server writes `claude` or `grok` under those two, and the CLI falls back to `cli`. Put your own `harness` in the variable and it wins.

The repository is `owner/repo` from the session's git remote, preferring `upstream` over `origin`. Pi and OMP use the session's working directory. The CLI and `memory mcp` use their starting directory. No usable remote means no repository field. Put your own `repository` in the variable and it wins.

A shared MCP host built with `createMcpServer()` without a cwd leaves `repository` off. The AI SDK gets only what you pass.

Already stamped? No encore: content that ends with those lines, or with them plus a copy line, stays as it is. If fields push content past 32768 bytes, nothing is written.

Automatic ingest is the exception: it doesn't use your fields. Those stamps belong on remembered memories, not inside the conversation.

Start keys with a lowercase letter, then use lowercase letters, digits or underscores. Values must be nonblank and single-line. A bad value in the variable stops the server, CLI or extension from starting. A bad one in `fields` fails that call. Either way, nobody forges a second field.

Don't have an API token? The tools can also use `cf` CLI authentication. Run `cf auth login` and omit `CLOUDFLARE_API_TOKEN`. Keep the account ID when the login reaches more than one account.

`CLOUDFLARE_ACCOUNT_ID` counts too, so the one your shell already exports for wrangler just works. And when Cloudflare refuses a cf token mid-session, the next call goes back to cf for a fresh one instead of sulking until it expires.

### AI SDK

For a per-user app, lock memory to that user. No more relying on the model to respect the neighbours. Install the optional AI SDK peer, version 7 or newer.

```bash
pnpm add @agntn/memory ai
```

```ts
import { createMemoryAiTools } from "@agntn/memory/ai";
import { generateText, isStepCount } from "ai";

const tools = createMemoryAiTools({
  namespace: "support",
  profile: "user-42",
  sessionId: "chat-7",
  locked: true,
});

const { text } = await generateText({
  model,
  tools,
  stopWhen: isStepCount(5),
  prompt: "What does this user prefer?",
});
```

Locked gives you 11 tools that work inside one profile. The six `memory_namespace_*` and `memory_profile_*` tools aren't returned, and TypeScript knows they're missing.

No tool schema has a `namespace` or `profile` field. Calls that name either are refused before reaching Cloudflare. The model in user-42's chat can't read or delete user-43's memories. Creation throws unless both namespace and profile are set.

Without `locked`, you get the same 17 tools as MCP, Pi, and OMP. That's for an agent managing its own memory. Namespace and profile must still go together, or creation throws. Calls can name both to reach another profile, never just one.

With a profile set, writes carry your `sessionId`, and the model can't pass its own. Scope and session come from your code, never environment variables. No Claude Code session hides in your chat app.

Running inside a Worker? The Memory binding is already in `env`. Hand it over and the API token gets the day off. That's one less secret to rotate.

```ts
import { createMemoryAiTools } from "@agntn/memory/ai";

const tools = createMemoryAiTools({
  binding: env.MEMORY,
  namespace: "support",
  profile: "user-42",
  locked: true,
});
```

Namespace and profile are required. The binding serves one namespace. Calls that name another, copies included, are refused before anything is written. It can't list namespaces or profiles either. The four `memory_namespace_*` tools and `memory_profile_list` stay home. Without `locked` that leaves 12 tools. With it, the same 11 as over HTTP.

With the AI SDK, you can pass the same fields as an option:

```ts
const tools = createMemoryAiTools({
  namespace: "support",
  profile: "user-42",
  locked: true,
  fields: { platform: "web" },
});
```

## Behavior worth knowing

- **Treat generated text as untrusted.** Summaries and synthesized answers are service-generated. Check memory content before acting on them.
- **Replacement isn't atomic.** `memory_supersede` writes the replacement, checks it by ID and recall, then deletes the old memory. A failed check keeps both. There is no in-place memory editing.
- **Ingest is asynchronous.** Extracted memories may not be available immediately.
- **A failed write may still have landed.** HTTP reads retry on certain failures. Writes go out once, so check the result before trying a failed write again.
- **Backends differ.** Cloudflare binding, Cloudflare HTTP, and Mnemopi don't all offer the same capabilities. Mnemopi isn't available through the agent tools.

For details and limitations, see [service behavior](./docs/service-behavior.md). Timing and failed writes matter more than a tidy demo.

## Thanks

Thank you to [Claude for Open Source](https://claude.com/contact-sales/claude-for-oss) and [Codex for Open Source](https://developers.openai.com/community/codex-for-oss).

## License

[MIT](./LICENSE)
