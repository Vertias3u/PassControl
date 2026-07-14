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

## Product CLI

Install the CLI globally (`npm install -g passcontrol`) and drive everything with `passcontrol`:

```bash
passcontrol status
passcontrol init
passcontrol call "Say hi in 3 words"
passcontrol mcp
passcontrol sidecar
passcontrol env openhands
passcontrol spend
passcontrol audit
passcontrol logs
```

> From a source checkout without the global install, every `passcontrol <cmd>` here is
> `npm run cli -- <cmd>`.

The scripts below remain useful as tiny, readable demos of what the CLI is doing.

## One-time local config

Create one local config file instead of pasting env vars into every command:

```bash
passcontrol init
# or: cp .passcontrol.example .passcontrol
# Fill PASSCONTROL_GATEWAY, then add PASSPORT_ID/PASSPORT_SECRET and/or PASSCONTROL_API_KEY.
```

The CLI/examples load the nearest `.passcontrol` from your current directory or a parent
directory. A global profile from `passcontrol init --global` also works. Real
environment variables always win, so this still works for one-off overrides:

```bash
MODEL=claude-haiku-4-5 node examples/chat-agent.mjs "Say hi"
```

If config is missing, the CLI and scripts print a one-line fix.

## Using PassControl from an MCP client

Claude Desktop, Cursor, and Claude Code can use PassControl's governed `chat` and
`list_models` tools without receiving a provider key or passport secret:

```bash
passcontrol init --global
passcontrol configure claude-desktop --write   # use `cursor` for Cursor
# `passcontrol configure claude-code` prints the command Claude Code owns
```

Restart the client. Its config contains only absolute launch paths; the passport remains in
the global owner-only profile, and model calls still traverse the gateway's scope, budget,
audit, and kill-switch enforcement.

## Using PassControl with a third-party agent (the visa sidecar)

Most agents (OpenHands, Aider, Cline, Continue…) expect a **static** API key + base URL —
but a PassControl visa expires in 5 minutes, and those agents won't refresh it. The
**visa sidecar** bridges that: it holds your passport, mints + refreshes the visa in the
background, and injects it into every request it forwards to the gateway.

```bash
# 1. Start the gateway (npm run dev:docker) and issue a passport in the dashboard.
# 2. Put that passport in .passcontrol, then run:
passcontrol sidecar
#    → listening on http://127.0.0.1:8788, forwarding to the gateway with a fresh visa

# Optional: print copy/paste settings for common agents.
passcontrol env openhands
passcontrol env aider
passcontrol env cline
passcontrol env continue
passcontrol env litellm
```

Then point your agent at the sidecar exactly as you'd point it at the gateway, with the
API key set to **anything** (it's replaced):

- **OpenHands / LiteLLM:** base URL `http://127.0.0.1:8788/api/v1/anthropic` (or
  `/api/v1/openai`), API key = `sidecar` (ignored), model within the passport's scope.
- **Aider:** use the OpenAI-compatible preset (`OPENAI_API_BASE`, `OPENAI_API_KEY`,
  `AIDER_MODEL`) printed by `passcontrol env aider`.
- **Cline / Continue:** use their OpenAI-compatible/custom provider UI with the sidecar base
  URL and API key `sidecar`. For Continue, disable `/responses` for o-series/gpt-5 configs
  (`useResponsesApi: false`) so it calls `/chat/completions`.

The agent never holds a real key *or* a visa — the sidecar owns the visa, the gateway owns
the provider key. Make sure the passport's **scope** covers the model the agent calls and
give it a **budget** so you can watch PassControl govern a real agent.

## Prereqs
- The gateway running (`npm run dev:docker` for the local stack, or `npm run dev` for your
  own `.env.local`) or deployed — set `PASSCONTROL_GATEWAY`.
- A **provider key** added in the dashboard (so the proxy has a real key to inject).
- A **write-scoped API key** (dashboard → API keys) for `fleet-admin.mjs`.
- A local `.passcontrol` copied from `.passcontrol.example`, or equivalent env vars.

## Typical test loop
```bash
passcontrol init
# Fill PASSCONTROL_GATEWAY and PASSCONTROL_API_KEY first.

# 1. Mint a test agent (prints its passport ONCE)
passcontrol agent create test-bot
#   → paste the printed PASSPORT_ID / PASSPORT_SECRET into .passcontrol

# 2. Have that agent call a model through the gateway
passcontrol call "Say hi in 3 words"

# 3. See the effect
passcontrol spend
passcontrol logs --limit 10
passcontrol audit --limit 10

# 4. Kill-switch drill
passcontrol agent suspend <agent-id>   # next call → 403
passcontrol agent resume <agent-id>
```

## Notes
- The passport **private key never leaves the process** — `chat-agent.mjs` only signs
  challenges locally; `fleet-admin.mjs create` generates the keypair and sends only the
  public key.
- Keys/secrets are read from env or `.passcontrol`. The real `.passcontrol` file is
  gitignored; only `.passcontrol.example` is meant to ship. These scripts are test tooling,
  not part of the app build or test suite.
