# PassControl

**An identity & credential gateway for AI agents.** Stop pasting your OpenAI / Anthropic /
Groq / Mistral / Together / DeepSeek keys into agent runtimes. Give each agent a cryptographic **passport**; it signs a challenge to
mint a short-lived **work-visa**; the gateway injects your *real* provider key from a vault
and proxies the call — so the agent never holds the key. You get per-agent budgets, scopes,
an instant kill switch, and a per-agent audit trail.

A [Vertias](https://vertias.eu) project. **Bring-your-own-key** (you keep your provider key);
self-host it, or use the managed version when it's available.

> ⚠️ **Status: early.** Built by a small team, **not yet independently audited.** It's
> security-focused and test-covered, but treat it as beta — run it on a non-critical key
> first, and see [Security](#security) for responsible disclosure. We'd rather you know than
> find out.

**New here? Start with the [Getting Started tutorial](./TUTORIAL.md)** — clone to a real
governed agent in ~15 minutes.

---

## Why
A raw provider key handed to an autonomous agent leaks (logs, repos, prompts), never rotates,
has no per-agent spend cap, no off-switch, and no record of *which* agent did *what*.
PassControl removes the key from the agent entirely and puts a governed gateway in front.

## How it works
1. **Passport** — each agent holds only an Ed25519 private key; it *only ever signs*, never travels.
2. **Work-visa** — the agent signs a challenge (timestamp + single-use nonce) → mints a
   short-lived (5 min) HS256 token carrying its identity, scope, and budget.
3. **Inject & proxy** — a request arrives with a visa; the gateway verifies it → checks the
   kill switch → checks scope (provider + model **and** endpoint) → reserves budget → pulls
   your provider key from Supabase Vault → injects it → forwards to the provider and streams
   back. The agent never sees the key.
4. **Govern** — per-agent token **and dollar** budgets (enforced pre-flight), a layered kill
   switch (platform / tenant / per-agent), and an append-only audit log of every call.

## Features
- 🔑 Agents never hold your provider key (BYOK; key stays in the vault, injected in-flight)
- 🪪 Per-agent cryptographic identity (Ed25519), short-lived revocable visas
- 💸 Enforced per-agent **token + cost (USD)** budgets — reserved pre-flight, reconciled after
- 🎯 **Capability scoping** — a visa is scoped to specific models *and* endpoints, so a
  chat-scoped agent can't reach files, fine-tuning, batches, responses, embeddings, etc.
  with your key
- ⛔ Layered, per-tenant kill switch + per-agent suspend — revoke a running agent mid-task
- 📒 Per-agent / per-passport audit trail (append-only; direct `UPDATE` / `DELETE` /
  `TRUNCATE` rejected by the database)
- 🧰 Drop-in for your SDK (OpenAI, Anthropic, + OpenAI-compatible **Groq / Mistral / Together
  / DeepSeek**), **or any agent** via the visa sidecar — point OpenHands / Aider / Cline /
  Continue at a local proxy and it just works
- 🖥️ Control Tower dashboard (fleet, spend, budgets, audit, kill switch) + a developer
  control-plane API + TOTP MFA

## Quickstart (self-host)
Stack: **Next.js** (App Router, edge routes) · **Supabase** (Postgres + Vault + Auth) ·
**Upstash Redis**. Deploy on Vercel or any Node host (`next start`). No Vercel-proprietary
services are required — the kill switch is Redis-backed.

### Local (Docker) quickstart
For the fastest local run, use the bundled Docker stack. It starts Supabase locally
(Postgres + Vault + Auth), Redis-over-REST, applies migrations inside the DB container, and
seeds a confirmed dev user. Prereqs: Docker Desktop and the Supabase CLI. No host `psql`
is required.

```bash
git clone https://github.com/Vertias3u/PassControl && cd PassControl
npm install
npm run dev:stack     # starts Supabase + Redis locally, migrates, seeds a dev user
npm run dev:docker    # runs the app against the local stack (loads .env.docker)
```

> Use **`npm run dev:docker`**, not `npm run dev`, for the local stack — plain `npm run
> dev` loads `.env.local` (your hosted Supabase), not the Docker stack's `.env.docker`.

Open `http://localhost:3000` and log in with:

```text
dev@passcontrol.local
passcontrol-dev
```

> ⚠️ This seeded dev user exists **only for the local Docker stack** and is created by
> `scripts/seed.mjs`. It is a convenience for local development — **never deploy it or reuse
> these credentials** in a hosted/production instance. Real deployments create accounts
> through normal signup (gated by `INVITE_CODE`); no default credentials ship.

Then add a provider key in the Control Tower, issue a passport, and run:

```bash
passcontrol init
passcontrol doctor --deep
passcontrol call "Say hello in 3 words"
passcontrol spend
```

From an unlinked source checkout, use `npm run cli -- <command>` for the same CLI.

The final agent call uses your real Anthropic/OpenAI key from the local Vault, so start
with a non-critical key.

### Manual self-host quickstart

> **Supabase specifically** (not vanilla Postgres): the credential vault uses the
> `supabase_vault` extension, so you need a Supabase project (hosted or the self-hosted
> Supabase stack), not a plain Postgres database.

```bash
git clone https://github.com/Vertias3u/PassControl && cd PassControl
npm install
cp .env.example .env.local          # fill in Supabase / Upstash / secrets
DATABASE_URL='postgresql://…' npm run migrate   # applies db/migrations/*.sql in order, once each
npm run dev                         # or build + `next start` on any Node host
```
See `.env.example` for the full config (Supabase URL/keys, `VISA_SECRET`, `CACHE_ENC_KEY`,
Upstash, `CRON_SECRET`, `INVITE_CODE`). Apply migrations `0001 → …` in order;
`db/tests/rls_invariants.sql` checks tenant isolation on your database.

**Background reconcile job (required on non-Vercel hosts):** a periodic call to
`GET /api/cron/reconcile` (with header `Authorization: Bearer $CRON_SECRET`) corrects budget
drift and flushes last-seen. On Vercel it's wired via `vercel.json`. Self-hosting, schedule it
yourself (system `cron`, a GitHub Action, etc.) every few minutes — it's a correction layer,
not the hot path, so an occasional missed run is harmless.

## Using it from an agent
The client SDK hides the visa dance — point your provider SDK at the gateway:

```ts
import OpenAI from "openai";
import { PassControl } from "./sdk";

const pc = new PassControl({ gateway, passportId, passportSecret });
const openai = new OpenAI(pc.clientOptions("openai")); // baseURL + auth wired; visas auto-refresh
```

The SDK is vendored in this repo under `./sdk`; it is not a separately published npm package
yet.

**Using an agent you don't control (OpenHands, Aider, Cline, Continue…)?** They expect a
static API key, but a visa expires in minutes. Run the **visa sidecar** — a local proxy that
mints/refreshes the visa for you — and point the agent at it like any other endpoint:

```bash
passcontrol sidecar   # http://127.0.0.1:8788
passcontrol env openhands
# then set the agent's base URL to http://127.0.0.1:8788/api/v1/anthropic (or /openai),
# API key = anything. The agent never holds a real key or a long-lived token.
```

Manage the fleet programmatically with the control-plane SDK + API key:

```ts
import { ControlClient } from "./sdk";
const cp = new ControlClient({ gateway, apiKey: process.env.PASSCONTROL_API_KEY! });
await cp.agents.list();
await cp.killSwitch.set(true);
```

The CLI also exposes the common read/control paths:

```bash
passcontrol agent list
passcontrol spend
passcontrol logs --limit 20
passcontrol audit --limit 20
passcontrol kill on
```

Full API reference: [`openapi.yaml`](./openapi.yaml) and [`DOCUMENTATION.md`](./DOCUMENTATION.md).
Runnable example agents in [`examples/`](./examples).

## Limitations
- A work-visa is a bearer token and is reusable until it expires (≤5 minutes). Keep it out
  of logs and prompts; use suspend/kill switches to block future requests.
- The gateway proxies only chat and model-listing endpoints: OpenAI/Groq/Mistral/Together
  chat completions and models, Anthropic messages and models, and DeepSeek chat
  completions. It does **not** proxy embeddings, files, fine-tuning, batches, responses, or
  token-counting endpoints.
- Pricing is a best-effort in-code table and can lag provider price changes. Use it for
  budgets and monitoring, not as billing reconciliation against provider invoices.
- Instant revocation assumes Redis is configured for persistence/no-eviction behavior. If
  Redis evicts suspend/kill keys, enforcement falls back to short visa TTLs and durable agent
  status checks at the next mint.

## Security
Security is the point of this project, so please report issues privately rather than opening
a public issue: **security@vertias.eu**. We'll acknowledge and work with you on a fix +
disclosure timeline. Notes:
- It's **BYOK** — your provider key lives encrypted in your own Supabase Vault; it's
  decrypted only in-flight and cached briefly (encrypted) in your own Redis.
- It is **not yet independently audited.** If you find a hole, you're doing us a favor.

## License
Source-available under the **Business Source License (BSL 1.1)** — read it, run it, modify it,
self-host it. The one restriction: you may not offer it as a competing hosted/managed service.
Converts to Apache 2.0 after the change date. See [`LICENSE`](./LICENSE).

## Contributing
Issues and PRs welcome. Run `npm run typecheck && npm test && npm run build` before a PR (CI
enforces it). Be kind; this is early.
