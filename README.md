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

The MCP, Pi, OMP, and AI SDK tools use Cloudflare over HTTP. They don't expose Mnemopi. The CLI now gives every agent tool a command, built from the same definitions.

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

Run the command from the checkout so `pnpm` can find the package. Pi doesn't load `.env`, so without these variables it checks `~/.pi/agent/memory-scope.json`.

The variables set the default: omit both namespace and profile to use `default/agent`. Half a pair is no pair at all: pass both to read or write another profile, or the call is refused.

Writes keep the host's session ID wherever they go, and the model can't pass `sessionId` as an argument. A default should be a starting point, not a fence.

Give `memory_remember` up to four `copies` and one call stores the same content and session in each profile. Pasting the same finding twice can finally retire. The main record lands first, but the writes aren't atomic. If a copy fails, the error shows what landed and which profiles still need a retry.

Opt in with `copySource: true` and copies get a parent. Each one ends with `Copied from memory "<id>" in <namespace>/<profile>.` after a blank line. The main record stays untouched.

That's handy once the tool result is gone. Cloudflare's remember API takes only content and a session ID, so the reference has to live in the content. It marks origin, not independent confirmation, and won't follow later edits. If the line would push a copy past 32768 bytes, nothing is written. Without the flag, copies stay verbatim.

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
