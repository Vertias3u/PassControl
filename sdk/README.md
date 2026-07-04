# PassControl client SDK

The thin client that hides **visa minting**. Your agent holds an Ed25519 passport;
this SDK signs the challenge, mints the short-lived work-visa, refreshes it before it
expires, and injects it into requests — so integrating PassControl means *re-pointing*
your existing OpenAI/Anthropic SDK, **not rewriting the agent**.

Dependencies: only [`@noble/curves`](https://github.com/paulmillr/noble-curves) and the
platform `fetch`/`crypto`. Runs on Node 18+, edge runtimes, and the browser.

> Keep `passportSecret` on the agent and out of source control — it is the private key.
> It only ever *signs*; it never travels to the gateway.

## Drop-in with the OpenAI SDK

```ts
import OpenAI from "openai";
import { PassControl } from "./sdk";

const pc = new PassControl({
  gateway: process.env.PASSCONTROL_GATEWAY!,   // https://your-gateway.example.com
  passportId: process.env.PASSPORT_ID!,        // base64url Ed25519 public key
  passportSecret: process.env.PASSPORT_SECRET!,// base64url Ed25519 private key
});

const openai = new OpenAI(pc.clientOptions("openai"));

const r = await openai.chat.completions.create({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "Say hello in 3 words." }],
});
```

## Drop-in with the Anthropic SDK

```ts
import Anthropic from "@anthropic-ai/sdk";
import { PassControl } from "./sdk";

const pc = new PassControl({ gateway, passportId, passportSecret });
const anthropic = new Anthropic(pc.clientOptions("anthropic"));

const msg = await anthropic.messages.create({
  model: "claude-haiku-4-5",
  max_tokens: 128,
  messages: [{ role: "user", content: "Say hello in 3 words." }],
});
```

`clientOptions(provider)` returns `{ baseURL, apiKey, fetch }`. The `fetch` wrapper owns
auth (it sets `Authorization: Bearer <visa>` and strips any `x-api-key`), so the `apiKey`
is a non-secret placeholder the SDK constructor requires — your real provider key never
leaves the gateway's vault.

## Raw usage (no provider SDK)

```ts
const pc = new PassControl({ gateway, passportId, passportSecret });

// Mint/refresh a visa yourself:
const visa = await pc.getVisa();

// …or use the wrapped fetch directly against the proxy:
const res = await pc.fetch(`${gateway}/api/v1/anthropic/v1/messages`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 64,
    messages: [{ role: "user", content: "hi" }] }),
});
```

## Control-plane SDK (manage your fleet)

Separate from the data-plane client above: `ControlClient` (in `./control`) is a typed
wrapper over the developer API (`/api/control/v1`), authenticated with a `pc_` API key.
It mirrors the REST resources, unwraps the `{ data }` envelope, and throws
`ControlApiError` (with `status`, `code`, `requestId`) on failure.

```ts
import { ControlClient } from "./sdk";

const pc = new ControlClient({
  gateway: process.env.PASSCONTROL_GATEWAY!,
  apiKey: process.env.PASSCONTROL_API_KEY!, // pc_… (server-side only)
});

const agents = await pc.agents.list({ status: "active" });
const created = await pc.agents.create(
  { name: "billing-bot", passportPubkey, scopes: [{ provider: "anthropic", models: ["claude-*"] }] },
  { idempotencyKey: "create-billing-bot" } // safe retries
);
await pc.agents.suspend(created.id);
await pc.killSwitch.set(true); // arm the tenant master kill

const spend = await pc.spend.get(); // micro-cents; USD = µ¢ / 100_000_000
```

Resources: `agents.{list,get,create,update,suspend,resume,revoke}`, `logs.list`,
`audit.list`, `spend.get`, `killSwitch.{get,set}`. Writes accept `{ idempotencyKey }`.
The full reference lives in [`openapi.yaml`](../openapi.yaml).

## Behavior

- **Cache + refresh.** A minted visa is cached and reused until it is within
  `refreshSkewSeconds` (default 30s) of expiry, then re-minted automatically.
- **Single-flight.** Concurrent `getVisa()` calls share one challenge request.
- **401 retry.** If a proxied call returns `401` (visa rejected/expired), the SDK
  invalidates the cache, re-mints once, and retries.
- **No secret on the wire.** The passport private key only signs the challenge locally;
  the gateway only ever sees the public key and the signature.
