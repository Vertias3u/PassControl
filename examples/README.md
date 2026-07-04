# Example agents for PassControl

Zero-setup scripts to exercise PassControl end-to-end (you don't have to own a
real agent — these *are* the example agents). Self-contained `.mjs`, run with plain
`node`; they use the same flows the SDK wraps (`../sdk/`).

| Script | Plane | What it does |
|---|---|---|
| `starter-agent.mjs` | data | A real **tool-using loop** (think → call tool → think) run through the gateway — the "be user #1" demo. Every model round-trip is a proxied, audited call. |
| `chat-agent.mjs` | data | Minimal: signs a challenge → mints a visa → calls a model **through the gateway**. Generates real audit + spend rows. |
| `visa-sidecar.mjs` | data | A local reverse proxy that mints/refreshes the visa for you — makes PassControl **drop-in for any agent that wants a static key** (OpenHands, Aider, Cline, …), no SDK required. |
| `fleet-admin.mjs` | control | Drives `/api/control/v1` with a `pc_` API key: list/create/suspend/revoke agents, read spend/audit, toggle kill switch. |

## Using PassControl with a third-party agent (the visa sidecar)

Most agents (OpenHands, Aider, Cline, Continue…) expect a **static** API key + base URL —
but a PassControl visa expires in 5 minutes, and those agents won't refresh it. The
**visa sidecar** bridges that: it holds your passport, mints + refreshes the visa in the
background, and injects it into every request it forwards to the gateway.

```bash
# 1. Start the gateway (npm run dev:docker) and issue a passport in the dashboard.
# 2. Run the sidecar with that passport:
PASSPORT_ID=<pubkey> PASSPORT_SECRET=<privkey> npm run sidecar
#    → listening on http://127.0.0.1:8788, forwarding to the gateway with a fresh visa
```

Then point your agent at the sidecar exactly as you'd point it at the gateway, with the
API key set to **anything** (it's replaced):

- **OpenHands / LiteLLM:** base URL `http://127.0.0.1:8788/api/v1/anthropic` (or
  `/api/v1/openai`), API key = `sidecar` (ignored), model within the passport's scope.

The agent never holds a real key *or* a visa — the sidecar owns the visa, the gateway owns
the provider key. Make sure the passport's **scope** covers the model the agent calls and
give it a **budget** so you can watch PassControl govern a real agent.

## Prereqs
- The gateway running (`npm run dev`) or deployed — set `PASSCONTROL_GATEWAY`.
- A **provider key** added in the dashboard (so the proxy has a real key to inject).
- A **write-scoped API key** (dashboard → API keys) for `fleet-admin.mjs`.

## Typical test loop
```bash
export PASSCONTROL_GATEWAY=http://localhost:3000
export PASSCONTROL_API_KEY=pc_xxx        # from the dashboard API-keys panel

# 1. Mint a test agent (prints its passport ONCE)
node examples/fleet-admin.mjs create test-bot
#   → copy the printed PASSPORT_ID / PASSPORT_SECRET

# 2. Have that agent call a model through the gateway
PASSPORT_ID=… PASSPORT_SECRET=… node examples/chat-agent.mjs "Say hi in 3 words"

# 3. See the effect
node examples/fleet-admin.mjs spend
node examples/fleet-admin.mjs audit

# 4. Kill-switch drill
node examples/fleet-admin.mjs suspend <agent-id>   # next chat-agent run → 403
node examples/fleet-admin.mjs resume <agent-id>
```

## Notes
- The passport **private key never leaves the process** — `chat-agent.mjs` only signs
  challenges locally; `fleet-admin.mjs create` generates the keypair and sends only the
  public key.
- Keys/secrets are read from env — don't commit them. These scripts are test tooling, not
  part of the app build or test suite.
