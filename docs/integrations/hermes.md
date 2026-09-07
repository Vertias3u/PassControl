# Hermes Agent

PassControl supports two honest Hermes paths, verified against Hermes Agent **0.18.2**.
Hermes uses its current `model.provider: custom` configuration. Legacy
`OPENAI_BASE_URL`/`LLM_MODEL` instructions were removed by Hermes and are not used here.

Hermes does not expose the custom `fetch` hook needed by `passcontrol/sdk`, so Hermes cannot sign
a challenge by itself. Two consequences, and the second one is the one people get wrong:

1. A **Direct Agent Key** is the simplest Cloud path, and the default below.
2. **Passport identity in Hermes is available on Cloud**, but only with the connector running —
   something has to do the signing. See "Passport connector" below.

**Issuing a passport alone does not configure Hermes.** A passport is a signing key, not a bearer
token. Pasting `PASSPORT_SECRET` into Hermes's `api_key` field does not authenticate — the gateway
refuses it with `401` — and it exposes the private key to a third-party config file. If that has
happened, rotate the passport.

## PassControl Cloud — Direct Agent Key

Choose an OpenAI-shaped provider (OpenAI, Groq, Mistral, Together, DeepSeek, or Gemini) in
**Connect an agent**. After the reveal-once key is issued, the dashboard prints the exact
Hermes block:

```yaml
model:
  default: "gpt-5-mini"
  provider: custom
  base_url: "https://passcontrol.vertias.eu/api/v1/openai/v1"
  api_key: "pc_agent_REVEAL_ONCE_VALUE"
```

Merge it into `~/.hermes/config.yaml`, store the file with user-only permissions, and run:

```bash
hermes chat
```

The `pc_agent_…` value is a named, revocable, scope- and budget-bound agent credential.
It is not the provider key. The provider key remains in PassControl Vault and is used
server-side only after the call passes the gate.

Hermes custom providers speak the OpenAI chat-completions shape. Do not point this setup at
PassControl's native Anthropic Messages route; choose one of the OpenAI-shaped providers
above. This is a request-shape constraint, not a claim that Anthropic is unsupported by
PassControl generally.

## Passport connector — works against Cloud *and* self-hosted

The connector is **not** self-hosting. It is one foreground process — no Docker, no database —
that keeps the passport in PassControl's local config and mints and refreshes short-lived visas
against whichever gateway you configured, Cloud included. Hermes receives only a placeholder key:

```bash
passcontrol init --global
passcontrol sidecar
passcontrol env hermes --provider openai --model gpt-5-mini
```

The last command prints a block like:

```yaml
model:
  default: "gpt-5-mini"
  provider: custom
  base_url: "http://127.0.0.1:8788/api/v1/openai/v1"
  api_key: "passcontrol"
```

The dummy key is stripped by the connector. The passport private key stays in the trusted local
PassControl profile or OS credential store and is never sent to the gateway; a visa is refreshed automatically; and the real
provider key stays in the Vault — PassControl Cloud's, or your own if you self-host.

To point the connector at Cloud, set the gateway once (`passcontrol init --global`) to
`https://passcontrol.vertias.eu`. The base URL Hermes uses stays `http://127.0.0.1:8788/...`.

## Prove the route

Run one small Hermes chat, then check Dashboard → Activity or `passcontrol logs`. A governed call attempts to persist a row for the concrete model. Inspect that row and
its authentication method; logging is best-effort, so absence does not establish that
no call ran. A signed receipt verifies the issuer's recorded assertion, not independent execution.

Then exercise one refusal:

```bash
passcontrol kill on
# send another Hermes message; it must be refused
passcontrol kill off
```

Confirm the blocked row was stored and no provider dispatch occurred. Scope and budget
refusals use their own exact stored statuses.

## Boundary and failure modes

- Hermes features configured with a different provider, fallback endpoint, web-search key,
  or auxiliary tool do not automatically pass through this model route. They are outside
  PassControl unless separately routed through it.
- A Cloud Direct Agent Key is lower-assurance bearer possession. A passport signs a
  challenge and uses five-minute visas. Receipts preserve that distinction.
- `401` means the Direct Agent Key/passport path was not accepted or the sidecar could not
  mint a visa.
- `403 blocked_scope` means the concrete Hermes model is outside the agent scope.
- `403 blocked_endpoint` means the base URL/path does not land on chat completions.
- `402 blocked_budget` means the agent budget is exhausted.
- A running self-hosted Hermes session requires the foreground sidecar to remain available.

PassControl does not rewrite Hermes config automatically. `passcontrol env hermes` is
read-only and prints the exact block so an existing YAML file is never overwritten or
silently corrupted.


In 0.9.0 the sidecar adds sender proofs, so it can be used with required sender-proof
mode. A DAK remains a bearer credential and is not upgraded by that setting. Scope,
budget and lifecycle limits are described in [the reference](../../DOCUMENTATION.md).
For Gemini, use the printed `gemini` provider configuration with an OpenAI-compatible
model endpoint. OpenAI POST Responses is supported; other providers remain on their
allowlisted chat/messages paths. Custom endpoints require the gateway operator's
endpoint policy and are not automatically priced.
