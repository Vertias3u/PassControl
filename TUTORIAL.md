# PassControl — Getting Started

A hands-on walkthrough: from a fresh clone to a **real agent running through PassControl**,
budgeted, scoped, and revocable — with its provider key never in its hands. About 15 minutes.

> This is a tutorial (do-this-then-that). For the API reference see
> [`DOCUMENTATION.md`](./DOCUMENTATION.md); for the SDK see [`sdk/README.md`](./sdk/README.md).
> PassControl is **early and not yet independently audited** — run it on a non-critical key.

---

## 1. The idea in 60 seconds

You don't give the agent your OpenAI/Anthropic key. Instead:

- Each agent holds an Ed25519 **passport** — a private key that *only ever signs*, never travels.
- To make a call, the agent signs a challenge and gets a short-lived (5-min) **work-visa**.
- It sends the visa to the **gateway**, which verifies it, checks the kill switch, checks the
  agent's **scope** and **budget**, then pulls your *real* provider key from a vault, injects
  it, and forwards the call. The agent only ever sees the visa.

So a leaked visa dies in minutes, every call is budgeted and audited, and you can cut any
agent off instantly — all without the agent ever holding the key.

Three nouns you'll use: **passport** (the agent's identity), **visa** (a short-lived token
minted from it), **scope** (which provider/model/endpoints that agent may use).

---

## 2. Run it locally (one command stack)

