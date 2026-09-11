# PassControl — API and behavior reference

This reference describes the current implementation. Start with [README](./README.md)
or the [tutorial](./TUTORIAL.md). The public self-host tree contains the gateway,
dashboard, authentication, control API, and artifact verifiers. Cloud's statement
operation and hosted beta machinery are separate; see the statement section below.

| Surface | Authentication |
|---|---|
| Data plane | Direct Agent Key or Passport-derived work-visa; request proof when required |
| Passport mint | Ed25519 signed challenge; private key stays client-side |
| Control plane | Workspace `pc_…` key with read/write scope |
| Artifact verification | No account; explicitly trusted issuer and public keys |

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

### Direct Agent Keys (data plane)

A `pc_agent_…` key is a named, reveal-once bearer credential for one agent. It has
optional expiry and independent revocation; only its hash is stored. It is checked
against durable credential/agent state on use, without a credential lookup cache.
Unreadable credential state or its pre-auth protection fails closed. It cannot mint a
visa or authenticate to `/api/control/v1`. Dashboard **Connect an agent** emits the
matching provider-native configuration. DAK and Passport may coexist on one agent.

### Work-visas (data plane)

Agents authenticate to the proxy with a short-lived (5 min) JWT "visa", minted from a signed
challenge (below). Send it the way your provider SDK already sends a key — PassControl accepts
both `Authorization: Bearer <visa>` (OpenAI-style) and `x-api-key: <visa>` (Anthropic-style).

---

## Agent auth flow — mint a visa

`POST /api/auth/challenge`

The agent signs the exact serialized payload bytes with its passport private key:

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
`401 stale_timestamp | replay_detected | unknown_passport | bad_signature`, `403 agent_not_active | passport_expired`,
`429 rate_limited`.

**You don't normally call this by hand — use the SDK**, which mints, caches, and refreshes
visas for you.

---

## Data plane — proxy a model call

`POST /api/v1/:provider/*path`  ·  `provider` ∈
`openai | anthropic | groq | mistral | together | deepseek | gemini`

It supports the allowlisted inference and model-listing endpoints below: point your existing SDK's
`baseURL` at `…/api/v1/<provider>` and pass the visa as the API key. PassControl accepts the
path shape real SDKs send, then forwards to the provider's canonical upstream path:

| Provider | Accepted client paths | Canonical upstream path |
|---|---|---|
| `openai` | `POST /responses` or `/v1/responses`; `POST /chat/completions` or `/v1/chat/completions`; `GET /models` or `/v1/models`; `GET /models/{id}` or `/v1/models/{id}` | `/v1/responses`; `/v1/chat/completions`; `/v1/models`; `/v1/models/{id}` |
| `groq` | `POST /chat/completions` or `/v1/chat/completions`; `GET /models` or `/v1/models`; `GET /models/{id}` or `/v1/models/{id}` | `/v1/chat/completions`; `/v1/models`; `/v1/models/{id}` |
| `mistral` | `POST /chat/completions` or `/v1/chat/completions`; `GET /models` or `/v1/models`; `GET /models/{id}` or `/v1/models/{id}` | `/v1/chat/completions`; `/v1/models`; `/v1/models/{id}` |
| `together` | `POST /chat/completions` or `/v1/chat/completions`; `GET /models` or `/v1/models`; `GET /models/{id}` or `/v1/models/{id}` | `/v1/chat/completions`; `/v1/models`; `/v1/models/{id}` |
| `anthropic` | `POST /v1/messages`; `GET /models` or `/v1/models`; `GET /models/{id}` or `/v1/models/{id}` | `/v1/messages`; `/v1/models`; `/v1/models/{id}` |
| `deepseek` | `POST /chat/completions` or `/v1/chat/completions` | `/chat/completions` |
| `gemini` | `POST /chat/completions` or `/v1/chat/completions`; `GET /models` or `/v1/models`; `GET /models/{id}` or `/v1/models/{id}` | `/chat/completions`; `/models`; `/models/{id}`, appended to `https://generativelanguage.googleapis.com/v1beta/openai` |

