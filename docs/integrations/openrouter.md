# OpenRouter

OpenRouter is a provider in PassControl. Store an OpenRouter key once, and an agent scoped to
`openrouter` can reach any model you allow, through OpenRouter's OpenAI-shaped chat API. The
agent never holds the OpenRouter key.

## Connect a tool

Any tool that takes an OpenAI base URL and an API key works through the sidecar:

```bash
passcontrol env generic --provider openrouter   # prints the settings below
passcontrol sidecar
```

- **Base URL:** `http://127.0.0.1:8788/api/v1/openrouter` (`/v1` is accepted too).
- **API key:** any value. The sidecar replaces it with a signed visa.
- **Model:** a model id as OpenRouter lists it (`vendor/model`), or `openrouter/free`, which
  picks only free models and is the default for a new OpenRouter agent.

Code using `passcontrol/sdk` can call the same route directly, with no sidecar: see the
[SDK guide](./passport-sdk.md).

## What is different about OpenRouter

- **Price.** A model can run on several upstream providers at different prices. Under a dollar
  limit, the call is reserved at the model's dearest provider and that rate is sent as
  `provider.max_price`, so routing cannot choose anything dearer. The charge is the cost
  OpenRouter reports for the call. A model whose price cannot be read is refused with 402
  `unpriced_model`.
- **The model is the one in `model`.** `models` fallbacks, `route`, presets and routers such as
  `openrouter/auto` are refused, because scope can only judge a model it can read.
- **OpenRouter's own tools are refused**: web search, `plugins`, `:online`. Function tools pass.
- Keys, credits and the other account endpoints are not reachable through the gateway.

The full rules are in [DOCUMENTATION.md](../../DOCUMENTATION.md) under the provider table.
