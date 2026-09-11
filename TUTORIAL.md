# PassControl — Getting Started

A hands-on walkthrough: from a fresh clone to a **real agent running through PassControl**,
budgeted, scoped, and revocable — with its provider key never in its hands. About 15 minutes.

> This is a tutorial (do-this-then-that). For the API reference see
> [`DOCUMENTATION.md`](./DOCUMENTATION.md); for the SDK see [`sdk/README.md`](./sdk/README.md).
> PassControl is **early and not yet independently audited** — run it on a non-critical key.

---

## 1. The idea in 60 seconds

You do not give the agent your OpenAI, Anthropic, Gemini, or other supported provider key. Instead:

- In Passport mode, the trusted client holds an Ed25519 **Passport** — a private key that *only ever signs*, never travels.
- To make a call, the agent signs a challenge and gets a short-lived (5-min) **work-visa**.
- It sends the visa to the **gateway**, which verifies it, checks the kill switch, checks the
  agent's **scope** and **budget**, then pulls your *real* provider key from a vault, injects
  it, and forwards the call. The agent only ever sees the visa.

A visa expires in minutes. The gateway checks subsequent calls against stop controls
and budgets, and attempts to record them. A Direct Agent Key is the separate static-key
option: a bearer credential bound to one agent, without the Passport mint step.
Sender-constrained mode adds per-request proof; it requires a proof-capable client.

Three nouns you'll use: **passport** (the agent's identity), **visa** (a short-lived token
minted from it), **scope** (which provider/model/endpoints that agent may use).

---

## 2. Get a working setup