OpenAI Responses supports buffered and streaming POST requests. It uses `input` and
`max_output_tokens`; terminal completion and valid usage determine whether accounting
is complete. Retrieval/deletion of stored responses is not allowlisted. Gemini uses
Google's OpenAI compatibility API, not native `generateContent`. DeepSeek model listing
is not proxied even though credential setup may probe its upstream model endpoint.

The packaged SDK uses `/api/v1/<provider>` as its base. For a static OpenAI-compatible
client, use the exact URL printed by **Connect an agent** or `passcontrol env`; the
accepted aliases above accommodate clients that append `/v1` and those that do not.


`GET .../models` is **narrowed to the visa's scope**: PassControl forwards to the provider,
then removes the entries this agent may not call. The rows that survive are the provider's own,
with their fields preserved — the filtered JSON is reserialized — and an unrecognised response shape
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

Both discovery paths accept the `v1`-less spelling on **every** provider that serves them,
including `anthropic`, because a client pointed at a base URL that already ends in `/v1` sends
the short one and a client pointed at the host sends the long one — and it cannot know which we
accept. Chat is not treated this way: `anthropic` still takes `POST /v1/messages` alone. Listing
runs no model and spends nothing, so being generous about how a client spells it costs nothing;
being generous about how it spells inference would widen what actually bills.

Endpoints outside that allowlist are denied by default. The gateway does **not** proxy
embeddings, files, fine-tuning, batches, response retrieval/deletion, or token-counting endpoints. PassControl
verifies the visa → checks kill switch → checks scope → checks endpoint allowlist → reserves
budget → injects your real provider key → streams the response back, and attempts to log the call. It does not return the injected provider key.

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
your agent. The compiled ESM SDK ships in the `passcontrol` npm package at `passcontrol/sdk`.
Its TypeScript source is in `sdk/`.

```ts
import OpenAI from "openai";
import { PassControl } from "passcontrol/sdk";

const pc = new PassControl({
  gateway: process.env.PASSCONTROL_GATEWAY!,
  passportId: process.env.PASSPORT_ID!,        // base64url Ed25519 public key
  passportSecret: process.env.PASSPORT_SECRET!,// base64url Ed25519 private key (stays local)
});

const openai = new OpenAI(pc.clientOptions("openai")); // baseURL + fetch wired
await openai.chat.completions.create({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] });
```

Anthropic is identical with `pc.clientOptions("anthropic")`. The SDK caches the visa, refreshes
before expiry, single-flights concurrent mints, and retries once on a 401 when the effective body is replayable. It does not generate sender proofs.

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

These print configuration fields for the client; check the emitted provider-native URL. The placeholder API key is replaced by the sidecar.

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

Continue: OpenAI `/responses` is supported, so the old instruction to set
`useResponsesApi: false` is no longer required. It remains a valid compatibility choice
in your own Continue config — the CLI does not set it for you: `passcontrol env continue`
prints only a base URL, an API key, and a model. Other provider IDs do not acquire
Responses support.

---

## MCP integration

The CLI exposes a local stdio MCP server with governed `chat` and `list_models` tools. Keep
the passport in the global PassControl profile; generated client configs contain only the
absolute Node executable and CLI path:

