# memory Worker

The memory MCP server on Cloudflare Workers, for one person: you.

## Why?

Some clients only take a URL. This Worker is that URL. It talks to Agent Memory through a binding, and Cloudflare Access decides who gets in.

## 📦 Setup

You need a Zero Trust organization and an Agent Memory namespace called `default` on the same account.

1. In Zero Trust, add an Access application of type SaaS with OIDC. Redirect URL: `https://agntn-memory.<you>.workers.dev/callback`. Policy: your email only.
2. Copy its client ID, client secret and issuer.
3. Put the deployment into `worker/.env.secrets`. Git ignores it.

```dotenv
MCP_URL=https://agntn-memory.<you>.workers.dev/mcp
OWNER_EMAIL=you@example.com
ACCESS_ISSUER=<issuer from step 2>
ACCESS_CLIENT_ID=<client id>
ACCESS_CLIENT_SECRET=<client secret>
CONSENT_SECRET=<openssl rand -hex 32>
```

4. Deploy.

```bash
pnpm --dir worker install
pnpm --dir worker run deploy --secrets-file .env.secrets
```

## 🔌 Connect

```bash
claude mcp add --transport http memory https://agntn-memory.<you>.workers.dev/mcp
```

The first call opens a browser. Allow the client, then sign in to Access. Another email gets `access_denied`, even if the Access policy lets it through.

## 🔍 Tracing

Each tool call is an `execute_tool` span in Workers Observability. Name, duration, error. Arguments and results stay out. They are your memories. Set `MEMORY_TRACE_PAYLOADS` to `"true"` when you want them anyway.

## 🛠️ Development

```bash
pnpm --dir worker typecheck
pnpm --dir worker test     # MCP client against the server, fake binding
pnpm --dir worker build
```

`cf dev` wants Cloudflare credentials. Agent Memory has no local simulation.
