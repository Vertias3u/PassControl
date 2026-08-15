# PassControl

**An identity & credential gateway for AI agents.** Stop pasting your OpenAI / Anthropic /
Groq / Mistral / Together / DeepSeek keys into agent runtimes. Start with a named,
revocable **Direct Agent Key**, or give the agent a higher-assurance cryptographic
**passport** that signs challenges for short-lived **work-visas**. The gateway injects your
*real* provider key from a vault and proxies the call — so **the agent never holds the key**.
You get per-agent budgets, capability scopes, an instant kill switch, and a per-agent audit trail.

A [Vertias](https://vertias.eu) project. **Bring-your-own-key** — your provider key stays in your
own vault when self-hosted, or in the managed server-side Vault in PassControl Cloud. Cloud is
currently a free private beta; [request access](https://passcontrol.vertias.eu/beta).

### ▶ [See it work in 60 seconds →](https://passcontrol.vertias.eu)

No signup, no provider key, nothing to install. Run a governed AI call, arm the kill switch,
run the same call again, and watch it get blocked at the gateway. The demo runs the **real**
pipeline — passport → work-visa → scope + budget checks → kill switch — and only the model
response is synthesized, by a keyless provider that never touches a vault.

The hosted demo includes the public **signed-receipt verifier** at
[`/verify/receipt`](https://passcontrol.vertias.eu/verify/receipt). Verification runs in your
browser; the receipt is never uploaded to PassControl.

**Hermes Agent:** the dashboard prints Hermes's current custom-provider YAML for a reveal-once
Direct Agent Key. The self-hosted CLI prints the passport-sidecar form with `passcontrol env
hermes`. See [`docs/integrations/hermes.md`](./docs/integrations/hermes.md).

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

1. **Identity** — use a reveal-once Direct Agent Key in the provider-native SDK or compatible client, or a
   passport whose Ed25519 private key only signs and never travels over the wire.
2. **Work-visa (passport mode)** — the agent signs a challenge (timestamp + single-use nonce) and mints a
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
- 🔌 **Direct Agent Keys** — named, independently revocable installation credentials for a
  fast provider-native on-ramp, with receipts that never mislabel them as passports
- 💸 **Enforced per-agent token + cost (USD) budgets** — reserved pre-flight, reconciled after
- 🎯 **Capability scoping** — a visa is scoped to specific models *and* endpoints, so a
  chat-scoped agent can't reach files, fine-tuning, batches, embeddings, etc. with your key
- ⛔ **Instant, layered kill switch** + per-agent suspend/revoke — stop a running agent mid-task
- 📒 **Append-only audit trail** per agent/passport (direct `UPDATE`/`DELETE`/`TRUNCATE` rejected
  by the database)
- 🧾 **Signed call receipts** — a governed call, allowed *or* blocked, is recorded in an
  Ed25519-signed artifact a counterparty can check without an account, your database, or your
  permission ([details below](#signed-call-receipts))
- 🌐 **Paste-and-check verification page** at `/verify/receipt` — runs entirely in the visitor's
  browser; the receipt is never uploaded
- 👤 **Owner binding** — declare who your agents are operated by, so a receipt can say *whose*
  agent made the call. Self-declared by default; provable by domain control or an identity
  check, and the two are stored and rendered separately so a claim never passes as a fact
- 🧰 **Drop-in for your SDK** (OpenAI, Anthropic, and OpenAI-compatible Groq / Mistral / Together /
  DeepSeek) — **or any agent or desktop chat app** that takes a base URL and a key (OpenHands,
  Aider, Cline, Continue, Chatbox, Jan, Msty, Cherry Studio, Open WebUI, LibreChat…): a Cloud
  Direct Agent Key on the hosted service, or the self-hosted visa sidecar. None of them has
  native passport support; the sidecar is what supplies passport identity locally
- 🔌 **Local MCP server** for Claude Desktop, Cursor, and Claude Code — governed `chat` and
  `list_models` tools with no provider key or passport secret in the client config
- 🪪 **Agent passport page** — a per-agent identity document: a sigil derived from the
  agent's public key, its visas (allowed scopes), the providers it has actually reached,
  budget state, and a redacted PNG you can export
- 🖥️ **Control Tower** dashboard (fleet, spend, budgets, audit, kill switch) + a developer
  control-plane API + TOTP MFA

## Install & first run

**Global CLI (recommended):**

```bash
npm install -g passcontrol
passcontrol --version     # confirms the install
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

During `dev:stack` the seed step (`scripts/seed.mjs`) asks you to **choose an account email
and password**. Then log in to the Control Tower at **http://localhost:3000** with those.

> ⚠️ **No shared default credentials ship**, on any install. The account you create guards the
> real provider keys in your local Vault — and the stack stops being localhost-only the moment
> you reach it from another device (Tailscale, LAN), so choose a real password. Non-interactive
> runs (CI, piped output) get a generated password printed once. Deployed installs create
> accounts through normal signup, gated by `INVITE_CODE`.

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

## Claude Desktop, Cursor, and Claude Code via MCP

PassControl ships a local stdio MCP server. Store the passport once in the owner-only global
profile, then let the CLI merge a secret-free entry into your client config:

```bash
passcontrol init --global
passcontrol configure claude-desktop --write   # or: cursor
# Claude Code: passcontrol configure claude-code prints its `claude mcp add` command
```

Restart the client, then use the governed `chat` and `list_models` tools. The generated config
contains only absolute Node/CLI paths—no passport or provider key. `chat` still goes through the
gateway's identity, scope, budget, endpoint, and kill-switch checks. Preview without writing via
`passcontrol configure claude-desktop`, or print the JSON with `passcontrol env claude-desktop`.

## Real agents & the visa sidecar

> **This is the self-hosted / advanced path.** On PassControl Cloud, a tool that accepts only a
> base URL and an API key gets a **Direct Agent Key** — issued reveal-once from the dashboard,
> bound to one agent, with no local process to run. Reach for the sidecar when you are
> self-hosting, or when you specifically want passport identity inside a static-key tool. If you
> control the application's JavaScript, neither applies: use the SDK
> ([`docs/integrations/passport-sdk.md`](./docs/integrations/passport-sdk.md)).

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

**Why not `HTTPS_PROXY`?** Because governing a `CONNECT` tunnel means terminating its TLS,
which means installing a certificate authority on your machine that can impersonate any
site to any program trusting it. PassControl exists to get a one-provider secret *off* your
machine; installing a broader one to save an environment variable is the wrong trade. So
the sidecar answers `HTTPS_PROXY` honestly instead of silently: a `CONNECT` to a provider
is **refused** with the base URL to use, never quietly tunnelled into a call that looks
governed and is not. It also refuses every other host — it is not an open proxy — and
`--allow-connect <host>` names exceptions, which can never be a provider.

The agent never holds a real key or a long-lived token. Presets ship for coding agents
(**openhands, aider, cline, continue, litellm**), for the desktop chat apps you would otherwise
paste a raw provider key into (**chatbox, jan, msty, cherry-studio, open-webui, librechat**), and
a catch-all **generic** (`passcontrol env <preset>`). `passcontrol env` with an unknown name
prints the current list, which is generated — it cannot drift from what the CLI accepts. Also,
**[Hermes Agent](docs/integrations/hermes.md)** works through the generic settings with no custom
code. A single long streaming completion also works
directly — it's verified once at the start, so it finishes even if it runs past the visa TTL; only
*multi-call* sessions need the sidecar's refresh. Raise `VISA_TTL_SECONDS` (300–900) to widen the
window, but the sidecar is the real answer for long sessions.

> If a client defaults to OpenAI `/responses` (some Continue configs for o-series/gpt-5), force
> `/chat/completions` — PassControl intentionally proxies only chat/messages and model-listing
> endpoints.

## Signed call receipts

Your audit log convinces **you**. It convinces nobody else — you control that database.

A **receipt** is one call's record, signed with your deployment's Ed25519 key. Anyone can
check it with no account, no access to your database, and no cooperation from you. Approvals
and refusals are both signed; *"the gateway stopped this agent from touching that model,
here's the proof"* is often the more useful document.

```bash
passcontrol keygen instance     # generates INSTANCE_SIGNING_KEY; set PASSCONTROL_ISSUER too
```

Then anyone you hand a receipt to runs:

```bash
passcontrol verify receipt "<receipt>" --issuer https://passcontrol.example.com
```

```
✓ Receipt is valid.
→ Issuer:   http://localhost:3000
→ Passport: kZCFp7d2x4VDruiulJ21gogYbczBDAGZa-OuwR3qgh8
→ Call:     POST chat/completions → demo/demo-1
→ Verdict:  ok (HTTP 200)
→ Usage:    15 in / 46 out · 61 µ¢
→ Request:  sha-256 VizsbKJwhtYoTNBv_XkJSf4ihWpdQWQfpXVvuDA6usM (105 bytes)
```

Change one character and it fails. No terminal? Your deployment serves a paste-and-check page
at **`/verify/receipt`** (including on the hosted demo) — verification runs in the visitor's browser, the receipt is never
uploaded, and the shareable link carries it in the URL fragment, which browsers never send to
a server.

**What it does and doesn't prove.** A valid signature means the named issuer signed this
record and nothing in it has changed. It does *not* vouch for the issuer — anyone can run
PassControl, so trusting it is the reader's call. It covers the **request and the gateway's
decision**, never the provider's reply. And the absence of a receipt proves nothing: receipt
writing is best-effort, so this is evidence, not a complete ledger.

> **Rotating the signing key is the one dangerous operation.** Receipts never expire, so
> replacing the key retroactively invalidates every receipt you have ever signed. Move the old
> seed to `INSTANCE_SIGNING_KEY_PREV` **first** — nothing is ever signed with it; it exists so
> its public half stays published. This is inverted relative to `VISA_SECRET_PREV`.

Full claim reference and the JWKS endpoint: [`DOCUMENTATION.md`](./DOCUMENTATION.md) ·
walkthrough: [`TUTORIAL.md`](./TUTORIAL.md).

## CLI command center

The primary interface is `passcontrol <command>`. Highlights:

| Need | Command |
|---|---|
| Config, gateway status, suggested next steps | `passcontrol status` |
| Check local setup / mint a test visa | `passcontrol doctor --deep` |
| Make a governed model call | `passcontrol call "Summarize this"` |
| Run the local MCP server | `passcontrol mcp` |
| Run the auto-refreshing bridge for an agent | `passcontrol sidecar` |
| Print agent/MCP settings without writing | `passcontrol env openhands` · `passcontrol env claude-desktop` |
| List / create agents | `passcontrol agent list` · `passcontrol agent create billing-bot` |
| Suspend, resume, or revoke an agent | `passcontrol agent suspend <id>` |
| Inspect spend, logs, and audit history | `passcontrol spend` · `passcontrol logs` · `passcontrol audit` |
| Generate this deployment's receipt signing key | `passcontrol keygen instance` |
| Check a receipt or agent token (no account needed) | `passcontrol verify receipt <jws> --issuer <origin>` |
| Arm / release the tenant kill switch | `passcontrol kill on` · `passcontrol kill off` |
| Prepare or repair local services | `passcontrol setup` · `passcontrol doctor --fix` |
| Start / stop the whole local stack | `passcontrol start` · `passcontrol stop` · `passcontrol restart` (add `--dashboard-only` to leave Supabase and Redis alone) |
| Follow local dashboard logs | `passcontrol local-logs --follow` |
| Point the CLI at a different checkout | `passcontrol setup --app-dir <path>` |
| Forget the remembered checkout | `passcontrol unlink` |
| Open the Control Tower | `passcontrol open` |
| Set up an integration (preview, or `--write`) | `passcontrol configure aider` · `passcontrol configure claude-desktop --write` |

`passcontrol stop` brings down the **whole** local stack — dashboard, Supabase, and Redis.
Use `--dashboard-only` to leave the services running. It never removes volumes, so your
Vault, passports, and audit log survive; wiping data stays with `reset` below.

Config resolves in order: **environment variables → project-local `.passcontrol` →
`~/.config/passcontrol/config`**. `.passcontrol` holds a passport secret, is gitignored, and is
written owner-only — never commit or share it.

The local stack itself lives in a checkout of this repo, not in the installed npm package.
The CLI resolves it in order: **`--app-dir <path>` → `PASSCONTROL_APP_ROOT` → the
surrounding checkout → the one it remembers** in `~/.config/passcontrol/app.json`.
`passcontrol status` shows which of those the current path came from. That remembered path
outlives `npm uninstall -g`, so if a fresh install keeps pointing at an old directory, clear
it with `passcontrol unlink` (or repoint with `--app-dir`).

`passcontrol reset --local --confirm RESET` destroys and recreates local data — use it only for a
clean slate.

## Using it from your own code

The client SDK exported at `passcontrol/sdk` hides the visa dance — point your provider SDK at the
gateway and visas auto-refresh:

```ts
import OpenAI from "openai";
import { PassControl } from "passcontrol/sdk";

const pc = new PassControl({ gateway, passportId, passportSecret });
const openai = new OpenAI(pc.clientOptions("openai")); // baseURL + auth wired; visas auto-refresh
```

Manage the fleet programmatically with the control-plane SDK + an API key:

```ts
import { ControlClient } from "passcontrol/sdk";
const cp = new ControlClient({ gateway, apiKey: process.env.PASSCONTROL_API_KEY! });
await cp.agents.list();
await cp.killSwitch.set(true);
```

Both credential-bearing clients enforce the same `gateway` boundary — a bare HTTPS origin, plain
HTTP only on loopback — and refuse anything else at construction, before any request.

The compiled ESM SDK ships in npm version 0.6.0. Keep Passport secrets **and `pc_` control keys**
in trusted server runtimes, never browser-exposed variables. See the
[Cloud Passport SDK guide](./docs/integrations/passport-sdk.md).
Full API reference: [`openapi.yaml`](./openapi.yaml) and [`DOCUMENTATION.md`](./DOCUMENTATION.md). Runnable example
agents live in [`examples/`](./examples).

## Self-host

Stack: **Next.js** (App Router, edge routes) · **Supabase** (Postgres + Vault + Auth) · **Upstash /
any Redis**. Deploy on Vercel, Cloudflare Workers through the tested OpenNext path, or any Node host
(`next start`). No Vercel-proprietary services are required — the kill switch is Redis-backed. See
[`docs/deployment/cloudflare.md`](./docs/deployment/cloudflare.md) for the Cloud build, production
Auth/SMTP checklist, five-minute Cron Trigger, local `workerd` preview, and owner-only deploy handoff.

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
`CACHE_ENC_KEY`, Redis, `CRON_SECRET`, `PASSCONTROL_SIGNUP_MODE`, `INVITE_CODE`). Apply migrations `0001 → …` in order;
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

Security is the whole point, so please report issues privately rather than opening a public
issue — use GitHub's
**[private vulnerability reporting](https://github.com/Vertias3u/PassControl/security/advisories/new)**
(Security tab → "Report a vulnerability"). You'll get an acknowledgement and a fix +
disclosure timeline worked out with you.

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