```bash
passcontrol login                              # or `passcontrol init --global` to do it by hand
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
| POST | `/agents` | write | Create. Body: `name`, `passportPubkey`, `scopes`, `budget_tokens?`, `budget_cents?`, `expiresAt?`. **You generate the Ed25519 keypair and send only the public key.** |
| GET | `/agents/{id}` | read | Fetch one. |
| PATCH | `/agents/{id}` | write | Update name / scopes / budgets. |
| POST | `/agents/{id}/suspend` · `/resume` | write | Per-agent kill toggle. |
| DELETE | `/agents/{id}` | write | Revoke (history preserved). |

### Provider credentials
Provider keys are dashboard-only today — **Settings → Provider credentials** in the Control
Tower. Raw provider secrets are never returned by the API and are never accepted by the
control plane; the panel lists stored credentials by **nickname** only, because the secret
lives in Supabase Vault and has no column to render.

You may store several credentials per provider, and exactly one of them is **in use** — the
one the gateway injects. The four operations, and when each is the right one:

| Action | What it does | Use it when |
|---|---|---|
| **Add a new key** | Stores another credential *alongside* the existing ones. Does **not** replace anything. The first key you store for a provider becomes the one in use; later ones do not. | You want a second account or environment available to switch between. |
| **Replace secret** | Swaps the secret behind an existing nickname, in place. Which credential is in use does not change. | Your key expired or was rotated at the provider and you want the same slot to keep working. This is usually what you want. |
| **Use this key** | Makes that credential the one the gateway injects, for agents using the tenant default, subject to agent-specific routing. | You added a replacement as a new key and now want to cut over to it. |
| **Delete** | Removes the credential row and its Vault secret. Refused for the credential currently in use — switch to another one first, so a delete can never quietly change which upstream account is billed. | You are retiring a credential you have already switched away from. |

Writes attempt to purge the 60-second provider-key cache. A failed purge can leave the
old cached credential usable until its cache expires. Agent-specific key routing can
override the tenant default; changing that default does not override an agent selection.

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
| GET | `/receipts/{id}` | read | One call **plus its signed receipt**. See [Receipts](#receipts--signed-issuer-records). |

`/receipts/{id}` takes a call `id` from `/logs`. Receipts are fetched one at a time rather
than folded into `/logs`, because a receipt is ~700 bytes of JWS and would bloat every page
of results for the one caller in a hundred who wants a proof.

```json
{ "data": { "id": "…", "provider": "anthropic", "status": "ok", "cost_microcents": 61,
            "receipt": "eyJhbGciOiJFZERTQSIs…" } }
