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
| `openai` | `POST /chat/completions` or `/v1/chat/completions`; `GET /models` or `/v1/models` | `/v1/chat/completions`; `/v1/models` |
| `groq` | `POST /chat/completions` or `/v1/chat/completions`; `GET /models` or `/v1/models` | `/v1/chat/completions`; `/v1/models` |
| `mistral` | `POST /chat/completions` or `/v1/chat/completions`; `GET /models` or `/v1/models` | `/v1/chat/completions`; `/v1/models` |
| `together` | `POST /chat/completions` or `/v1/chat/completions`; `GET /models` or `/v1/models` | `/v1/chat/completions`; `/v1/models` |
| `anthropic` | `POST /v1/messages`; `GET /v1/models` | `/v1/messages`; `/v1/models` |
| `deepseek` | `POST /chat/completions` | `/chat/completions` |

Endpoints outside that allowlist are denied by default. The gateway does **not** proxy
embeddings, files, fine-tuning, batches, responses, or token-counting endpoints. PassControl
verifies the visa → checks kill switch → checks scope → checks endpoint allowlist → reserves
budget → injects your real provider key → streams the response back, and logs the call. The
provider key is never exposed.

Errors: `401 missing_visa | invalid_visa`, `402 blocked_budget`, `403 blocked_suspended |
blocked_scope | blocked_endpoint`, `404 unknown_provider`, `413 payload_too_large`,
`429 rate_limited`, `502 upstream_unreachable`.

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
npm run cli -- env openhands
npm run cli -- env aider
npm run cli -- env cline
npm run cli -- env continue
npm run cli -- env litellm
```

Continue-specific note: its OpenAI provider may default to `/responses` for o-series and
gpt-5 models. PassControl intentionally does not proxy `/responses`; set
`useResponsesApi: false` so Continue uses `/chat/completions`.

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
| GET | `/logs` | read | Gateway calls; filter by `agent_id`, `status`, and `limit`. |
| GET | `/audit` | read | Admin-action trail. |
| GET | `/spend` | read | Per-agent + fleet totals (micro-cents; $ = µ¢ / 100,000,000). |

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