**Prerequisites:** [Docker Desktop](https://www.docker.com/) running, the
[Supabase CLI](https://supabase.com/docs/guides/local-development), and Node 18+.
No hosted accounts needed — the whole stack runs locally. (No host `psql` required.)

```bash
git clone https://github.com/Vertias3u/PassControl && cd PassControl
npm install
npm run cli -- setup  # starts local services, migrates, seeds a dev user, opens dashboard
```

Open **http://localhost:3000** and log in with the seeded dev user:

```
dev@passcontrol.local
passcontrol-dev
```

> Use `npm run cli -- setup --no-open` to suppress browser launch. If another local
> Supabase/Redis project owns the default service ports, use `npm run cli -- setup --no-open
> --port-offset 100`. This offsets those local service ports together; the dashboard keeps its
> configured gateway port (3000 by default).
>
> The seeded dev user is **local-only** (created by `scripts/seed.mjs`) — never deploy it.
> To reset to a truly clean slate: `npm run cli -- reset --local --confirm RESET`.

You should land on the **Control Tower** dashboard — empty fleet, no spend yet.

---

## 3. Your first governed call

**a. Add a provider key.** In the Control Tower, open **Provider Keys** → add an
**Anthropic** key (`sk-ant-…`). Use a **non-critical** key. It goes straight into the local
Vault, encrypted — PassControl never stores it in plaintext.
*(Supported providers: OpenAI, Anthropic, Groq, Mistral, Together, DeepSeek.)*

**b. Issue a passport.** Click **Issue passport** (or create an agent). The keypair is
generated **in your browser**; you'll see the private key **once**. Copy both:
- `PASSPORT_ID` (public key)
- `PASSPORT_SECRET` (private key)

Give it a **scope** of `anthropic` / `claude-*` so it can call any Claude model.

**c. Configure the CLI and make the call.** The `passcontrol` CLI is the terminal cockpit for
an agent and its fleet: it removes the env-var soup, can call a model, run a sidecar, inspect
spend/logs, and operate the kill switch. Configure your passport once, then just call. From a
source checkout (what you have after cloning), run it via `npm run cli --`:

```bash
npm run cli -- init                      # prompts for gateway + passport, writes .passcontrol
npm run cli -- doctor --deep             # verifies gateway/config; mints a visa if configured
npm run cli -- call "Say hi in 3 words"
```

> The short `passcontrol …` form (instead of `npm run cli --`) works once you `npm link` the
> repo, or when the package is installed. It's not published to npm yet — from a clone, use
> `npm run cli --`. Runnable raw example scripts also live in [`examples/`](./examples).

Want the short form on a development machine? From the repository root, run `npm link`, then:

```bash
passcontrol --help
passcontrol status
passcontrol call "Say hi in 3 words"
```

Prefer env vars? They still work and override `.passcontrol`:

```bash
PASSPORT_ID=<pub> PASSPORT_SECRET=<priv> npm run cli -- call "Say hi in 3 words"
```

Expected:

```
✓ minted visa (expires in 300s)
response: Hey, what's up!
✓ done — check the dashboard audit log + spend for this call.
```

Refresh the dashboard: the **Audit Log** shows one `ok` row (tokens + cost), and spend ticked
up for that agent. That's the whole loop: passport → visa → key injected from the vault →
real call → audited.

### CLI cheat sheet

```bash
npm run cli -- status                 # cockpit: config, gateway, next commands
npm run cli -- doctor --fix           # recover a stopped local dashboard
npm run cli -- start                  # start the CLI-managed local dashboard
npm run cli -- restart                # replace the CLI-managed dashboard process
npm run cli -- local-logs --follow    # stream local dashboard output
npm run cli -- sidecar                # local bridge for OpenHands/Aider/Cline/etc.
npm run cli -- agent list             # managed passports
npm run cli -- spend                  # fleet and per-agent spend
npm run cli -- logs --limit 20        # recent gateway calls
npm run cli -- kill on                # emergency tenant stop
npm run cli -- kill off               # release the tenant stop
npm run cli -- configure aider        # preview an Aider project config
npm run cli -- configure aider --write # write it only if no .aider.conf.yml exists
```

Run `npm run cli -- --help` for the complete command list. The CLI reads environment variables,
then `.passcontrol`, then `~/.config/passcontrol/config`; keep passport secrets out of source
control.

---

## 4. Govern it

**Set a budget.** Edit the agent in the dashboard and set a **Token budget** and/or a
**Cost budget (USD)**. Budgets are reserved *before* the call and reconciled after.

To watch a budget bite, set a tiny one — e.g. **Token budget = 50** — then run the agent
again:

```
✗ proxy error 402: {"error":"blocked_budget"}
```

The gateway blocked it before spending a cent. Raise the budget back up and it works again.
*(Cost budgets are whole cents — the smallest is $0.01. To trip a $0.01 cost cap you need a
call estimated over 1¢, e.g. `max_tokens` ≥ 2000.)*

**Scope is capability, not just a model.** An agent scoped to chat can only reach the chat
and model-listing endpoints — it **cannot** use your key for `/v1/files`, fine-tuning,
batches, embeddings, etc. Try it (via the sidecar in §5) and you'll get
`403 blocked_endpoint`. That's what turns "here's a key" into "here's a key that can only do
one thing."

---

## 5. Use it with a real agent (OpenHands, Aider, Cline, …)

Most agents want a **static API key**, but a visa expires in minutes. The **visa sidecar**
bridges that: it holds your passport, mints/refreshes the visa in the background, and injects
it — so the agent points at a normal-looking endpoint and never holds a real key *or* a
long-lived token.

```bash
# Reuses PASSCONTROL_GATEWAY + PASSPORT_ID/PASSPORT_SECRET from .passcontrol.
npm run cli -- sidecar        # -> http://127.0.0.1:8788
```

Then point your agent at the sidecar exactly like a provider, API key = anything:

- **Base URL:** `http://127.0.0.1:8788/api/v1/anthropic` (or `/api/v1/openai`)
- **API key:** `sidecar` (ignored — the sidecar replaces it)
- **Model:** one that your passport's scope allows

For **OpenHands** (LiteLLM under the hood): set the custom model to `anthropic/claude-…`,
base URL to the sidecar, key to anything. Run a task and watch the Audit Log fill with
governed calls — the agent is doing real work, and the key stayed in the vault the whole time.
To print a copy/paste starting point:

```bash
npm run cli -- env openhands
```

Other common presets:

```bash
npm run cli -- env aider
npm run cli -- env cline
npm run cli -- env continue
npm run cli -- env litellm
```

Compatibility rule of thumb: PassControl proxies chat completions/messages and model-listing
only. If a client tries OpenAI's newer `/responses` endpoint, embeddings, files, or
fine-tuning, the gateway correctly returns `403 blocked_endpoint`. In Continue, set
`useResponsesApi: false` for OpenAI/gpt-5/o-series configs so it uses `/chat/completions`.

Quick sanity check that scoping works — a blocked endpoint returns `403 blocked_endpoint`:

```bash
curl -s -X POST http://127.0.0.1:8788/api/v1/anthropic/v1/files \
  -H 'content-type: application/json' -d '{"model":"claude-haiku-4-5"}'
# → {"error":"blocked_endpoint"}
```

---

## 6. Revoke a running agent (the kill switch)

This is the part a raw API key can't do. With an agent mid-task:

1. In the dashboard, **arm the kill switch** (the master kill), or suspend just that agent.
2. Its very next call returns **`403 blocked_suspended`** — within ~100ms, checked *before*
   the key is even touched.
3. **Disarm**, and it runs again.

No key rotation, no redeploy, no re-issuing the passport. One toggle severs a live agent and
another restores it. (Note: instant in-flight revocation relies on Redis; see §7. A call
*already in flight* when you flip the switch completes — new calls are blocked immediately.)

---

## 7. Going to production

The Docker stack is for local dev. To self-host for real:

```bash
cp .env.example .env.local          # fill in Supabase / Upstash / secrets
DATABASE_URL='postgresql://…' npm run migrate   # apply db/migrations in order, once each
npm run build && npm run start      # or deploy to Vercel / any Node host
```

Production checklist:

- **Supabase specifically** (not vanilla Postgres) — the vault uses the `supabase_vault`
  extension. Use a Supabase project (hosted or self-hosted).
- **Strong secrets:** `VISA_SECRET` and `CACHE_ENC_KEY` must be ≥32 bytes of real randomness
  (`openssl rand -base64 32`). PassControl refuses to start with a short `VISA_SECRET`.
- **Redis with eviction disabled** (`maxmemory-policy noeviction`) — instant revocation
  relies on suspend/kill keys not being evicted under memory pressure.
- **Behind a trusted proxy** — per-IP rate limits trust `X-Forwarded-For`; only real behind
  Vercel or a proxy that sets it.
- **Reconcile cron** — schedule `GET /api/cron/reconcile` (Bearer `$CRON_SECRET`) every few
  minutes to correct budget drift. On Vercel it's wired via `vercel.json`; elsewhere use
  system `cron` or a GitHub Action.
- **Never deploy the seeded dev user** — real accounts sign up (gated by `INVITE_CODE`).
- **Kill switch fail mode** — reads fail *open* by default; set `KILL_SWITCH_FAIL_CLOSED=true`
  to make a Redis read failure block instead.

---

## Where to go next

- **Manage the fleet in code** — the control-plane SDK + a `pc_` API key: see
  [`sdk/README.md`](./sdk/README.md) and [`DOCUMENTATION.md`](./DOCUMENTATION.md).
- **More example agents** — [`examples/`](./examples) (chat agent, tool-using starter agent,
  fleet-admin CLI, the visa sidecar).
- **Security model + responsible disclosure** — [`SECURITY.md`](./SECURITY.md).

Found a rough edge or a security issue? See `SECURITY.md` — we'd rather you tell us.