```

If `receipt` is `null`, the response carries `"reason": "receipts_not_enabled"` — the
row has no stored receipt. This reason is also emitted for a signing failure; it does
not conclusively diagnose missing configuration. A row can also be absent or not yet visible
because writes are asynchronous and best-effort.

A 404 is returned for another tenant's call id rather than a 403, so the endpoint can't be
used to discover which ids exist.

### Ownership
Declares **who a tenant's passports belong to**, so a receipt can carry *"this agent is
operated by X"*.

**The binding is per tenant, not per agent.** There is no agent id in these paths: one owner
applies to every passport under your account. `own` on a receipt therefore identifies the
owner of that workspace, not necessarily the operator of the gateway deployment.

| Method | Path | Scope | Description |
|---|---|---|---|
| GET | `/owner` | read | The current binding, its tier, and whether it is published. |
| PUT | `/owner` | write | Declare a claim. Body: `kind` (`self_attested` \| `domain` \| `github`), `subject`, `published?`. **Always lands at tier `unverified`**, even for `kind: "domain"` — claiming a domain and proving control of it are different events. |
| PATCH | `/owner` | write | Publish or unpublish an existing binding. Body: `published` (boolean). |
| POST | `/owner/verify` | write | Run the declared domain or GitHub check. On success stamps that tier. |

For `kind: "domain"`, `PUT` returns the instructions inline — where to publish the token and
what to call next — rather than making you find them in docs.

**A caller never sets `tier` or `verified_at`.** You say what you claim; the server records
what it has actually proven. `kind` is the method attempted, `tier` is the result, and they
are stored separately on purpose.

| Tier | Means |
|---|---|
| `unverified` | Self-declared. Someone typed it. **Proves nothing** — render it as a claim, never as a fact. |
| `domain` | Proven by publishing a token at a domain the claimant controls. |
| `github` | A token was published under the named GitHub account. Not legal identity or an endorsement. |
| `idv` | Reserved identity-verification tier; no issuing identity-check adapter ships yet. |

Only **published** bindings appear on the public verification pages or in a receipt's `own`
claim.

Anything that renders an owner must key its wording off `tier`, not `kind` — otherwise a
self-attested claim renders as a verified one, which defeats the entire mechanism.

---

## Receipts — signed issuer records

Your logs convince you. They don't convince a counterparty, because you control your own
database. A **receipt** is a record of one call that a third party can check without an
account, without your database, and without your cooperation.

It's a compact JWS (`typ: passcontrol-receipt+jwt`) signed with your deployment's Ed25519
key. Governed approvals and refusals can receive receipts. Early authentication failures
may have no tenant log; signing and persistence are best-effort. "The gateway stopped
this agent from touching that model, here is the proof" is often the more useful document.

### Enabling them

| Variable | Purpose |
|---|---|
| `INSTANCE_SIGNING_KEY` | 32-byte base64url seed. Signs receipts and agent tokens. `passcontrol keygen instance` generates one. |
| `INSTANCE_SIGNING_KEY_PREV` | **Never signs anything.** Its public half stays published so receipts signed before a rotation still verify. Holds one generation. |
| `INSTANCE_SIGNING_KEY_HISTORY` | Every key retired before that one, as comma-separated `<kid>:<public>` pairs. Public halves only, appended and never removed. |
| `PASSCONTROL_ISSUER` | This deployment's https origin. Becomes the `iss` claim and the address others fetch your keys from. |

Without both `INSTANCE_SIGNING_KEY` and `PASSCONTROL_ISSUER`, no receipt is signed — an
unverifiable `iss` is worse than no receipt, because it looks authoritative and resolves to
no key set.

### `GET /.well-known/jwks.json`

Public and unauthenticated, with no route-specific limiter. The public halves of your signing keys — this is what
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
| `sub` | string | Passport public key, or agent UUID for a DAK receipt. Interpret with `auth`. |
| `jti` | uuid | Receipt id — the same id as the call's log row. |
| `iat` | int | Signed at (Unix seconds). |
| `agid` | uuid | Agent id. |
| `auth` | object | DAK: `{kind:"direct_key",kid,use}`; enforced proof: `{kind:"passport_proof_per_request"}`. Omitted for bearer Passport receipts. |
| `vjti` | uuid | Visa ID on Passport receipts; not a DAK claim. |
| `prov` | string | Provider (`anthropic`, `openai`, …). |
| `mdl` | string \| null | Model, when one was named. |
| `mth` | string | HTTP method. |
| `path` | string | Upstream path called. |
| `use` | `{in,out}` | Input / output tokens. |
| `unp` | boolean | True means unpriced. A numeric zero in `cost` then does not mean free. |
| `cost` | int | **Micro-cents.** $ = `cost` / 100,000,000. `61` is $0.00000061, not $61. |
| `res` | `{status,http}` | The gateway's verdict and the HTTP status. |
| `t0` | int | Call start (Unix **milliseconds**). |
| `lat` | int | **Total** elapsed ms for the whole request, measured at the gateway — pre-checks, the provider call, and post-response bookkeeping. **Not** the gateway's own overhead: on an approved call the provider dominates it. On a refusal nothing goes upstream, so it really is gateway time. |
| `ver` | int | Receipt schema version. |
| `req` | `{alg,dig,len}` | SHA-256 over the exact request bytes, and their length. **Omitted** when the gateway refused before reading the body — absent means "never read", whereas a digest of `""` would mean "the client sent nothing". |
| `own` | `{kind,sub,tier,vat}` | The workspace owner claim, if published. **Per tenant, not per agent.** Read `tier`, not `kind`. Omitted when none is bound. |

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
//    Exported by the packaged SDK; also available as source in sdk/.
import { verifyReceipt } from "passcontrol/sdk";
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

Receipts have **no expiry**. They're checked against the keys you publish *now*, so removing
an old public key from JWKS prevents this live-key verifier from checking its receipts.
The old signatures remain mathematically valid against a retained trusted public key.

```bash
# 1. Record the retiring key permanently. Prints a `<kid>:<public>` pair.
passcontrol keygen instance --retire <the old seed>
INSTANCE_SIGNING_KEY_HISTORY=<existing entries>,<the pair it printed>

