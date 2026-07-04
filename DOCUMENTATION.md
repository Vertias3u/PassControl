# PassControl — API Documentation (website blueprint)

> Source-of-truth draft for the public docs site. Audience: developers integrating
> PassControl. **Status tags** mark what's shippable today vs in development, so the
> published site never over-promises.
>
> - 🟢 **Available** — built and verified
> - 🟡 **Planned** — designed, not yet live

---

## What PassControl is

PassControl is an identity + credential gateway for AI agents. Instead of putting your
OpenAI/Anthropic API key inside an agent, the agent holds an **Ed25519 passport** (a private
key that never leaves it), signs a challenge to mint a short-lived **work-visa**, and calls
the model **through PassControl** — which injects your real provider key from an encrypted
vault and proxies the request. You get: no raw provider keys in agent runtimes, instant
revocation, per-agent budgets, and a per-passport audit trail.

There are three surfaces:

| Surface | For | Auth | Status |
|---|---|---|---|
| **Data plane** — proxy your model calls | agents (runtime) | work-visa | 🟢 Available |
| **Agent auth** — mint a visa | agents | Ed25519 signature | 🟢 Available |
| **Control plane** — manage your fleet | developers / backends | API key | 🟢 Available |

Base URL (self-host or hosted): `https://<your-gateway>`  ·  all paths below are relative to it.

---

## Authentication

### Developer API keys (control plane) 🟢

Create keys in the **Control Tower → API keys** (🟢 available today). A key is shown **once**;
we store only its hash. Send it as a bearer token:

```
Authorization: Bearer pc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

- **Scopes:** `read` (GET only) or `write` (full). Pick the least privilege per integration.
- Keys are prefixed `pc_` (so secret scanners catch leaks), revocable instantly, and
  multiple per account.
- **Never** put a key in a URL or commit it. Server-to-server only — don't ship it to a browser.

### Work-visas (data plane) 🟢

Agents authenticate to the proxy with a short-lived (5 min) JWT "visa", minted from a signed
challenge (below). Send it the way your provider SDK already sends a key — PassControl accepts
both `Authorization: Bearer <visa>` (OpenAI-style) and `x-api-key: <visa>` (Anthropic-style).

---

## Agent auth flow — mint a visa 🟢

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

## Data plane — proxy a model call 🟢

`POST /api/v1/:provider/*path`  ·  `provider` ∈ `openai | anthropic`

It's drop-in: point your existing SDK's `baseURL` at `…/api/v1/<provider>` and pass the visa
as the API key. The upstream path is preserved (`…/api/v1/anthropic/v1/messages` →
`api.anthropic.com/v1/messages`). PassControl verifies the visa → checks kill switch → checks
scope → reserves budget → injects your real provider key → streams the response back, and logs
the call. The provider key is never exposed.

Errors: `401 missing_visa | invalid_visa`, `402 blocked_budget`, `403 blocked_suspended |
blocked_scope`, `404 unknown_provider`, `413 payload_too_large`, `429 rate_limited`,
`502 upstream_unreachable`.

---

## SDK quickstart 🟢

The client SDK hides visa minting/refresh so integration is re-pointing your SDK, not rewriting
your agent.

```ts
import OpenAI from "openai";
import { PassControl } from "passcontrol"; // sdk/passcontrol.ts

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

---

## Control plane — manage your fleet 🟢

Base: `/api/control/v1` · `Authorization: Bearer pc_…` · JSON · responses carry `X-Request-Id`.

API-key creation/revocation is available in the Control Tower. The control-plane API
includes tenant-scoped agent lifecycle, logs, audit, spend, and kill-switch endpoints, with
`Idempotency-Key` support on writes.

### Conventions
- **Versioning:** URI (`/v1`); breaking changes → `/v2`.
- **Pagination:** cursor-based — `?limit=` (≤100) `&cursor=`.
- **Idempotency:** send `Idempotency-Key` on writes; retries won't double-apply.
- **Errors:** `{ "error": { "code", "message", "request_id" } }` + HTTP status.
- **Rate limits:** per key (e.g. read 600/min, write 60/min) → `429` + `Retry-After`.
- **Scopes:** GET needs `read`; everything else needs `write`.

### Agents
| Method | Path | Scope | Description |
|---|---|---|---|
| GET | `/agents` | read | List agents (filter `?status=`). |
| POST | `/agents` | write | Create. Body: `name`, `passport_pubkey`, `scopes`, `budget_tokens?`, `budget_cents?`. **You generate the Ed25519 keypair and send only the public key.** |
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
| GET | `/logs` | read | Gateway calls; filter by agent/status/time. |
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
