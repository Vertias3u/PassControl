# PassControl

**An identity & credential gateway for AI agents.** Stop pasting your OpenAI / Anthropic /
Groq / Mistral / Together / DeepSeek keys into agent runtimes. Give each agent a cryptographic
**passport**; it signs a challenge to mint a short-lived **work-visa**; the gateway injects your
*real* provider key from a vault and proxies the call — so **the agent never holds the key**.
You get per-agent budgets, capability scopes, an instant kill switch, and a per-agent audit trail.

A [Vertias](https://vertias.eu) project. **Bring-your-own-key** — your provider key stays in your
own vault. Self-host it today; a managed version comes later.

![PassControl kill switch — a live agent's calls flip from 200 OK to 403 BLOCKED the instant the kill switch is armed, then back when it's released](docs/demo/kill-switch.gif)

*Instant, per-agent revocation — the kill switch cuts off a live agent mid-run (`200 OK` → `403 BLOCKED`) and restores it, with no key rotation and no redeploy. Real traffic through the gateway; the status codes and timestamps are live.*

> ⚠️ **Status: early.** Built by a small team, **not yet independently audited.** It's
> security-focused and test-covered, but treat it as beta — run it against a **non-critical key
> first**, and see [Security](#security) for responsible disclosure. We'd rather you know than
> find out.

**New here?** The [Getting Started tutorial](./TUTORIAL.md) takes you from install to a real
governed agent in ~15 minutes.

```bash
npm install -g passcontrol
passcontrol setup      # boots the self-hostable stack + opens the Control Tower
```

---

## Why

A raw provider key handed to an autonomous agent **leaks** (logs, repos, prompts), **never
rotates**, has **no per-agent spend cap**, **no off-switch**, and leaves **no record** of which
agent did what. PassControl takes the key out of the agent entirely and puts a governed gateway
in front of it.

## How it works

1. **Passport** — each agent holds only an Ed25519 private key. It *only ever signs*; the key
   never travels over the wire.
2. **Work-visa** — the agent signs a challenge (timestamp + single-use nonce) and mints a
   short-lived (~5 min) token carrying its identity, scope, and budget snapshot.
3. **Inject & proxy** — a request arrives bearing a visa. The gateway verifies it → checks the
   kill switch → checks scope (provider + model **and** endpoint) → reserves budget atomically →
   pulls your provider key from the vault → injects it → forwards to the provider and streams
   back. The agent never sees the key.
4. **Govern** — per-agent **token + dollar** budgets (enforced *before* the call), a layered kill
   switch (platform / tenant / per-agent), and an append-only audit log of every call.

```
agent ──sign──▶ challenge ──visa──▶  ┌─────────── PassControl gateway ───────────┐
                                     │ verify · kill/scope/budget · inject key    │ ──▶ provider
   (holds only a passport key)       │ (real key from vault, never returned)      │ ◀── stream
                                     └────────────────────────────────────────────┘
```

## Features

- 🔑 **Agents never hold your provider key** — BYOK; the key stays vaulted, injected in-flight only
- 🪪 **Per-agent cryptographic identity** (Ed25519) with short-lived, revocable visas
- 💸 **Enforced per-agent token + cost (USD) budgets** — reserved pre-flight, reconciled after
- 🎯 **Capability scoping** — a visa is scoped to specific models *and* endpoints, so a
  chat-scoped agent can't reach files, fine-tuning, batches, embeddings, etc. with your key
- ⛔ **Instant, layered kill switch** + per-agent suspend/revoke — stop a running agent mid-task
- 📒 **Append-only audit trail** per agent/passport (direct `UPDATE`/`DELETE`/`TRUNCATE` rejected
  by the database)
- 🧰 **Drop-in for your SDK** (OpenAI, Anthropic, and OpenAI-compatible Groq / Mistral / Together /
  DeepSeek) — **or any agent** via the visa sidecar (OpenHands, Aider, Cline, Continue…)
- 🖥️ **Control Tower** dashboard (fleet, spend, budgets, audit, kill switch) + a developer
  control-plane API + TOTP MFA

## Install & first run

**Global CLI (recommended):**

```bash
npm install -g passcontrol
passcontrol --version     # 0.1.2
passcontrol setup         # prereq checks → fetches the stack → boots it → opens the dashboard
```

The published npm package is **just the CLI** (a handful of files, no provider keys). `passcontrol
setup` detects the global install and offers to clone the self-hostable stack (Supabase + Redis +
dashboard) into `~/passcontrol`, install its dependencies, and start it — one command from nothing
to a running Control Tower. It first checks your prerequisites (Docker running, Supabase CLI, Node
version, free ports) and tells you exactly what to fix if something's missing.

- Change the checkout location: `--app-dir <path>` or `PASSCONTROL_APP_ROOT=<path>`
- Non-interactive: `--yes`
- Skip opening the browser: `--no-open`
- Ports already taken by another local Supabase? `passcontrol setup --port-offset 100`
  (offsets Supabase + Redis together, e.g. API `54421`, DB `54422`; the dashboard stays on `:3000`)

Then log in to the Control Tower at **http://localhost:3000** with the seeded local dev user:

```text
dev@passcontrol.local
passcontrol-dev
```

> ⚠️ This seeded user exists **only for the local Docker stack** (created by `scripts/seed.mjs`).
> **Never deploy it or reuse these credentials.** Real deployments create accounts through normal
> signup, gated by `INVITE_CODE`; no default credentials ship.

Add a **non-critical** provider key in the Control Tower, issue a passport, and copy the one-time
`PASSPORT_ID` / `PASSPORT_SECRET`. Then, in your project directory:

```bash
passcontrol init             # gateway + passport + provider/model → writes .passcontrol
passcontrol doctor --deep    # verifies config, prerequisites, and mints a test visa
passcontrol call "Say hello in 3 words"
passcontrol spend            # confirms governed spend
```

You'll see a streamed response and an `ok` row in the dashboard Audit Log — the complete governed
loop: **passport → visa → vault key injection → proxied call → audit**. That last call uses your
real key from the local Vault, so start with a throwaway one.

> Working from a **source clone** instead of the global install? Everything below works as
> `npm run cli -- <command>`; after `npm link` in the clone, the short `passcontrol <command>` form
> works too.

## Real agents & the visa sidecar

A visa is deliberately short-lived so it's revocable — but a real coding agent runs a **long,
multi-call session** that would outlive a single visa. The **sidecar** solves this: a tiny local
proxy that mints, caches, and auto-refreshes the visa (and re-mints instantly on expiry), so your
agent points at one stable endpoint and **never times out mid-task**.

```bash
passcontrol sidecar          # http://127.0.0.1:8788
passcontrol env openhands    # prints ready-to-paste settings for your agent
```

Point any OpenAI/Anthropic-compatible agent at the sidecar with a **dummy** key:

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:8788/api/v1/anthropic"   # or /api/v1/openai, /deepseek…
export ANTHROPIC_API_KEY="passcontrol"   # ignored — the sidecar injects a live visa
```

The agent never holds a real key or a long-lived token. Presets ship for **openhands, aider, cline,
continue, litellm** (`passcontrol env <preset>`). A single long streaming completion also works
directly — it's verified once at the start, so it finishes even if it runs past the visa TTL; only
*multi-call* sessions need the sidecar's refresh. Raise `VISA_TTL_SECONDS` (300–900) to widen the
window, but the sidecar is the real answer for long sessions.

> If a client defaults to OpenAI `/responses` (some Continue configs for o-series/gpt-5), force
> `/chat/completions` — PassControl intentionally proxies only chat/messages and model-listing
> endpoints.

## CLI command center

The primary interface is `passcontrol <command>`. Highlights:

| Need | Command |
|---|---|
| Config, gateway status, suggested next steps | `passcontrol status` |
| Check local setup / mint a test visa | `passcontrol doctor --deep` |
| Make a governed model call | `passcontrol call "Summarize this"` |
| Run the auto-refreshing bridge for an agent | `passcontrol sidecar` |
| Print agent settings (OpenHands, Aider, Cline, Continue, LiteLLM) | `passcontrol env openhands` |
| List / create agents | `passcontrol agent list` · `passcontrol agent create billing-bot` |
| Suspend, resume, or revoke an agent | `passcontrol agent suspend <id>` |
| Inspect spend, logs, and audit history | `passcontrol spend` · `passcontrol logs` · `passcontrol audit` |
| Arm / release the tenant kill switch | `passcontrol kill on` · `passcontrol kill off` |
| Prepare or repair local services | `passcontrol setup` · `passcontrol doctor --fix` |
| Manage the local dashboard | `passcontrol start` · `passcontrol stop` · `passcontrol restart` |
| Follow local dashboard logs | `passcontrol local-logs --follow` |
| Open the Control Tower | `passcontrol open` |
| Preview/write an agent config | `passcontrol configure aider` · `passcontrol configure aider --write` |

Config resolves in order: **environment variables → project-local `.passcontrol` →
`~/.config/passcontrol/config`**. `.passcontrol` holds a passport secret, is gitignored, and is
written owner-only — never commit or share it.

`passcontrol reset --local --confirm RESET` destroys and recreates local data — use it only for a
clean slate.

## Using it from your own code

The client SDK (vendored in [`./sdk`](./sdk)) hides the visa dance — point your provider SDK at the
gateway and visas auto-refresh:

```ts
import OpenAI from "openai";
import { PassControl } from "./sdk";

const pc = new PassControl({ gateway, passportId, passportSecret });
const openai = new OpenAI(pc.clientOptions("openai")); // baseURL + auth wired; visas auto-refresh
```

Manage the fleet programmatically with the control-plane SDK + an API key:

```ts
import { ControlClient } from "./sdk";
const cp = new ControlClient({ gateway, apiKey: process.env.PASSCONTROL_API_KEY! });
await cp.agents.list();
await cp.killSwitch.set(true);
```

The SDK is not a separately published npm package yet. Full API reference:
[`openapi.yaml`](./openapi.yaml) and [`DOCUMENTATION.md`](./DOCUMENTATION.md). Runnable example
agents live in [`examples/`](./examples).

## Self-host

Stack: **Next.js** (App Router, edge routes) · **Supabase** (Postgres + Vault + Auth) · **Upstash /
any Redis**. Deploy on Vercel or any Node host (`next start`). No Vercel-proprietary services are
required — the kill switch is Redis-backed.

### Local (Docker) — the fastest path

`passcontrol setup` (above) is the one-command route. Under the hood it runs the bundled Docker
stack: local Supabase (Postgres + Vault + Auth), Redis-over-REST, migrations applied inside the DB
container, and a seeded dev user. Prereqs: **Docker Desktop, the Supabase CLI, Node 18+** — no host
`psql` required.

From a source checkout you can drive the same thing directly:

```bash
git clone https://github.com/Vertias3u/PassControl && cd PassControl
npm install
npm run cli -- setup      # or: passcontrol setup after `npm link`
```

### Manual self-host

> **Supabase specifically** (not vanilla Postgres): the credential vault uses the `supabase_vault`
> extension, so you need a Supabase project — hosted or the self-hosted Supabase stack — not a
> plain Postgres database.

```bash
git clone https://github.com/Vertias3u/PassControl && cd PassControl
npm install
cp .env.example .env.local                       # fill in Supabase / Redis / secrets
DATABASE_URL='postgresql://…' npm run migrate     # applies db/migrations/*.sql in order, once each
npm run dev                                       # or build + `next start` on any Node host
```

See [`.env.example`](./.env.example) for the full config (Supabase URL/keys, `VISA_SECRET`,
`CACHE_ENC_KEY`, Redis, `CRON_SECRET`, `INVITE_CODE`). Apply migrations `0001 → …` in order;
[`db/tests/rls_invariants.sql`](./db/tests/rls_invariants.sql) checks tenant isolation and the
privileged-column locks on your database.

**Background reconcile job (required on non-Vercel hosts):** a periodic `GET /api/cron/reconcile`
(header `Authorization: Bearer $CRON_SECRET`) corrects budget drift and flushes last-seen. On
Vercel it's wired via `vercel.json`; elsewhere schedule it yourself (system `cron`, a GitHub
Action…) every few minutes. It's a correction layer, not the hot path — an occasional missed run is
harmless.

## Providers & endpoints

Supported providers: **OpenAI, Anthropic, Groq, Mistral, Together, DeepSeek**. The gateway proxies
**only chat and model-listing endpoints** — OpenAI-shaped chat completions + models, Anthropic
messages + models, DeepSeek chat completions. It does **not** proxy embeddings, files, fine-tuning,
batches, `/responses`, or token-counting endpoints (that's the point — a leaked visa can't reach
your full provider surface).

## Limitations

- A work-visa is a **bearer token**, reusable until it expires (≤5 min). Keep it out of logs and
  prompts; use suspend/kill to block future requests immediately.
- **Pricing** is a best-effort in-code table and can lag provider price changes. Use it for budgets
  and monitoring, not billing reconciliation against provider invoices.
- **Instant revocation** assumes Redis is configured for persistence / no-eviction. If Redis evicts
  suspend/kill keys, enforcement falls back to short visa TTLs and the durable agent-status check at
  the next mint.

## Security

Security is the whole point, so please report issues privately rather than opening a public issue:
**security@vertias.eu**. We'll acknowledge and work with you on a fix + disclosure timeline.

- It's **BYOK** — your provider key lives encrypted in your own Supabase Vault, decrypted only
  in-flight and cached briefly (encrypted) in your own Redis. It is never logged or returned.
- Tenant isolation is enforced by Postgres **RLS on every table**; the sole decrypt path is a
  `SECURITY DEFINER`, service-role-only function.
- It is **not yet independently audited.** If you find a hole, you're doing us a favor.

## License

Source-available under the **Business Source License (BSL 1.1)** — read it, run it, modify it,
self-host it. The one restriction: you may not offer it as a competing hosted/managed service.
Converts to Apache 2.0 after the change date. See [`LICENSE`](./LICENSE).

## Contributing

Issues and PRs welcome. Run `npm run typecheck && npm test && npm run build` before a PR (CI
enforces it). Be kind — this is early.