# 2. Then rotate.
INSTANCE_SIGNING_KEY_PREV=<the old seed>   # the changeover window
INSTANCE_SIGNING_KEY=<the new seed>
```

This is **inverted relative to `VISA_SECRET_PREV`.** Nothing is ever signed with
`INSTANCE_SIGNING_KEY_PREV`; it exists only so its public half remains in the JWKS. Publish
both, wait one `max-age` window (5 minutes) for caches, then start signing with the new key.

**Step 1 is the one that lasts, and skipping it is a one-way mistake.** `_PREV` is a single
slot: your *next* rotation needs it for the key you are retiring today, and the key you
retired before that has nowhere to go. It disappears from the JWKS, and because receipts
have no expiry, every receipt ever signed under it stops verifying — permanently, for
everyone you ever gave one to. `_HISTORY` is append-only for the same reason. Remove an
entry only when you intend to withdraw trust in that key, which is a decision about those
receipts, not about the key.

History takes **public** halves, never seeds. A retired seed sitting in configuration can
mint new receipts backdated under the old `kid`; a public key cannot sign anything. The app
recomputes each `kid` from its key and ignores any pair that does not match, so a pasted
seed is discarded rather than published as a key nothing ever signed with.

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
- Provider secrets enter through authenticated dashboard operations (and supported encrypted
  workspace import), then live in Vault. They are not returned by the control-plane API.
  The gateway handles plaintext during forwarding; the deployment operator is trusted.
- Gateway call logs are append-only (DB-enforced; direct `UPDATE`, `DELETE`, and `TRUNCATE`
  are rejected). They are not a cryptographic hash chain.

## Limitations

- A visa is reusable until expiry in off/observe mode (default 5 minutes, configurable
  to 15). Required mode additionally enforces a fresh sender proof for every request.
- The data-plane proxy covers the inference and model-listing endpoints listed
  above. It does not proxy embeddings, files, fine-tuning, batches, response retrieval/deletion, or
  token-counting endpoints.
- Pricing is a best-effort in-code table and can lag provider price changes. Use it for
  budgets and monitoring, not as billing reconciliation against provider invoices.
- Instant revocation assumes Redis is configured for persistence/no-eviction behavior. If
  Redis evicts suspend/kill keys, enforcement falls back to short visa TTLs and durable agent
  status checks at the next mint.
- Receipts are **best-effort**: signing failures never abort a call, so the absence of a receipt
  is not evidence a call did not happen. They are signed issuer records, not a complete ledger or independent evidence of provider execution.
- A receipt covers the request and the gateway's decision. It does **not** record the provider's
  response body, so it cannot prove what a model replied.
- Verifying a receipt proves the named issuer signed it. It says nothing about whether that
  issuer is honest — anyone can run PassControl, and deciding whom to trust stays with the reader.
- Owner bindings at tier `unverified` are self-declared and prove nothing. The `domain` and
  `github` tiers describe specific control checks; `idv` issuance is not implemented.


## Passport lifecycle and sender proof

Newly issued/rotated Passports default to 365 days; an explicit null expiry means no
expiry, including legacy rows. Expiry is checked at challenge and agent-token mint.
Dashboard lifecycle controls manage expiry and sender-proof mode.
`POST /api/control/v1/agents/{id}/rotate` takes `{passportPubkey, graceSeconds?, expiresAt?}`
(write scope); default grace is 3600 seconds. Rotation takes a new public key and a grace period from zero through seven days; the
previous key can mint until its grace deadline, subject to agent status and expiry.
A second rotation during an open grace window is refused. Neither expiry nor grace
retroactively expires a visa already minted; it can last another 300–900 seconds.
Stop controls block subsequent admitted calls, not an already-dispatched provider stream.

Sender proof is an agent setting (`off` / `observe` / `required`), enforced on Passport
requests only. DAK authentication is not upgraded by enabling it.

| Mode | Behavior | Logged authentication |
|---|---|---|
| `off` | Does not inspect a supplied proof | `passport` |
| `observe` | Records pass/missing/invalid/clock_skew/replayed where available; does not refuse on proof failure | `passport` |
| `required` | Refuses missing/invalid/stale/replayed proofs; replay-store failure is a 503 | `passport_proof_per_request` only after enforced success |

Unreadable sender-mode state is `503 sender_constraint_state_unavailable`. In observe
mode an unavailable replay store omits the observation rather than blocking or inventing
one. Current v2 visas contain `cnf.jkt`, the Passport public-key thumbprint; this claim
alone is not evidence that the gateway enforced a proof on any particular request.

`x-passcontrol-proof` is `base64url(payloadBytes).base64url(Ed25519 signature)`.
Its JSON fields are `htm` (uppercase method), `htu` (gateway origin + pathname, without
query), `iat` (integer seconds, ±30 seconds), `jti` (fresh nonce), and `vh` (base64url
SHA-256 of the exact visa). Successful verification consumes a replay nonce. It binds
neither body nor query and is not hardware attestation or a complete HTTP signature.

The sidecar generates proofs. The direct CLI call, MCP chat, and TypeScript
`PassControl` SDK paths only supply the visa: use off/observe or a correct proof-capable
transport before requiring proofs. Plain `getVisa()` plus a provider SDK also lacks request proofs.

CLI key custody: `passcontrol key status` reports storage; `passcontrol key migrate`
moves a file key into macOS Keychain, Linux Secret Service (`secret-tool`), or Windows
DPAPI-backed storage. `PASSPORT_KEY_STORAGE=os` marks that profile. Environment secrets
win; an unavailable store can use an existing file fallback with a warning. OS-backed
storage is still read into the signer process, not a non-exportable hardware key.
A signed challenge can declare `key_storage`; attribution to the key holder proves
only that it made the declaration. The gateway's custody evidence is DECLARED, not
verified, and a custody expectation is advisory rather than a storage enforcement gate.

## Public Passport revocation list

`GET /.well-known/passport-revocations` publishes a signed `passcontrol-crl+jws`
list using the instance signer. It includes revocations and recorded retired keys
with `notValidAfter`; it excludes expiry, suspension, and kill switches. Older rotations
without retained audit metadata may be absent. It is rate-limited and unavailable if
it cannot build/sign the list; do not treat a failed fetch as an empty list.

A consumer must verify issuer/key/type and apply its own freshness policy to signed
`iat`. A saved list does not learn future revocations. Absence is not proof that a
Passport is active; use public `/verify/<passportId>` or the corresponding verification
API for current lifecycle status. Receipt signature verification does not automatically
perform this lifecycle check or fetch this list.

## Custom endpoints and egress

Provider credentials can carry `endpoint_base_url`. Agent-specific provider-key routing
can select that credential; an override does not add a provider ID or new API paths.
`PROVIDER_ENDPOINT_MODE` is unset/off by default. `selfhost` accepts HTTP/HTTPS, arbitrary
ports, IP literals and private addresses. A comma-separated list such as
`models.example.com,proxy.example.com` permits exact listed public-style hostnames,
HTTPS and port 443. Do not set the literal string `allowlist` expecting it to load hosts.

All modes reject URL credentials, query/fragment, control characters, and invalid path
shapes. Stored endpoints are revalidated on use. This does not resolve DNS or pin its
answer: a hostname may resolve privately or change later. Use egress restrictions and
trusted operators; a custom endpoint receives the injected credential and controls its
response. The gateway's upstream fetch uses manual redirect handling and returns
`502 upstream_redirect` for 3xx. This is separate from the SDK's initial-origin check:
the TypeScript SDK uses fetch's redirect behavior and does not pin a redirect chain.

## Accounting and recovery

Admission uses atomic holds for each attempt. The estimate uses serialized prompt size
and an output limit (`max_tokens`, `max_completion_tokens`, or `max_output_tokens`),
with a default output estimate of 1024. It is not a tokenizer or a provider-enforced
maximum. Actual settlement can exceed the estimate/cap; subsequent admission sees that
spend. Anthropic cache read/write tokens are included in token accounting.

Complete usage settles observed figures. Failed/broken streams, missing terminal usage,
unreadable bodies, or ambiguous network failure settle as `usage_unknown`, charging at
least the estimate or a higher observation in each dimension. Definitive upstream
refusals have their own settlement classification; HTTP failure alone is not proof of
zero billing. An abandoned attempt can remain an open, non-expiring hold.

Prices on built-in endpoints use the in-code table and provider fallback for unknown
models. Custom endpoints are unpriced: `cost_microcents: null`, `unpriced: true`, receipt
`unp: true` with a placeholder numeric cost. Tokens still count. Cost-cap enforcement
uses a provider-table reservation estimate even there, not an actual custom price.
`enforced_*` accounting can differ from reported usage/cost. A spend figure must be read
alongside unknown pricing, uncertain usage, and reserved headroom.

Established budgets carry generations across Postgres and Redis. Missing counters or
mismatched generations refuse with `503 blocked_budget_state`; cap exhaustion is
`402 blocked_budget`. Cron reconciliation raises checkpoints/counters and reports open
holds; it does not release them because they are old. Recovery endpoints are:

- `GET /api/control/v1/agents/{id}/holds` (read).
- `POST /api/control/v1/agents/{id}/holds/{attemptId}/resolve` (write).
- `POST /api/control/v1/agents/{id}/budget/rebuild` (write).

`may_have_dispatched: true` means the attempt claimed dispatch permission and might be
billed; `not_spent` is refused. False permits that decision because this attempt did
not claim dispatch permission. Rebuilds use retained logs/adjustments, not independent
provider data. Review [the recovery runbook](./docs/budget-recovery.md) before acting.

## Owner verification details

For domains, publish the returned token at
`https://<domain>/.well-known/passcontrol-owner.txt`. For GitHub, publish it in public
repository `<login>/passcontrol-owner`, file `owner.txt` on its default branch; the
checker fetches `https://raw.githubusercontent.com/<login>/passcontrol-owner/HEAD/owner.txt`.
Both refuse redirects. These prove control of the publishing location at check time,
not legal identity. Domain URL shape checks are not DNS-aware SSRF prevention.

