# @agntn/memory

Give an agent a way to remember facts between conversations. `@agntn/memory` provides one library contract for Cloudflare Agent Memory and OMP Mnemopi, plus memory tools for MCP, Pi, and OMP.

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

Cloudflare also supports HTTP with an `accountId`, `namespace`, and `apiToken`. Mnemopi requires Bun clients that you supply. The package doesn't import them for you.

| Provider     | Backend                 | Connection              |
| ------------ | ----------------------- | ----------------------- |
| `cloudflare` | Cloudflare Agent Memory | Workers binding or HTTP |
| `mnemopi`    | OMP Mnemopi             | Supplied Bun clients    |

Check provider `capabilities` before relying on backend-specific features. For example, Cloudflare HTTP supports listing profiles, but the Workers binding doesn't.

## Use with an agent

The MCP, Pi, and OMP tools use Cloudflare over HTTP. They don't expose Mnemopi. The CLI now gives every agent tool a command, built from the same definitions.

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

Run the command from the checkout so `pnpm` can find the package. The namespace and profile bind the tools to that scope. Pi does not load `.env`. Without these variables, Pi checks `~/.pi/agent/memory-scope.json`.

Don't have an API token? The tools can also use `cf` CLI authentication. Run `cf auth login` and omit `CLOUDFLARE_API_TOKEN`. Keep the account ID when the login reaches more than one account.

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
