# Cloud Passport SDK

Use this path when you control JavaScript or TypeScript application code. If an application
accepts only a base URL and static API key, use a Cloud Direct Agent Key instead. The local
sidecar remains an advanced compatibility fallback; it is not the default Cloud path.

## What stays where

- PassControl Cloud stores the real provider credential server-side.
- Your agent runtime stores `PASSPORT_SECRET` and signs challenges locally.
- Cloud receives a public Passport ID, signed challenge and short-lived visa. It never receives
  the private passport key.
- Every provider call still goes to `https://passcontrol.vertias.eu/api/v1/<provider>/...`.

Do not put `PASSPORT_SECRET` in source control, logs, browser bundles or public environment
variables such as `NEXT_PUBLIC_*` or `VITE_*`.

## `PASSCONTROL_GATEWAY` must be a bare origin

Scheme + host + optional port — no path, query, fragment or embedded credentials — and HTTPS
unless the host is loopback (`localhost`, `127.0.0.1`, `[::1]`), where plain HTTP is accepted for
local development. Anything else throws at construction, before any network access.

For Cloud that is simply `https://passcontrol.vertias.eu`. Self-hosters should know it rules out
plain HTTP on a non-loopback host — a Compose service name such as `http://passcontrol:3000`,
`http://host.docker.internal:3000`, or a LAN address — and rules out a gateway served under a
sub-path. Front the deployment with TLS or reach it over a loopback port-forward.

The visa is a bearer credential and the SDK pins it to exactly this origin, refusing to attach it
to any other origin or to a non-`/api/v1/*` path. A gateway value that was loose about scheme or
path would weaken the pin it defines.

## OpenAI and OpenAI-compatible providers

```bash
npm install passcontrol@^0.6.0 openai
```

```ts
import OpenAI from "openai";
import { PassControl } from "passcontrol/sdk";

const passcontrol = new PassControl({
  gateway: process.env.PASSCONTROL_GATEWAY!,
  passportId: process.env.PASSPORT_ID!,
  passportSecret: process.env.PASSPORT_SECRET!,
});

const client = new OpenAI(passcontrol.clientOptions("openai"));
const response = await client.chat.completions.create({
  model: process.env.PASSCONTROL_MODEL!,
  messages: [{ role: "user", content: "Reply with: PassControl connected" }],
});
```

The same wrapper supports `groq`, `mistral`, `together` and `deepseek` by changing the literal
passed to `clientOptions`. The request remains in the OpenAI chat-completions shape.

## Anthropic

```bash
npm install passcontrol@^0.6.0 @anthropic-ai/sdk
```

```ts
import Anthropic from "@anthropic-ai/sdk";
import { PassControl } from "passcontrol/sdk";

const passcontrol = new PassControl({
  gateway: process.env.PASSCONTROL_GATEWAY!,
  passportId: process.env.PASSPORT_ID!,
  passportSecret: process.env.PASSPORT_SECRET!,
});

const client = new Anthropic(passcontrol.clientOptions("anthropic"));
const response = await client.messages.create({
  model: process.env.PASSCONTROL_MODEL!,
  max_tokens: 32,
  messages: [{ role: "user", content: "Reply with: PassControl connected" }],
});
```

## Model patterns are not model IDs

An allowed pattern such as `claude-*` is an authorization rule. It permits matching models but
is not a model ID Anthropic can call. `PASSCONTROL_MODEL` must contain one concrete provider model
ID covered by the passport's allowed patterns.

## Proof

Configuration is not proof. A successful setup produces an immutable `agent_logs` row with
`auth_method=passport` and `status=ok`. A receipt is called signed only when that stored row
contains the receipt. A failed challenge occurs before a tenant call row can be written.

### What that row proves, exactly

Authentication is two steps, and they are separate events:

1. **Challenge / mint.** The passport private key signs a canonical payload; the gateway verifies
   that Ed25519 signature, burns a single-use nonce, and issues a short-lived HS256 work visa.
2. **Provider call.** The request presents that visa. The gateway verifies the visa — a reusable
   bearer token until it expires — and checks kill state, scope and budget. No Ed25519 signature
   is carried or verified on this step.

So a stored `auth_method=passport` row proves the call **used a passport-derived visa**, and
therefore that a challenge signature was verified earlier when that visa was minted. It does not
prove the private key signed that particular provider request; a still-valid visa presented by
anyone who obtained it would produce the same row. That is why the dashboard says *Passport visa
accepted* rather than *Passport signature accepted*, and why visa lifetime is the window that
matters when a passport is compromised — suspend the agent to cut an issued visa short.

The **signed receipt** on the row is a third, different signature: the PassControl deployment
signs the receipt over the decision it recorded. It is evidence about the gateway's record, not
about the agent's passport, and the two must not be read as the same claim.