Rechecks preserve verification timestamps and can demote after three counted failures;
GitHub network-unreachable results do not count as failed ownership evidence. Cached
owner claims can lag changes. Registry/company lookup records separate evidence and
never upgrades owner tier or proves the tenant represents that company.

## Signed spend statements

Cloud serves `GET /api/control/v1/statements` and `GET /api/control/v1/statements/{seq}`;
`?receipt_id=<id>` requests an inclusion proof. These operating routes, their storage,
and scheduler are not included in the public self-host tree. The packaged control SDK
can call them on Cloud; it does not install them on a self-hosted gateway.

```bash
passcontrol statements
passcontrol verify statement "<jws>" --issuer https://your-gateway.example
```

`/verify/statement`, `verifyStatement`, and `verifyInclusion` are public verifier
surfaces. Verify the receipt and statement signatures against trusted keys before
checking inclusion, then check workspace/window and chain links against the expected
history. A single valid signature is not a whole-chain verification. `nr > n`, `unp`,
and `unk` describe coverage/pricing gaps; surface them rather than displaying a clean
bill. Commitment is not an independent audit of totals or completeness. Full wire
format, Merkle construction and vectors: [statement format](./docs/statement-format.md).

## Interactive CLI

`passcontrol` (or `passcontrol menu`) opens the searchable command browser on a TTY,
with grouped actions and recent commands. Noninteractive use prints static guidance;
explicit subcommands and `--help` remain available for scripts. The browser is a CLI
navigation surface, not an additional authentication method.


Policy outage posture is separate from kill-state posture. `POLICY_FAIL_CLOSED=true`
opts into blocking an unreadable policy; readable but malformed policy is denied.
Other authentication/state gates may still refuse a request even when this policy
check is configured fail-open. Shadow writes and observations are best-effort, so
counts are a lower bound, not a complete traffic census.

Passport receipt `use.cr` / `use.cw` carry Anthropic cache reads/writes where reported;
`pol` identifies the effective policy revision. Failover receipts use `prev` / `why`
to link attempts. Each receipt describes one attempt, not one complete multi-provider
transaction. The gateway may reserialize client JSON or add stream usage options, so
`req` is a digest of client bytes, not necessarily upstream wire bytes.
