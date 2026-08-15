# Hermes Agent

PassControl supports two honest Hermes paths, verified against Hermes Agent **0.18.2**.
Hermes uses its current `model.provider: custom` configuration. Legacy
`OPENAI_BASE_URL`/`LLM_MODEL` instructions were removed by Hermes and are not used here.

Hermes does not expose the custom `fetch` hook needed by `passcontrol/sdk`. Cloud therefore uses
a Direct Agent Key for Hermes today. Passport authentication requires the advanced local sidecar
below; issuing a passport alone does not configure Hermes.

## PassControl Cloud — Direct Agent Key

Choose an OpenAI-shaped provider (OpenAI, Groq, Mistral, Together, or DeepSeek) in
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

## Self-hosted — passport sidecar

For higher-assurance passport identity, keep the passport in PassControl's local config and
let the sidecar mint and refresh short-lived visas. Hermes receives only a placeholder key:

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

The dummy key is stripped by the sidecar. The passport private key stays in the trusted
local PassControl config, a visa is refreshed automatically, and the real provider key stays
in the self-hosted Vault.

## Prove the route

Run one small Hermes chat, then check Dashboard → Activity or `passcontrol logs`. A working
configuration produces a durable row for the concrete model. That stored row—not the config
screen and not a successful-looking local launch—is the proof that PassControl governed it.

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
