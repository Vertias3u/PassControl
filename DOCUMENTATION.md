# PassControl — API Documentation (website blueprint)

> Source-of-truth draft for the public docs site. Audience: developers integrating
> PassControl. This document describes the shipped self-hostable API surface; run the
> local quickstart/tests in the repo to verify your deployment.

---

## What PassControl is

PassControl is an identity + credential gateway for AI agents. Instead of putting your
OpenAI, Anthropic, Groq, Mistral, Together, or DeepSeek API key inside an agent, the agent
holds an **Ed25519 passport** (a private key that never leaves it), signs a challenge to
mint a short-lived **work-visa**, and calls the model **through PassControl** — which
injects your real provider key from an encrypted vault and proxies the request. You get:
no raw provider keys in agent runtimes, instant
revocation, per-agent budgets, and a per-passport audit trail.

There are three surfaces:

| Surface | For | Auth |
|---|---|---|
| **Data plane** — proxy your model calls | agents (runtime) | work-visa |
| **Agent auth** — mint a visa | agents | Ed25519 signature |
| **Control plane** — manage your fleet | developers / backends | API key |
| **Verification** — check a receipt or token someone handed you | anyone, incl. people with no account | none |

Base URL (self-host or hosted): `https://<your-gateway>`  ·  all paths below are relative to it.

---

## Authentication

### Developer API keys (control plane)

Create keys in the **Control Tower → API keys**. A key is shown **once**;
we store only its hash. Send it as a bearer token:

```
Authorization: Bearer pc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

- **Scopes:** `read` (GET only) or `write` (full). Pick the least privilege per integration.
- Keys are prefixed `pc_` (so secret scanners catch leaks), revocable instantly, and
  multiple per account.
- **Never** put a key in a URL or commit it. Server-to-server only — don't ship it to a browser.

### Work-visas (data plane)

Agents authenticate to the proxy with a short-lived (5 min) JWT "visa", minted from a signed
challenge (below). Send it the way your provider SDK already sends a key — PassControl accepts
both `Authorization: Bearer <visa>` (OpenAI-style) and `x-api-key: <visa>` (Anthropic-style).

---

## Agent auth flow — mint a visa

`POST /api/auth/challenge`

The agent signs a canonical payload with its passport private key:

```jsonc
// body
{
  "payload": "base64url(JSON{ passport_id, ts, nonce })",
  "signature": "base64url(ed25519_sign(payloadBytes))"
}
```

```jsonc
// 200
{ "visa": "<jwt>", "token_type": "Bearer", "expires_in": 300, "jti": "…" }
```

Replay-protected (single-use nonce, ±90s clock window). Rate-limited per IP. Errors:
`401 stale_timestamp | replay_detected | unknown_passport | bad_signature`, `403 agent_not_active`,
`429 rate_limited`.

**You don't normally call this by hand — use the SDK**, which mints, caches, and refreshes
visas for you.

---

## Data plane — proxy a model call

`POST /api/v1/:provider/*path`  ·  `provider` ∈
`openai | anthropic | groq | mistral | together | deepseek`

It's drop-in for allowlisted chat and model-listing endpoints only: point your existing SDK's
`baseURL` at `…/api/v1/<provider>` and pass the visa as the API key. PassControl accepts the
path shape real SDKs send, then forwards to the provider's canonical upstream path:

| Provider | Accepted client paths | Canonical upstream path |
|---|---|---|
| `openai` | `POST /chat/completions` or `/v1/chat/completions`; `GET /models` or `/v1/models`; `GET /models/{id}` or `/v1/models/{id}` | `/v1/chat/completions`; `/v1/models`; `/v1/models/{id}` |
| `groq` | `POST /chat/completions` or `/v1/chat/completions`; `GET /models` or `/v1/models`; `GET /models/{id}` or `/v1/models/{id}` | `/v1/chat/completions`; `/v1/models`; `/v1/models/{id}` |
| `mistral` | `POST /chat/completions` or `/v1/chat/completions`; `GET /models` or `/v1/models`; `GET /models/{id}` or `/v1/models/{id}` | `/v1/chat/completions`; `/v1/models`; `/v1/models/{id}` |
| `together` | `POST /chat/completions` or `/v1/chat/completions`; `GET /models` or `/v1/models`; `GET /models/{id}` or `/v1/models/{id}` | `/v1/chat/completions`; `/v1/models`; `/v1/models/{id}` |
| `anthropic` | `POST /v1/messages`; `GET /v1/models`; `GET /v1/models/{id}` | `/v1/messages`; `/v1/models`; `/v1/models/{id}` |
| `deepseek` | `POST /chat/completions` | `/chat/completions` |

`GET .../models` is **narrowed to the visa's scope**: PassControl forwards to the provider,
then removes the entries this agent may not call. The rows that survive are the provider's own,
byte for byte — nothing is added and no field is synthesised — and an unrecognised response shape
passes through untouched. Without it the listing answers with everything the *provider key* can
reach, which is the tenant's whole account rather than the agent's capability, so an SDK's model
picker offers choices guaranteed to be refused on first use. This is presentation of a boundary
the gate already enforces, not the enforcement itself.

`GET .../models/{id}` retrieves one model's metadata. It is read-only, returns strictly less
than the listing beside it, and — like the listing — carries no model to run inference on, so
it is exempt from the per-model scope check and gated by this allowlist alone. It is **not**
narrowed: discovery is scoped, an explicit lookup is not — the caller already knows the name, and
it still cannot *call* an out-of-scope model. Exactly one
extra segment is accepted, and it is URL-encoded into the upstream path, so it can only ever
be a model id and never a route into anything else. Agent SDKs call it to detect a model's
context length; without it that probe is refused around every prompt.

Endpoints outside that allowlist are denied by default. The gateway does **not** proxy
embeddings, files, fine-tuning, batches, responses, or token-counting endpoints. PassControl
verifies the visa → checks kill switch → checks scope → checks endpoint allowlist → reserves
budget → injects your real provider key → streams the response back, and logs the call. The
provider key is never exposed.

Errors: `401 missing_visa | invalid_visa`, `402 blocked_budget`, `403 blocked_suspended |
blocked_scope | blocked_endpoint`, `404 unknown_provider`, `413 payload_too_large`,
`429 rate_limited`, `502 upstream_unreachable`.

Every revocation answers `403 blocked_suspended` regardless of cause, so a caller cannot
probe which control stopped it. Your **audit log** does distinguish them:
`blocked_killed` for the kill switch (platform, tenant, or denylist) and `blocked_suspended`
for a per-agent suspend. Check `passcontrol logs` or the Control Tower when you need to know
which one fired.

---

## SDK quickstart

The client SDK hides visa minting/refresh so integration is re-pointing your SDK, not rewriting
your agent. Today the SDK is vendored in this repo under `./sdk`; it is not a separately
published npm package yet.

```ts
import OpenAI from "openai";
import { PassControl } from "./sdk";

const pc = new PassControl({
  gateway: process.env.PASSCONTROL_GATEWAY!,
  passportId: process.env.PASSPORT_ID!,        // base64url Ed25519 public key
  passportSecret: process.env.PASSPORT_SECRET!,// base64url Ed25519 private key (stays local)
});

const openai = new OpenAI(pc.clientOptions("openai")); // baseURL + fetch wired
await openai.chat.completions.create({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] });
```

Anthropic is identical with `pc.clientOptions("anthropic")`. The SDK caches the visa, refreshes
before expiry, single-flights concurrent mints, and retries once on a 401.

For third-party agents that expect a static key, run the visa sidecar and point the agent at
`http://127.0.0.1:8788/api/v1/<provider>` with any API key value. CLI presets print the
right variables/settings:

```bash
passcontrol env openhands
passcontrol env aider
passcontrol env cline
passcontrol env continue
passcontrol env litellm
passcontrol env hermes
```

Hermes uses its current `custom` model provider. The printed YAML points at the
local sidecar and uses `api_key: passcontrol` as a placeholder; the real provider
key never enters Hermes.

Desktop chat apps work the same way, and are the case where the sidecar earns its keep:
each of these normally stores a raw provider key in local app storage.

```bash
passcontrol env chatbox
passcontrol env jan
passcontrol env msty
passcontrol env cherry-studio
passcontrol env open-webui
passcontrol env librechat
```

These print three fields to type into the app's settings form. The API-key field is required
by the UI and ignored by the sidecar — that field is exactly where your real key used to go.

### `configure` vs `env`

Both accept the same integrations — the coding agents and desktop apps above, the catch-all
`generic`, plus the MCP clients `claude-desktop`, `cursor` and `claude-code` — and differ
only in what they do
with the result. Run `passcontrol env` with an unknown name to print the authoritative list;
it is generated from the CLI's own preset table, so it cannot drift from what is accepted:

- **`passcontrol configure <integration>`** is the one to reach for. It previews the config,
  and `--write` creates it for the three integrations that own a config file
  (`aider`, `claude-desktop`, `cursor`). For the others `--write` is refused with the reason,
  rather than accepted and silently ignored.
- **`passcontrol env <integration>`** only ever prints. It never writes and takes no
  `--write`.

For the MCP targets the two print different things: `configure` shows the client config file
it would merge into, `env` prints just the `mcpServers` JSON.

Continue-specific note: its OpenAI provider may default to `/responses` for o-series and
gpt-5 models. PassControl intentionally does not proxy `/responses`; set
`useResponsesApi: false` so Continue uses `/chat/completions`.

---

## MCP integration

The CLI exposes a local stdio MCP server with governed `chat` and `list_models` tools. Keep
the passport in the global PassControl profile; generated client configs contain only the
absolute Node executable and CLI path:

```bash
passcontrol init --global
passcontrol configure claude-desktop --write   # or: cursor
# Claude Code: passcontrol configure claude-code prints the CLI-managed add command
```

Restart the client after configuration. Every `chat` invocation uses the normal challenge
and proxy flow, so scope, budget, endpoint allowlisting, suspension, and kill switches still
apply. Use `passcontrol env claude-desktop` or `passcontrol env cursor` to print the
secret-free `mcpServers` JSON without writing it.

---

## Control plane — manage your fleet

Base: `/api/control/v1` · `Authorization: Bearer pc_…` · JSON · responses carry `X-Request-Id`.

API-key creation/revocation is available in the Control Tower. The control-plane API
includes tenant-scoped agent lifecycle, logs, audit, spend, and kill-switch endpoints, with
`Idempotency-Key` support on writes.

### Conventions
- **Versioning:** URI (`/v1`); breaking changes → `/v2`.
- **Pagination:** list endpoints clamp `?limit=` to 1–100 (default 50). There is no cursor
  parameter today.
- **Idempotency:** send `Idempotency-Key` on writes; retries won't double-apply.
- **Errors:** `{ "error": { "code", "message", "request_id" } }` + HTTP status.
- **Rate limits:** per key (read 600/min, write 120/min) → `429` + `Retry-After`.
- **Scopes:** GET needs `read`; everything else needs `write`.

### Agents
| Method | Path | Scope | Description |
|---|---|---|---|
| GET | `/agents` | read | List agents (filter `?status=`). |
| POST | `/agents` | write | Create. Body: `name`, `passportPubkey`, `scopes`, `budget_tokens?`, `budget_cents?`. **You generate the Ed25519 keypair and send only the public key.** |
| GET | `/agents/{id}` | read | Fetch one. |
| PATCH | `/agents/{id}` | write | Update name / scopes / budgets. |
| POST | `/agents/{id}/suspend` · `/resume` | write | Per-agent kill toggle. |
| DELETE | `/agents/{id}` | write | Revoke (history preserved). |

### Provider credentials
Provider keys are dashboard-only today. Add and rotate them in the Control Tower; raw
provider secrets are never returned by the API and are never accepted by the control plane.

### Kill switch
| Method | Path | Scope | Description |
|---|---|---|---|
| GET | `/kill-switch` | read | Current per-tenant state. |
| PUT | `/kill-switch` | write | Arm/disarm the master kill for your tenant. |

### Observability
| Method | Path | Scope | Description |
|---|---|---|---|
| GET | `/logs` | read | Gateway calls; filter by `agent_id`, `status`, and `limit`. Returns each call's `id`. |
| GET | `/audit` | read | Admin-action trail. |
| GET | `/spend` | read | Per-agent + fleet totals (micro-cents; $ = µ¢ / 100,000,000). |
| GET | `/receipts/{id}` | read | One call **plus its signed receipt**. See [Receipts](#receipts--portable-proof-a-call-happened). |

`/receipts/{id}` takes a call `id` from `/logs`. Receipts are fetched one at a time rather
than folded into `/logs`, because a receipt is ~700 bytes of JWS and would bloat every page
of results for the one caller in a hundred who wants a proof.

```json
{ "data": { "id": "…", "provider": "anthropic", "status": "ok", "cost_microcents": 61,
            "receipt": "eyJhbGciOiJFZERTQSIs…" } }
```

If `receipt` is `null`, the response carries `"reason": "receipts_not_enabled"` — the
deployment has no `INSTANCE_SIGNING_KEY`. That's a configuration answer, not missing data.

A 404 is returned for another tenant's call id rather than a 403, so the endpoint can't be
used to discover which ids exist.

### Ownership
Declares **who a tenant's passports belong to**, so a receipt can carry *"this agent is
operated by X"*.

**The binding is per tenant, not per agent.** There is no agent id in these paths: one owner
applies to every passport under your account. `own` on a receipt therefore identifies the
operator of the deployment, not one particular bot.

| Method | Path | Scope | Description |
|---|---|---|---|
| GET | `/owner` | read | The current binding, its tier, and whether it is published. |
| PUT | `/owner` | write | Declare a claim. Body: `kind` (`self_attested` \| `domain`), `subject`, `published?`. **Always lands at tier `unverified`**, even for `kind: "domain"` — claiming a domain and proving control of it are different events. |
| PATCH | `/owner` | write | Publish or unpublish an existing binding. Body: `published` (boolean). |
| POST | `/owner/verify` | write | Run the domain check now. On success stamps tier `domain`. |

For `kind: "domain"`, `PUT` returns the instructions inline — where to publish the token and
what to call next — rather than making you find them in docs.

**A caller never sets `tier` or `verified_at`.** You say what you claim; the server records
what it has actually proven. `kind` is the method attempted, `tier` is the result, and they
are stored separately on purpose.

| Tier | Means |
|---|---|
| `unverified` | Self-declared. Someone typed it. **Proves nothing** — render it as a claim, never as a fact. |
| `domain` | Proven by publishing a token at a domain the claimant controls. |
| `idv` | Proven by an identity check. |

Only **published** bindings appear on the public verification pages or in a receipt's `own`
claim.

Anything that renders an owner must key its wording off `tier`, not `kind` — otherwise a
self-attested claim renders as a verified one, which defeats the entire mechanism.

---

## Receipts — portable proof a call happened

Your logs convince you. They don't convince a counterparty, because you control your own
database. A **receipt** is a record of one call that a third party can check without an
account, without your database, and without your cooperation.

It's a compact JWS (`typ: passcontrol-receipt+jwt`) signed with your deployment's Ed25519
key. Governed calls are receipted — **refusals as well as approvals.** "The gateway stopped
this agent from touching that model, here is the proof" is often the more useful document.

### Enabling them

| Variable | Purpose |
|---|---|
| `INSTANCE_SIGNING_KEY` | 32-byte base64url seed. Signs receipts and agent tokens. `passcontrol keygen instance` generates one. |
| `INSTANCE_SIGNING_KEY_PREV` | **Never signs anything.** Its public half stays published so receipts signed before a rotation still verify. |
| `PASSCONTROL_ISSUER` | This deployment's https origin. Becomes the `iss` claim and the address others fetch your keys from. |

Without both `INSTANCE_SIGNING_KEY` and `PASSCONTROL_ISSUER`, no receipt is signed — an
unverifiable `iss` is worse than no receipt, because it looks authoritative and resolves to
no key set.

### `GET /.well-known/jwks.json`

Public, unauthenticated, no rate limit. The public halves of your signing keys — this is what
anyone verifying a receipt fetches.

```json
{"keys":[{"kty":"OKP","crv":"Ed25519","x":"kMtk4JHLIW2GLbTw2GPORDQyOE5UspTaUSQK9fUhq7U",
          "alg":"EdDSA","use":"sig","kid":"uqcSRpjIq2Y9UdUic3BebzbubwDfZoezMpkUlCwWSfA"}]}
```

Served with `Cache-Control: public, max-age=300, stale-while-revalidate=86400`
(`max-age` is configurable via `JWKS_MAX_AGE_SECONDS`). CORS is open and the global
`Cross-Origin-Resource-Policy` is relaxed here — this is the one document other deployments
exist to read.

`{"keys":[]}` means no signing key is configured. Every verification against that deployment
will then fail with `unknown_key`, which reads like a forgery and is not one.

### Claims

Names are abbreviated deliberately — a receipt travels in URLs and QR codes.

| Claim | Type | Meaning |
|---|---|---|
| `iss` | string | Issuing deployment's origin. Its JWKS is at `{iss}/.well-known/jwks.json`. |
| `sub` | string | Agent passport id (its public key). |
| `jti` | uuid | Receipt id — the same id as the call's log row. |
| `iat` | int | Signed at (Unix seconds). |
| `agid` | uuid | Agent id. |
| `vjti` | uuid | The work-visa the call was made with. |
| `prov` | string | Provider (`anthropic`, `openai`, …). |
| `mdl` | string \| null | Model, when one was named. |
| `mth` | string | HTTP method. |
| `path` | string | Upstream path called. |
| `use` | `{in,out}` | Input / output tokens. |
| `cost` | int | **Micro-cents.** $ = `cost` / 100,000,000. `61` is $0.00000061, not $61. |
| `res` | `{status,http}` | The gateway's verdict and the HTTP status. |
| `t0` | int | Call start (Unix **milliseconds**). |
| `lat` | int | **Total** elapsed ms for the whole request, measured at the gateway — pre-checks, the provider call, and post-response bookkeeping. **Not** the gateway's own overhead: on an approved call the provider dominates it. On a refusal nothing goes upstream, so it really is gateway time. |
| `ver` | int | Receipt schema version. |
| `req` | `{alg,dig,len}` | SHA-256 over the exact request bytes, and their length. **Omitted** when the gateway refused before reading the body — absent means "never read", whereas a digest of `""` would mean "the client sent nothing". |
| `own` | `{kind,sub,tier,vat}` | Who operates this deployment, if a binding is published. **Per tenant, not per agent.** Read `tier`, not `kind`. Omitted when none is bound. |

Versioning is additive: a verifier refuses a receipt **newer** than it understands, but
ignores unknown claims within a supported version. That's what lets you add a field without
invalidating verifiers already in the field.

### Verifying one

Three ways, all running the same checks in the same order:

```bash
# 1. CLI — needs no config, no passport, no API key.
passcontrol verify receipt "<jws>" --issuer https://passcontrol.example.com
```

```js
// 2. SDK — the same function the CLI and the web page call.
//    Copied from the repo's sdk/ directory; it has no dependencies beyond
//    @noble/curves and runs in Node, Deno, Bun, workers and the browser.
import { verifyReceipt } from "./sdk/verify";
const result = await verifyReceipt(jws, { trustedIssuers: ["https://passcontrol.example.com"] });
// { ok: true, claims } | { ok: false, reason }
```

3. **The web page** at `/verify/receipt` on your own deployment — paste-and-check, no install.
   Verification runs **in the visitor's browser**; the receipt is never uploaded. "Copy
   shareable link" puts the receipt in the URL fragment, which browsers never send to a
   server.

`trustedIssuers` (or `--issuer`) is required and has no default. A verifier that accepts
whatever issuer the artifact names is not verifying anything — the `iss` claim is attacker-
controlled until a signature says otherwise.

**What a successful verification means:** the named issuer signed this record and nothing in
it has changed since. It does **not** mean the issuer is trustworthy — anyone can run
PassControl — and it does **not** describe the provider's reply, only the request and the
gateway's decision about it. The absence of a receipt proves nothing: receipt writing is
best-effort by design.

Failure reasons are the `VerifyFailure` union exported by `sdk/verify.ts`; the CLI maps them
to sentences in `FAILURE_REASONS` (`cli/verify.mjs`). Two worth knowing:

- `unknown_key` — the key id isn't in the issuer's JWKS. Before reporting this the verifier
  refetches once bypassing the HTTP cache, because a cached key list can be up to a day old
  and would otherwise make a genuine post-rotation receipt look forged.
- `jwks_unreachable` — the key set couldn't be fetched. **Not** a statement that the receipt
  is bad; it means the check never completed.

### Rotating the signing key

Receipts have **no expiry**. They're checked against the keys you publish *now*, so replacing
your signing key retroactively invalidates every receipt you have ever signed.

```bash
INSTANCE_SIGNING_KEY_PREV=<the old seed>   # move it here first
INSTANCE_SIGNING_KEY=<the new seed>
```

This is **inverted relative to `VISA_SECRET_PREV`.** Nothing is ever signed with
`INSTANCE_SIGNING_KEY_PREV`; it exists only so its public half remains in the JWKS. Publish
both, wait one `max-age` window (5 minutes) for caches, then start signing with the new key.
Drop the old one only when receipts predating the rotation no longer matter.

---

## Agent-to-agent tokens

`POST /api/auth/agent-token` mints a short-lived EdDSA token (`typ:
passcontrol-agent+jwt`) that one agent presents to **another service** — as opposed to a
work-visa, which is only ever for the gateway.

The agent signs a payload with its passport private key:

```
{ payload: base64url(JSON{ passport_id, ts, nonce, aud, ttl? }), signature }
```

**`aud` lives inside the signed payload**, not beside it. The agent cryptographically
authorises which audience it is minting for; an `aud` passed as a sibling of the signature
could be swapped in transit.

The receiving service verifies it with the same JWKS as a receipt — but must pin the
audience it expects:

```bash
passcontrol verify token "<jwt>" --audience my-service --issuer https://passcontrol.example.com
```

Unlike receipts, agent tokens **do** carry `exp` and are checked for expiry and audience.

---

## Security notes for integrators

- Treat `pc_` keys and passport private keys like passwords: env vars / secret managers, never
  in source, URLs, or browsers. Rotate on suspicion; revoke instantly from the dashboard.
- Each API key only ever touches **its owner's** data (tenant-isolated server-side). There is
  no cross-tenant access and no way to widen scope without a new key.
- Raw provider secrets are entered only in the Control Tower and live encrypted in the vault —
  they never traverse the public API.
- Gateway call logs are append-only (DB-enforced; direct `UPDATE`, `DELETE`, and `TRUNCATE`
  are rejected). They are not a cryptographic hash chain.

## Limitations

- A work-visa is a bearer token and is reusable until it expires (≤5 minutes). Keep it out of
  logs and prompts; use suspend/kill switches to block future requests.
- The data-plane proxy intentionally covers only chat and model-listing endpoints listed
  above. It does not proxy embeddings, files, fine-tuning, batches, responses, or
  token-counting endpoints.
- Pricing is a best-effort in-code table and can lag provider price changes. Use it for
  budgets and monitoring, not as billing reconciliation against provider invoices.
- Instant revocation assumes Redis is configured for persistence/no-eviction behavior. If
  Redis evicts suspend/kill keys, enforcement falls back to short visa TTLs and durable agent
  status checks at the next mint.
- Receipts are **best-effort**: signing failures never abort a call, so the absence of a receipt
  is not evidence a call did not happen. They are proof of what did occur, not a complete ledger.
- A receipt covers the request and the gateway's decision. It does **not** record the provider's
  response body, so it cannot prove what a model replied.
- Verifying a receipt proves the named issuer signed it. It says nothing about whether that
  issuer is honest — anyone can run PassControl, and deciding whom to trust stays with the reader.
- Owner bindings at tier `unverified` are self-declared and prove nothing. Only `domain` and
  `idv` reflect a completed check.