Two paths. **Take the first one unless you specifically want to operate the gateway yourself** —
it needs Node/npm and access to the Cloud private beta, and it attempts a governed
demo call after approval. [Request access](https://passcontrol.vertias.eu/beta).

### The fast path — Cloud

```bash
npm install -g passcontrol
passcontrol login            # browser opens, you approve once, this machine is set up
```

`login` prints an 8-character code, copies it to your clipboard, and opens the approval page.
Paste it, press **Approve**. The CLI generates an Ed25519 keypair *on your machine* — only the
public half is ever sent — creates your agent, and writes the config itself. The private key never reaches Cloud. Browser approval grants this machine a workspace
control key as well as enabling local agent setup. Only approve a code you initiated.

On a gateway with demo mode and signing configured, it attempts this proof (output varies):

```
✓ minted a visa with the passport this machine just created
✓ governed call ok — demo/demo-1, 12 tokens
✓ receipt verified against https://passcontrol.vertias.eu/.well-known/jwks.json

  Your agent is live. Anyone can check that call for themselves:
  passcontrol verify receipt eyJhbGc… --issuer https://passcontrol.vertias.eu
```

That tests **Passport → visa → scope + budget → synthetic call → receipt**. It does
not test a real provider or billing; a setup can succeed while the demo/receipt leg is unavailable. §5 explains what that receipt is and why a stranger can check it.

The code travels from your terminal **to** the browser, never the other way and never in a link.
**We will never send you an approval URL with the code already filled in** — approving one of
those would hand whoever sent it a key to your workspace.

Done with a machine later? `passcontrol logout` revokes its control key and clears its
credentials.

**If you took this path, skip to §4** — §3 is the by-hand setup, and `login` already did it.

### The other path — run the gateway yourself

Everything below is self-hosting: your own Postgres, your own Vault, your own signing key, and
your instance signs its own receipts. You control where requests are processed, but calls still leave for the selected
upstream unless you configure a local custom endpoint. It is more to operate.

**Prerequisites:** [Docker Desktop](https://www.docker.com/) running, the
[Supabase CLI](https://supabase.com/docs/guides/local-development), Git, and **Node 22+ with npm** for the full stack (the CLI alone declares ≥18).
No hosted accounts needed — the whole stack runs locally. (No host `psql` required.)

**On Windows, also install [Git for Windows](https://git-scm.com/download/win)** and run the
commands from a normal terminal (PowerShell or `cmd`). The local stack bootstrap is a bash
script, and the `bash` Windows puts on PATH by default is not a shell — it is the Microsoft
Store alias, or the WSL launcher, which fails with `execvpe(/bin/bash) failed` when no distro
is installed. PassControl finds Git Bash itself and does not use whichever `bash` is first on
PATH, so you do not need to reorder anything; you just need Git Bash present. If it is
installed somewhere unusual, point at it with `PASSCONTROL_BASH=<path to bash.exe>`.

Install the CLI globally and let it fetch + boot the stack for you:

```bash
npm install -g passcontrol
passcontrol setup  # checks prereqs, clones the stack, starts services, migrates, seeds, opens dashboard
```

`passcontrol setup` clones the self-hostable stack into `~/passcontrol` (override with
`--app-dir <path>`), installs it, and starts it. Prefer to clone yourself? That works too:

```bash
git clone https://github.com/Vertias3u/PassControl && cd PassControl
npm install
npm run cli -- setup   # run the CLI from the checkout
```

The seed step asks you to choose an account email and password — that account guards your
local Vault, so pick a real one. Open **http://localhost:3000** and log in with it.

> No shared default credentials ship. Non-interactive runs get a generated password,
> printed once by the seed step.

> Use `passcontrol setup --no-open` to suppress browser launch. If another local
> Supabase/Redis project owns the default service ports, use `passcontrol setup --no-open
> --port-offset 100`. This offsets those local service ports together; the dashboard keeps its
> configured gateway port (3000 by default).
>
> The seeded dev user is **local-only** (created by `scripts/seed.mjs`) — never deploy it.
> To reset to a truly clean slate: `passcontrol reset --local --confirm RESET`.
>
> **From a source clone** without the global install, every `passcontrol <cmd>` below is
> `npm run cli -- <cmd>`; after `npm link` in the checkout, the short form works there too.

You should land on the **Control Tower** dashboard — empty fleet, no spend yet.

---

## 3. Your first governed call (self-host path)

> Came through `passcontrol login` in §2? **This section is already done for you** — your agent,
> passport and config exist, and you have watched one governed call succeed. Add a provider key
> in the Control Tower when you want to call a real model, then go to §4.

**a. Add a provider key.** In the Control Tower, open **Provider Keys** → add an
**Anthropic** key (`sk-ant-…`). Use a **non-critical** key. It goes straight into the local
Vault, encrypted — the gateway handles the plaintext secret during injection and forwarding.
*(Supported providers: OpenAI, Anthropic, Groq, Mistral, Together, DeepSeek, Gemini.)*

**b. Issue a passport.** Click **Issue passport** (or create an agent). The keypair is
generated **in your browser**; you'll see the private key **once**. Copy both:
- `PASSPORT_ID` (public key)
- `PASSPORT_SECRET` (private key)

New Passports default to a 365-day expiry. A null expiry is supported.

Give it a **scope** of `anthropic` / `claude-*` so it can call any Claude model.

**c. Configure the CLI and make the call.** The `passcontrol` CLI is the terminal cockpit for
an agent and its fleet: it removes the env-var soup, can call a model, run a sidecar, inspect
spend/logs, and operate the kill switch. Configure your passport once, then just call:

```bash
passcontrol init                      # prompts for gateway + passport, writes .passcontrol
passcontrol doctor --deep             # verifies gateway/config; mints a visa if configured
passcontrol call "Say hi in 3 words"
```

> Runnable raw example scripts also live in [`examples/`](./examples). (From a source clone
> without the global install, use `npm run cli -- <cmd>` in place of `passcontrol <cmd>`.)

Prefer env vars? They still work and override `.passcontrol`:

```bash
PASSPORT_ID=<pub> PASSPORT_SECRET=<priv> passcontrol call "Say hi in 3 words"
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
passcontrol status                 # cockpit: config, gateway, next commands
passcontrol doctor --fix           # recover a stopped local dashboard
passcontrol start                  # dashboard + Supabase + Redis (--dashboard-only for just the app)
passcontrol restart                # replace the CLI-managed dashboard process
passcontrol local-logs --follow    # stream local dashboard output
passcontrol mcp                    # local stdio MCP server (chat + list_models)
passcontrol sidecar                # local bridge for Hermes/OpenHands/Aider/Cline/etc.
passcontrol agent list             # managed passports
passcontrol spend                  # fleet and per-agent spend
passcontrol logs --limit 20        # recent gateway calls
passcontrol keygen instance        # signing key for receipts + agent tokens
passcontrol verify receipt <jws> --issuer <origin>  # check a receipt; needs no account
passcontrol kill on                # emergency tenant stop
passcontrol kill off               # release the tenant stop
passcontrol configure aider        # preview an Aider project config
passcontrol configure aider --write # write it only if no .aider.conf.yml exists
passcontrol configure claude-desktop --write # merge secret-free MCP config
```

Run `passcontrol` on an interactive terminal for the searchable command browser, or
`passcontrol --help` for command usage. The CLI reads environment variables,
then `.passcontrol`, then `~/.config/passcontrol/config`; keep passport secrets out of source
control. `passcontrol key status` shows local custody; `passcontrol key migrate` moves a
file key to macOS Keychain, Linux Secret Service, or Windows DPAPI-backed storage. An
OS profile holds a marker rather than requiring the secret in `.passcontrol`. Existing
file fallbacks can be used with a warning. Gateway custody labels are DECLARED evidence,
not proof of storage; the signing process can still read the secret.

---

## 4. Govern it

**Set a budget.** Edit the agent in the dashboard and set a **Token budget** and/or a
**Cost budget (USD)**. Admission reserves an estimate before dispatch and settles after usage. Estimates
are not hard provider output ceilings: actual use can exceed them. Unknown/broken
stream usage keeps at least the estimate; abandoned holds do not expire. Lost established
counters refuse with `503 blocked_budget_state`. See [recovery](./docs/budget-recovery.md).

To watch a budget bite, set a tiny one — e.g. **Token budget = 50** — then run the agent
again:

```
✗ proxy error 402: {"error":"blocked_budget"}
```

The gateway blocked it before spending a cent. Raise the budget back up and it works again.
Cost budgets use whole cents; whether an estimate exceeds a cap depends on the model,
input, output limit, and remaining spend. Do not assume 2,000 tokens always costs 1¢.
Custom endpoints are unpriced: token accounting continues, and the cost-cap estimate is
not a claim about actual dollars. Built-in unknown models use provider fallback pricing.

**Scope is capability, not just a model.** An agent scoped to chat can only reach the chat
and model-listing endpoints — it **cannot** use your key for `/v1/files`, fine-tuning,
batches, embeddings, etc. Try it (via the sidecar in §6) and you'll get
`403 blocked_endpoint`. That's what turns "here's a key" into "here's a key that can only do
one thing."

---

## 5. Prove a call happened — signed receipts

A receipt is an issuer-signed record of a gateway decision. Approvals and refusals can
be signed, but signing and persistence are best-effort. Verification detects changes to
that artifact; it does not independently prove provider execution or billing.

### a. Turn receipts on

They need a signing key. Generate one:

```bash
passcontrol keygen instance
```

```
✓ Generated an Ed25519 instance signing key.
→ This key signs call receipts and agent-to-agent tokens. Store the seed like a password:
  INSTANCE_SIGNING_KEY=<base64url-encoded-32-byte-seed>

→ Its public half publishes at /.well-known/jwks.json as kid <derived-key-id>…
```

Put that in your environment, plus the origin this deployment answers on:

```bash
INSTANCE_SIGNING_KEY=<the seed above>
PASSCONTROL_ISSUER=http://localhost:3000     # your https origin, in a real deployment
```

**Which file?** For the local Docker stack from §2 that's **`.env.docker`** in the checkout
(`~/passcontrol` if `passcontrol setup` cloned it for you) — `scripts/dev-stack.sh` reads that
file back and preserves these values across runs, so they survive a restart. Start the app with
`npm run dev:docker`, which loads it. For a deployed instance, set them wherever that host keeps
environment variables.

> Plain `npm run dev` loads `.env.local` instead, which has no signing key — so the app starts
> fine and publishes an empty key set. That failure looks like broken signing and is really a
> wrong env file.

Restart, then check the public half is actually being published:

```bash
curl -s $PASSCONTROL_ISSUER/.well-known/jwks.json
```

```json
{"keys":[{"kty":"OKP","crv":"Ed25519","x":"kMtk4JHLIW2…","alg":"EdDSA","use":"sig","kid":"uqcSRpjIq2Y9…"}]}
```

> **If you see `{"keys":[]}`, stop here.** The signing key isn't loaded. Receipts will be
> signed by nothing, and every attempt to check one fails with *"the issuer does not publish
> this signing key"* — which looks exactly like a forgery and isn't one.

### b. Get a receipt

Make a call, then look up the log row it wrote and pull its receipt:

```bash
passcontrol call "Say hi in 3 words"

# The call id comes from the logs endpoint; the receipt is fetched one at a time,
# because a receipt is ~700 bytes and would bloat every page of results.
CALL_ID=$(curl -s -H "Authorization: Bearer $PASSCONTROL_API_KEY" \
  "$PASSCONTROL_ISSUER/api/control/v1/logs?limit=1" | jq -r '.data[0].id')

curl -s -H "Authorization: Bearer $PASSCONTROL_API_KEY" \
  "$PASSCONTROL_ISSUER/api/control/v1/receipts/$CALL_ID" | jq -r '.data.receipt'
```

You get one long line with two dots in it. That whole string **is** the receipt — there is
nothing else to send with it.

*(Fetching a receipt requires your API key: the receipt is meant to be handed to a stranger,
but **you** decide which stranger. If `receipt` comes back `null` with
`reason: "receipts_not_enabled"`, revisit step a.)*

### c. Check it the way an outsider would

This command needs no account, no API key and no passport. It is the one command someone
runs against **your** deployment:

```bash
passcontrol verify receipt "<paste the receipt>" --issuer https://passcontrol.example.com
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

Now change one character anywhere in the receipt — a digit in the cost, a letter in the
model — and run it again:

```
✗ Not valid: signature does not verify against the issuer's published key
```

That is the whole point. Editing signed bytes invalidates their signature. An issuer holding the signing key
can still issue a different signed statement; signatures do not make the issuer honest.

You must pass `--issuer` yourself. If you omit it:

```
✗ Set --issuer <https origin> (or PASSCONTROL_ISSUER). A verifier that trusts whatever
  issuer the artifact names is not verifying anything.
```

A receipt names its own issuer, and a forger can write anything there. Saying which issuer
you expect is what makes the check mean something.

### d. For someone who doesn't have a terminal

Your deployment serves a page at **`/verify/receipt`**. Paste a receipt, get an answer — no
install, no account. The checking runs **in the visitor's browser**: the receipt is never
uploaded, and the only network request is to the issuer's own `/.well-known/jwks.json` for
its public keys.

There's a **Copy shareable link** button. It puts the receipt after the `#` in the URL, and
URL fragments are never sent to a server — so you can email the link to an accountant and
the receipt still never touches anyone's server on the way.

### What a receipt does and does not say

This matters more than the mechanics, because the failure mode is someone believing more
than the receipt claims:

| It says | It does not say |
|---|---|
| This deployment signed this record | That the deployment is trustworthy — anyone can run PassControl. Checking a signature tells you it is genuine **for the issuer it names**; whether to trust that issuer is your call |
| Nothing in it has changed since signing | What the provider actually replied — a receipt covers the **request** and the **gateway's decision**, never the response body |
| This call was allowed / refused, and why | That a call without a receipt didn't happen. Receipt writing is best-effort by design, so **absence proves nothing** — a receipt is evidence, not a complete ledger |

A refused call is signed exactly like an approved one. "The gateway blocked this agent from
touching that model, here's the proof" is often the more useful document of the two.

### Rotating the signing key — read this first

Receipts **never expire**. They are checked by matching the key id in the receipt against the
keys your deployment publishes right now. So regenerating your signing key doesn't just
affect new receipts — **live-JWKS verification can no longer find the old key.** The signatures themselves
remain valid against a retained trusted public key.

The safe rotation is two steps, and the first one is the one people skip:

```bash
# 1. Record the key you are retiring, permanently. This prints a `<kid>:<public>` pair.
passcontrol keygen instance --retire <your current seed>
INSTANCE_SIGNING_KEY_HISTORY=<whatever is already there>,<the pair it printed>

# 2. Now rotate. _PREV covers the changeover window.
INSTANCE_SIGNING_KEY_PREV=<your current seed>
INSTANCE_SIGNING_KEY=<the new seed>
```

> Note this is **backwards from `VISA_SECRET_PREV`**, and getting them confused is the
> expensive mistake. Nothing is ever *signed* with `INSTANCE_SIGNING_KEY_PREV` — it is there
> purely so its **public** half stays in the JWKS and old receipts keep verifying. Publish
> both, wait one JWKS `max-age` window (5 minutes) so caches catch up.

**Why step 1 exists.** `_PREV` holds exactly one key. Rotate a second time and it is needed
for the key you are retiring *then* — so the first key silently drops out of your published
key set, and every receipt signed under it stops verifying for everyone holding one. There
is no way to undo that for a receipt already in someone else's hands. `INSTANCE_SIGNING_KEY_HISTORY`
is append-only: entries go in and stay in.

It takes **public** halves, which is why you generate the pair with the command rather than
pasting the seed. A seed and a public key are both 32 base64url bytes and look identical in
a `.env` file — but a retired seed left in configuration can still sign, and a public key
cannot. PassControl recomputes the `kid` from each key and ignores any pair that disagrees,
so a pasted seed is dropped rather than published as a key nothing ever signed with.

---

## 6. Use it with a real agent (Hermes, OpenHands, Aider, Cline, …)

Most agents want a **static API key**, but a visa expires in minutes — and a static-key agent
cannot sign a challenge, so it cannot mint one. The **passport connector** bridges that: it holds
your passport, mints and refreshes the visa in the background, and injects it — so the agent
points at a normal-looking endpoint and never holds a real key *or* a long-lived token.

```bash
# Reuses PASSCONTROL_GATEWAY + PASSPORT_ID/PASSPORT_SECRET from .passcontrol.
passcontrol sidecar        # -> http://127.0.0.1:8788
```

> **Never put `PASSPORT_SECRET` in the agent's API-key field.** A passport is a signing key, not
> a bearer token: the gateway refuses it with `401`, and the private key is now sitting in a
> third-party config file. The connector exists precisely so the agent never sees it. If it has
> already happened, rotate the passport.

### This works against PassControl Cloud too

The connector is **not** self-hosting — it reads whatever gateway you configured and forwards
there. Point it at Cloud and you get passport identity in a static-key agent with no stack to
run: that is the `passcontrol login` path in §2, then `passcontrol sidecar` here. No Docker, no
Supabase — the published CLI ships the CLI only.

On Cloud your agent can also skip the connector entirely and use a **Direct Agent Key**: lower
assurance, but no local process at all.

Then point your agent at the sidecar exactly like a provider, API key = anything:

- **Base URL:** `http://127.0.0.1:8788/api/v1/anthropic` (or `/api/v1/openai`)
- **API key:** `sidecar` (ignored — the sidecar replaces it)
- **Model:** one that your passport's scope allows

For **OpenHands** (LiteLLM under the hood): set the custom model to `anthropic/claude-…`,
base URL to the sidecar, key to anything. Run a task and watch the Audit Log fill with
governed calls — the agent is doing real work, and the key stayed in the vault the whole time.
To print a copy/paste starting point:

```bash
passcontrol env openhands
```

Other common presets:

```bash
passcontrol env aider
passcontrol env cline
passcontrol env continue
passcontrol env litellm
```

The same bridge works for desktop chat apps — Chatbox, Jan, Msty, Cherry Studio, Open WebUI
and LibreChat. That is the case worth doing even if you never run an agent: those apps keep a
raw provider key in local storage, and pointing one at the sidecar means it holds a
five-minute visa instead and never sees the key.

```bash
passcontrol env chatbox        # prints Base URL / API key / Model for its settings form
passcontrol env jan
passcontrol env msty
passcontrol env cherry-studio
passcontrol env open-webui
passcontrol env librechat
```

Anything else that takes a custom base URL works through `passcontrol env generic`.
`passcontrol env` with an unknown name prints the full, current list of presets.

Compatibility: OpenAI Chat Completions and POST `/responses` are supported, including
streaming. Other providers support their documented chat/messages paths. Gemini uses
the OpenAI-compatible API, not `generateContent`. Embeddings/files/fine-tuning remain
blocked. `useResponsesApi: false` in your own Continue config is now just a compatibility
choice, not a requirement — the CLI preset does not set it, and it never meant OpenAI
Responses was unsupported.

Quick sanity check that scoping works — a blocked endpoint returns `403 blocked_endpoint`:

```bash
curl -s -X POST http://127.0.0.1:8788/api/v1/anthropic/v1/files \
  -H 'content-type: application/json' -d '{"model":"claude-haiku-4-5"}'
# → {"error":"blocked_endpoint"}
```

---

## 7. Connect an MCP client

Claude Desktop, Cursor, and Claude Code can call PassControl's governed `chat` and
`list_models` tools over local stdio. Put the passport in the global owner-only profile so
the client config itself stays secret-free:

```bash
passcontrol init --global
passcontrol configure claude-desktop --write   # use `cursor` for Cursor
# `passcontrol configure claude-code` prints the Claude-managed add command
```

Restart the client after writing its config. The generated entry contains only absolute
Node/CLI paths; every `chat` call still crosses the gateway's scope, budget, endpoint, and
kill-switch checks. Run without `--write` for a preview.

---

## 8. Revoke a running agent (the kill switch)

With an agent making repeated requests:

1. In the dashboard, **arm the kill switch** (the master kill), or suspend just that agent.
2. Its very next call returns **`403 blocked_suspended`** when stop state is readable, checked before provider dispatch.
3. **Disarm**, and it runs again.

No key rotation, no redeploy, no re-issuing the passport. One toggle severs a live agent and
another restores it. (Note: blocking already-issued visas relies on Redis; see §9. A call
*already in flight* when you flip the switch completes — new calls are blocked immediately.)

---

## 9. Going to production

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
  (`openssl rand -base64 32`). Visa mint/verification refuses an unusable `VISA_SECRET`; app startup alone is not a secret validation test.
- **Redis with eviction disabled** (`maxmemory-policy noeviction`) — instant revocation
  relies on suspend/kill keys not being evicted under memory pressure.
- **Behind a trusted proxy** — per-IP rate limits trust `X-Forwarded-For`; only real behind
  Vercel or a proxy that sets it.
- **Reconcile cron** — schedule `GET /api/cron/reconcile` (Bearer `$CRON_SECRET`) every few
  minutes to correct budget drift. On Vercel it's wired via `vercel.json`; elsewhere use
  system `cron` or a GitHub Action.
- **Never deploy the seeded dev user** — configure production Auth/SMTP and `PASSCONTROL_SIGNUP_MODE` (`open`, `invite`, `closed`); invite mode uses `INVITE_CODE`.
- **Kill switch fail mode** — reads fail *open* by default; set `KILL_SWITCH_FAIL_CLOSED=true`
  to make a Redis read failure block instead.

---

## Where to go next

- **Manage the fleet in code** — the control-plane SDK + a `pc_` API key: see
  [`sdk/README.md`](./sdk/README.md) and [`DOCUMENTATION.md`](./DOCUMENTATION.md).
- **More example agents** — [`examples/`](./examples) (chat agent, tool-using starter agent,
  fleet-admin CLI, the visa sidecar).
- **Receipt claim reference** — every claim name and what it means, plus the JWKS endpoint and
  agent-to-agent tokens: [`DOCUMENTATION.md`](./DOCUMENTATION.md).
- **Security model + responsible disclosure** — [`SECURITY.md`](./SECURITY.md).

Found a rough edge or a security issue? See `SECURITY.md` — we'd rather you tell us.


## Features to configure deliberately

**Sender proof:** enable `observe` first to inspect compatibility, then `required` when
using the sidecar or another proof-capable implementation. The direct CLI call,
MCP chat, and TypeScript SDK do not attach proofs and are refused in required mode.
Observed proof is not enforced proof. Proof binds method, origin/path, visa hash, time
and a nonce, not body/query or hardware custody. Off mode uses the visa as a bearer.

**Lifecycle:** rotation accepts a zero-to-seven-day grace period. Expiry and grace are
mint boundaries; existing visas may continue until their own expiry unless stop controls
block them. `/.well-known/passport-revocations` publishes signed revocation/rotation
information, excluding expiry/suspend/kill. Offline copies need a freshness policy;
receipt signature validity is not current Passport lifecycle validity.

**Custom endpoints:** set a credential's base URL only on an operator-enabled deployment.
`PROVIDER_ENDPOINT_MODE=selfhost` permits private HTTP services and custom ports;
a hostname list restricts HTTPS/443 destinations. Validation is not DNS-aware SSRF
prevention. Upstream redirects are refused. See [endpoint policy](./DOCUMENTATION.md#custom-endpoints-and-egress).

**Owner binding:** a workspace can declare an owner, prove a domain token or GitHub
repository token, and choose publication. These check control of identifiers, not legal
identity. Company registry evidence does not establish representative authority.

**Spend statements:** `passcontrol statements` reads Cloud's signed chain;
`passcontrol verify statement "<jws>" --issuer <origin>` verifies an artifact. Public
self-hosting includes verification, not issuance/proof-serving infrastructure. A Merkle
proof checks inclusion in an issuer-committed set, not independently audited totals or
complete provider billing. Read [the statement format](./docs/statement-format.md).
