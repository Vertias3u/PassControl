# Hermes Agent

**Status: works, no custom code required.** Point Hermes at the [visa sidecar](../../README.md#real-agents--the-visa-sidecar)
with a dummy API key. Hermes never holds a provider key, and every call it makes is
verified, scoped, budgeted, and revocable.

Verified against PassControl **0.4.0** on a local Docker stack (2026-07-27).

## Setup

Start the sidecar, then launch Hermes pointed at it:

```bash
passcontrol sidecar                    # http://127.0.0.1:8788
passcontrol env generic                # prints the values below for your provider/model
```

```bash
export OPENAI_BASE_URL="http://127.0.0.1:8788/api/v1/openai"
export OPENAI_API_KEY="passcontrol"    # ignored — the sidecar injects a live visa
```

For Anthropic-shaped traffic, swap the last path segment:

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:8788/api/v1/anthropic"
export ANTHROPIC_API_KEY="passcontrol"
```

The API key is a placeholder. The sidecar strips it, mints a work visa from your passport,
and forwards the call with the visa in `Authorization: Bearer …`. Your real provider key
stays in the Vault and is injected by the gateway, never by the agent.

## Why no shim is needed

Earlier notes on Hermes described writing a wrapper script to mint a visa, export it as the
API key, and refresh it before expiry. **That wrapper ships as `passcontrol sidecar`** — it
mints, caches, and auto-refreshes the visa (30s before expiry), and re-mints immediately on
a `401`. A multi-call agent session that outlives the 5-minute visa TTL keeps working
without the agent knowing visas exist.

## `/v1` path handling

The known concern with Hermes custom providers was `/v1` normalization — whether the client
appends `/v1` to the base URL. **For OpenAI-shaped routes this is a non-issue**: the endpoint
allowlist accepts both forms and canonicalizes them to the same upstream path.

| Route | Client sends | Result |
|---|---|---|
| `/api/v1/openai` | `/chat/completions` | ✅ → `/v1/chat/completions` |
| `/api/v1/openai` | `/v1/chat/completions` | ✅ → `/v1/chat/completions` |
| `/api/v1/anthropic` | `/v1/messages` | ✅ → `/v1/messages` |
| `/api/v1/anthropic` | `/messages` | ❌ `403 blocked_endpoint` |

**The Anthropic route is strict**: only `/v1/messages` is allowed. If a client is configured
to strip `/v1`, use the OpenAI-shaped route, which tolerates either form. A `403
blocked_endpoint` in `passcontrol logs` is the signature of this mismatch — the call was
rejected on the path, not on identity or budget.

PassControl deliberately proxies only chat/messages and model-listing endpoints. If a client
defaults to OpenAI `/responses`, force `/chat/completions`.

## What governance looks like from the agent's side

Allowed calls behave like a normal provider endpoint. Blocked calls return:

```
HTTP 403 {"error":"blocked_suspended"}
```

Every revocation returns that same body regardless of cause, so an agent cannot probe which
control stopped it. To find out which one fired, read your own audit trail — `passcontrol
logs` distinguishes `blocked_killed` (kill switch: platform, tenant, or denylist) from
`blocked_suspended` (per-agent suspend). Budget exhaustion is a separate `402 blocked_budget`.

To try it:

```bash
passcontrol kill on     # arm the tenant kill switch
# re-run the same task in Hermes — it now fails with 403
passcontrol kill off    # release
```

## Verified

| Behavior | Result |
|---|---|
| Fresh install → `passcontrol setup` → sidecar → agent | ✅ green |
| Multi-call repo-analysis task (many sequential calls) | ✅ green |
| Visa auto-refresh across a session longer than the 5-min TTL | ✅ no interruption |
| Kill switch armed mid-session | ✅ clean `403 blocked_suspended`, no hang or retry storm |
| Provider key reaching the agent | ✅ never — injected at the gateway |

Not yet exercised: budget-cap exhaustion (`402`) and scope violations (`403 blocked_scope`)
through Hermes specifically. Both are covered by the test suite and by `passcontrol try`, and
neither is Hermes-specific — they are enforced before the provider key is resolved, on the
same path as the kill switch above.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `403 blocked_endpoint` | Path mismatch — see [`/v1` handling](#v1-path-handling) |
| `403 blocked_scope` | The passport's scope doesn't cover that model. Check `passcontrol agent list` |
| `402 blocked_budget` | Per-agent budget exhausted. Check `passcontrol spend` |
| `401` from the sidecar | Passport not configured — run `passcontrol status` |
| Calls hang | Sidecar not running. Start it with `passcontrol sidecar` |

`passcontrol logs` shows every call the gateway saw, with the status that stopped it.
