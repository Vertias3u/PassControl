# Ollama and other local model servers

On a self-hosted PassControl, an agent can call a model server running on your own machine:
Ollama, LM Studio or vLLM. The calls are governed like any other (scope, token budget, policy, kill
switch, receipts), and the agent never talks to the server directly. Hosted Cloud does not offer
local models.

## Connect Ollama

In the dashboard, open **Settings → Provider credentials → Models on this machine** and press
**Use Ollama**. It asks Ollama at `http://localhost:11434/v1` for its models and, only if Ollama
answers, stores a `local` credential (no key) with that address. Then create an agent with
`local` scope.

Local models have no price, so give the agent a **token** budget. An agent with a dollar limit is
refused with 402 `unpriced_endpoint`.

## Connect an app

**Apps that take an OpenAI base URL:**

```bash
passcontrol env generic --provider local
passcontrol sidecar
```

Use the base URL `http://127.0.0.1:8788/api/v1/local` and any API key, which the sidecar replaces.

**Apps that only take `OLLAMA_HOST`** (they speak Ollama's own API):

```bash
passcontrol sidecar --ollama-port      # listens on 11435
export OLLAMA_HOST=127.0.0.1:11435     # `passcontrol env ollama` prints this
```

`/api/chat` and `/api/generate` are governed calls, with tokens read from Ollama's own counts.
`/api/tags`, `/api/show` and `/api/version` are admitted as metadata. Ollama's admin API (`pull`,
`push`, `create`, `copy`, `delete`) is never reachable through an agent. Embeddings are not
served on `local` yet.
