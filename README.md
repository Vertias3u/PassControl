# PassControl

**An identity and credential gateway for AI agents.** The agent never holds the real
provider key: PassControl authenticates it, checks scope, policy and budget, then injects
the key and forwards the request. Call logs and signed receipts let you inspect what
happened, with [explicit limits on that evidence](#limits-and-security-status).

Use it when you want to give each agent its own permissions, spending allowance and
stop control without copying provider secrets into every tool. Bring your own provider key.

| Start here | Choose it when | You operate |
|---|---|---|
| [Cloud](#cloud) — free private beta, access by request | You want a managed gateway without running a database or Docker | Your agents and provider account |
| [Self-host](#self-host) — full working core | You want the gateway and provider credentials on infrastructure you control | Gateway, dashboard, Supabase Auth + Vault + database, and Redis |

A **Passport** is an Ed25519 signing key used to obtain a short-lived visa. A **Direct
Agent Key** is a lower-assurance bearer credential bound to one agent; its calls are
not passport-signed. Both go through gateway controls.

Built by one developer under [Vertias](https://vertias.eu). Early software, **not
independently audited**. Start with a non-critical provider key. Source-available under
[BSL 1.1](./LICENSE).

## Cloud

[Request beta access](https://passcontrol.vertias.eu/beta). To look around first, try
[the keyless browser demo](https://passcontrol.vertias.eu): it synthesizes output and
does not call a billed provider.

Once you have access, install the CLI with Node/npm and sign in:

```sh
npm install -g passcontrol
passcontrol login
```

Approve only the device code from your own terminal: this grants the machine a workspace
control key. Login creates a Passport locally, registers its public key, and attempts a
keyless governed call and receipt verification. That check needs demo and signing enabled;
it is not a real-provider test.

For a real call, add a provider key in the dashboard, give the agent a matching
provider/model scope and budgets, and follow [the first-call tutorial](./TUTORIAL.md#4-govern-it).
For a static-key client, use **Connect an agent** and copy its generated gateway URL,
Direct Agent Key and concrete model into your client. The provider key stays in Vault.

## Self-host

Already stuck? See [self-host troubleshooting and operations](./docs/self-host.md).

Use **Node 22+**, npm, Git, Docker and the Supabase CLI. The npm package contains the CLI
and compiled SDK; setup obtains the public application source and starts the local stack.

```sh
npm install -g passcontrol
passcontrol setup
```

Setup starts Supabase (Postgres + Auth + Vault) and Redis with a REST adapter, applies
migrations, seeds a local account and opens the dashboard. There are no shared default
credentials. This is a **local development setup**, not a production deployment.

1. **Make a Passport call.** Add a non-critical provider key in **Provider Keys**. Issue a
   Passport with a matching provider/model scope and budgets. Choose the dashboard's
   Sidecar or MCP configuration flow, copy its generated Passport import command into
   your terminal, then paste the one-time secret at the hidden prompt. The command itself
   contains no secret. Follow the generated client configuration and send a small prompt.
   Check the call and budget charge in the dashboard.
2. **Try a Direct Agent Key.** Use **Connect an agent**, select a concrete model within
   scope, and copy the generated gateway URL and reveal-once key into your static-key
   client. Send another prompt and check its authentication method in the call log.
3. **Check the budget.** Lower the test agent's token budget below the next request's
   reservation estimate and retry; expect a budget refusal. Restore the budget afterward.
4. **Check the kill switch.** Arm it in the dashboard and retry; subsequent requests
   should be refused. Disarm it when finished. It cannot cancel a request already upstream.

The Passport import hands browser-issued configuration to the CLI without putting its
secret in shell history. Keep the one-time secret until import succeeds.
[The tutorial](./TUTORIAL.md#3-your-first-governed-call-self-host-path) explains the manual
CLI path; [client options](#connect-a-real-agent) cover SDK, Sidecar and MCP.

## Limits and security status

PassControl is **not independently audited**. The public developer API has **not shipped**;
the source includes a control-plane API, but that is not a launched public developer service.
No independent audit or production assurance is implied by the test suite.

PassControl governs requests routed through it. It cannot prevent an agent from using
another credential or network path, secure a compromised signer, guarantee a provider's
usage report, or make an issuer's assertions independently true. Budget admission reserves
an estimate, not a guaranteed invoice ceiling. Logging and receipt signing are best-effort;
a valid receipt does not prove every call was recorded.

The gateway operator remains trusted: Cloud uses managed server-side Supabase Vault;
self-hosting uses your Vault. The gateway decrypts and injects the provider key. This is
credential isolation, not end-to-end encryption from agent to provider.

Short visas, stop controls, pricing tables and evidence each have further limits below.
Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/Vertias3u/PassControl/security/advisories/new).
See [SECURITY.md](./SECURITY.md) and [LICENSE](./LICENSE) for security guidance and usage terms.

## Connect a real agent

Use the dashboard's generated provider-native configuration: gateway base URL, Direct
Agent Key and model. Anthropic uses its native base URL and key variables. Never paste
a Passport private key into an API-key field.

Add a provider credential in the dashboard and give the agent a concrete model within
its scope and suitable budgets. Choose by what your client supports:

| Client | Integration |
|---|---|
| Static base URL + API key | Dashboard **Connect an agent**: copy its provider-native URL and DAK |
| Your JS/TS code | `PassControl` from `passcontrol/sdk`; [SDK guide](./docs/integrations/passport-sdk.md) |
| Static-key client needing Passport | `passcontrol sidecar`, then `passcontrol env <integration>` |
| MCP client | `passcontrol mcp`; configure as below |

Direct Agent Keys point the client at the PassControl gateway origin. Passport Sidecar clients
point at loopback with a provider path (for example `http://127.0.0.1:8788/api/v1/anthropic`) and the sidecar forwards to the gateway.
The sidecar adds per-request sender proof; the current SDK and MCP paths use bearer visas and are
refused when sender proof is required.

For a Passport bridge to Cloud or self-host, start this in one terminal:

```sh
passcontrol sidecar
```

In another terminal, print the client settings:

```sh
passcontrol env hermes
```

For MCP, write client configuration using the global Passport profile, with no secret
in the generated configuration:

```sh
passcontrol configure claude-desktop --write
```

The cursor preset also writes configuration; claude-code prints its client-managed add command.

The sidecar listens on loopback by default and substitutes a visa for the client's dummy
API key. Treat access to that local listener as access to the configured agent. It is
not a sandbox against other processes running as you. Its provider CONNECT requests are
refused; use base URLs rather than TLS interception.

Presets (from `cli/presets.mjs`): `generic`, `openhands`, `litellm`, `aider`, `hermes`, `cline`, `continue`, `chatbox`, `jan`, `msty`, `cherry-studio`, `open-webui`, `librechat`; MCP presets: `claude-desktop`, `cursor`, `claude-code`. Compatibility still depends on the client using
supported paths. [Hermes configuration](./docs/integrations/hermes.md).

## CLI configuration and key storage

<details>
<summary>Command browser, key custody and Passport import</summary>

Run **`passcontrol`** with no arguments in an interactive terminal to open the command
browser: searchable grouped commands, recent actions, and configuration-aware options.
Use `passcontrol --help` or explicit commands in scripts.

The direct CLI call uses off/observe sender-proof mode; real provider calls need a stored
key and matching scope. Key migration moves an existing file key to the OS store.

```sh
passcontrol status
passcontrol call "Say hello"
passcontrol doctor --deep
passcontrol key status
passcontrol key migrate
passcontrol logout
```

The CLI supports macOS Keychain, Linux Secret Service (`secret-tool`), and Windows
DPAPI-backed storage. File configuration may contain a storage marker instead of the
Passport secret; explicit environment secrets take precedence. An unavailable OS store
can use an existing file fallback with a warning. Custody shown by the gateway is
**DECLARED evidence**, not proof of storage. The signer still reads key material into
process memory; this is not a non-exportable hardware key.

For a Passport issued in the dashboard for Sidecar or MCP, import it without putting the
one-time secret in shell history:

```bash
passcontrol passport import --global --gateway https://YOUR-PASSCONTROL-HOST --id PUBLIC_PASSPORT_ID
```

The CLI proves the 32-byte Ed25519 secret matches the public ID, stores it in macOS Keychain,
Linux Secret Service, or Windows DPAPI, verifies readback, and only then atomically updates the
global profile. Replacement requires `--replace`. The public command contains no secret.

</details>

## Security and protocol reference

<details>
<summary>Authentication, enforcement, budget uncertainty, providers and evidence</summary>

### Request and authentication flow

```text
Direct Agent Key ───────────────────────────────────────────────┐
                                                              v
Passport private key ── signs challenge ──> short-lived visa ──> gateway
  stays client-side                           + request proof     |
                                              when required      |
                 authentication → kill/suspend → scope/policy → budget hold
                                                                 |
                                              Vault key → provider → response
                                                                 |
                                              settlement + best-effort log/receipt
```

A Passport private key never reaches Cloud or the gateway. It signs challenge bytes
locally to mint a work-visa; the sidecar also signs request proofs. Visas are
HS256 tokens, normally valid for five minutes (`VISA_TTL_SECONDS`: 300–900 seconds).

| Credential | What the client does | Boundary |
|---|---|---|
| **Direct Agent Key (DAK)** | Sends a named, reveal-once `pc_agent_…` bearer key | Bound to one agent; hash stored server-side, optional expiry, independently revocable. Works with static-key clients. Does not mint visas or authorize control-plane operations. |
| **Passport** | Holds an Ed25519 keypair and signs challenges for visas | Proves possession at mint. Private key stays in the SDK runtime, CLI, sidecar, or MCP process. |
| **Passport with required sender proof** | Sends a fresh signed proof with each visa-authenticated request | A stolen visa alone is insufficient. The proof binds method, gateway origin/path, time, nonce, and visa hash. |
| **Control key** | Sends `pc_…` to `/api/control/v1` | Manages the workspace; separate from either agent credential. Keep it out of agent integrations. |

Passport sender-proof modes are **off**, **observe**, and **required**. Off ignores
proofs; observe records what would pass without enforcing it; required rejects missing,
invalid, stale, or replayed proofs. Only enforced success is recorded as
`passport_proof_per_request`; observing a valid proof does not upgrade authentication.
The sidecar supplies proofs; the direct CLI call, MCP chat, and TypeScript SDK
do not attach them and cannot use required mode without an additional proof implementation.
Proofs do **not** bind the request body or query string and do not attest hardware or
key storage. See [authentication and lifecycle](./DOCUMENTATION.md#passport-lifecycle-and-sender-proof).

Passport expiry and rotation grace are checked at mint, not on every existing visa.
Use suspend/revoke or a kill switch to stop subsequent requests using issued visas;
these controls do not cancel an upstream request already in flight. Public lifecycle
checks and the signed [revocation list](./DOCUMENTATION.md#public-passport-revocation-list)
are separate from signature verification.

### What the gateway enforces

- An allowlist of provider endpoints, plus the agent's provider/model scope.
- Live policy rules: model/endpoint denials, time windows, request limits; optional
  shadow evaluation records candidate decisions without enforcing them.
- Token and cost admission limits through atomic reservations and settlement.
- Platform/tenant kill switches and per-agent suspension/revocation.
- Provider failover within supported request families and each attempt's authorization
  and budget checks; it is not arbitrary API translation.

Passport scopes are snapshots in visas; scope edits can take up to the configured visa
TTL to replace those snapshots. Other live controls have their own cache/invalidation
behavior. Kill-state reads default to fail-open; `KILL_SWITCH_FAIL_CLOSED=true` blocks
on kill/suspend read failure. Required sender-proof replay checks and DAK credential
validation fail closed. Redis persistence and no-eviction configuration matter.

#### Budgets under uncertainty

Admission reserves an **estimate**, not a provider invoice or a guaranteed upper bound.
Concurrent attempts consume reserved headroom. Complete usage settles measured tokens
and table-priced cost; actual usage can exceed the estimate and cap. Anthropic cache
reads/writes count toward token usage as well as their applicable price.

A broken stream, missing usage, or ambiguous dispatch is not assumed free. An uncertain
settlement retains at least the estimate (or higher observed usage); an attempt whose
ending never runs leaves an open hold that does not expire. `may_have_dispatched`
means dispatch permission was claimed, not that billing is proven. Such a hold cannot
be released as `not_spent` through recovery.

Lost or mismatched established budget generations cause `503 blocked_budget_state`,
not a fresh allowance. Recovery is an explicit operator action over retained logs and
adjustments; it cannot reconstruct missing evidence. See [Budget recovery](./docs/budget-recovery.md).

Prices are an in-code estimate table. Unknown models on built-in endpoints use a
provider fallback rate. **Custom endpoints are unpriced**, even when the model name
matches: logs mark cost unknown, receipts carry `unp`, and token accounting continues.
The cost budget retains a proxy estimate; it does not become knowledge of actual dollars.
Known/table-priced cost, conservative enforced spend, and open holds are different figures.
The dashboard therefore labels the all-time counter **Settled budget charges** and shows its
durable call-attributed charges, separate operator adjustments, any visible difference, and
live open reservations marked **not yet charged**. The call table keeps observed cost and budget
charge in separate columns and can load older durable rows on demand. An unavailable database or
Redis explanation is shown as unavailable, never as zero.

### Supported providers and endpoints

All paths below are relative to `/api/v1/<provider>`. SDK base URLs and aliases are in
[the endpoint reference](./DOCUMENTATION.md#data-plane--proxy-a-model-call).

| Provider ID | Inference | Discovery |
|---|---|---|
| `openai` | Chat Completions and **POST Responses** | Models list/detail |
| `anthropic` | Messages | Models list/detail |
| `groq`, `mistral`, `together` | OpenAI-compatible Chat Completions | Models list/detail |
| `deepseek` | OpenAI-compatible Chat Completions | Not proxied |
| `gemini` | Google's **OpenAI-compatible** Chat Completions | Models list/detail |

Gemini's native `generateContent` API is not supported. Responses support is OpenAI-only;
response retrieval/deletion, embeddings, files, fine-tuning, batches, and token-counting
endpoints are not proxied. Model availability still depends on your provider account.

Custom provider base URLs support compatible deployments such as Ollama, vLLM, or
LiteLLM without adding provider IDs. They require operator opt-in:
`PROVIDER_ENDPOINT_MODE=selfhost` permits HTTP, private addresses, and custom ports;
a comma-separated hostname list permits only listed HTTPS hosts on port 443. Unset/off
refuses custom endpoints. Shape validation is **not full SSRF prevention**: it does not
resolve or pin DNS. Operators must control egress and trust the destination receiving
the provider credential. Upstream redirects are refused, never followed.

### Receipts, statements, and identity evidence

A signed call receipt records the issuer's decision, authentication method, reported
usage/cost, and (when read) a digest of client request bytes. It does not include the
provider response body. Verify it with an explicitly trusted issuer:

```bash
passcontrol verify receipt "<jws>" --issuer https://your-gateway.example
```

The public `/.well-known/jwks.json` publishes instance verification keys;
[the hosted receipt verifier](https://passcontrol.vertias.eu/verify/receipt) and
`/verify/receipt` on your deployment check in the visitor's browser. A valid signature proves that key
signed those bytes. It does not prove the issuer is honest, the provider billed that
amount, or all calls were recorded. Logging/signing is best-effort; absent receipts
prove nothing. Retain old public keys for historical verification when rotating the
instance signer.

**Cloud signed spend statements** commit to a fixed set of receipts using a Merkle root
and link to a preceding statement. Inclusion proofs establish membership in that signed
set. They do not independently audit totals, completeness, or provider invoices. A chain
check needs the relevant earlier statements or a trusted checkpoint. The public self-host
tree ships the format and verification code/page, **not statement production, scheduling,
or statement/proof-serving routes**. See [statement format and limits](./docs/statement-format.md).

Owner binding is per workspace. A typed owner is a declaration; GitHub verification
checks publication of a token in a particular account's repository, and domain
verification checks a well-known HTTPS token. Neither proves a person's legal identity
or trustworthiness. Company registry evidence is also distinct from authority to represent
that company. Only published bindings are attached to public evidence.

![Recorded kill-switch demonstration: subsequent requests are refused](./docs/demo/kill-switch.gif)

The recording illustrates a stop control on successive calls; it does not show cancellation
of an already-dispatched stream.

</details>

## Self-host operations reference

<details>
<summary>Source setup, lifecycle, credential switching, production and portability</summary>

The CLI package declares Node ≥18, but the full stack needs Node 22+: locked Supabase
dependencies need ≥20 and Wrangler needs ≥22. Use `passcontrol setup --no-open` to
suppress browser launch. From a source checkout, the equivalent development path is:

```bash
git clone https://github.com/Vertias3u/PassControl.git
cd PassControl
npm ci
npm run dev:stack
npm run dev:docker
```

Local setup starts Supabase (Postgres + Auth + Vault) and Redis with a REST adapter,
applies migrations, and seeds a local account. It writes `.env.docker`; use
`npm run dev:docker` to load it. This is development setup, not a production deployment.
There are no shared default credentials. `passcontrol setup --app-dir <path>` selects a
checkout; `passcontrol unlink` forgets a remembered one.

Local lifecycle commands manage `http://localhost:3000` independently from the active Cloud API
gateway. `setup`, `start`, and `restart` verify PassControl at `/api/version` and require the
launcher to remain alive before switching the global active gateway. `status` reports the active
API gateway and CLI-managed local dashboard separately; `open` opens the active gateway. Explicit
loopback ports remain supported, but a portless local URL is rejected instead of becoming port 80.
`--port-offset` moves Supabase and Redis ports only; the dashboard remains on port 3000.

Switching from a credentialed remote gateway clears gateway-bound local credentials only—it does
not revoke the remote key or Passport. Interactive use requires a separate confirmation;
noninteractive use requires `--forget-active-credentials`, and `--yes` is not a substitute.
Shell or project-file gateway overrides are refused and named before services start, because a
global write could not override them safely. Clean up any still-active remote identity at its
original gateway.

For production, configure [`.env.example`](./.env.example), use Supabase (plain Postgres
is insufficient), set `DATABASE_URL` in your shell environment and apply the public migrations with
`npm run migrate`,
and build/run the app. Supported paths are Next.js on Vercel, `npm run build` then
`npm start` on a Node host behind a trusted reverse proxy, and the
[Cloudflare/OpenNext build](./docs/deployment/cloudflare.md). Configure Auth/SMTP,
secrets, backups, Redis persistence/no-eviction, and periodic authenticated
`GET /api/cron/reconcile`. A local successful boot does not validate production operations.

| Boundary | Cloud | Public self-host tree |
|---|---|---|
| Gateway, dashboard, auth, budgets, receipts, SDK | Managed deployment | Included; you operate them |
| Provider credentials and request processing | Managed infrastructure | Your infrastructure and chosen upstreams |
| Passport private key | Client-side | Client-side |
| Signed spend statement issuance/proof service | Hosted capability | Verification and format only |
| Invite workflow, hosted quotas and hosted-site operations | Cloud-specific | Not the hosted service |

Workspace portability: `passcontrol export --out workspace.json` saves configuration;
`passcontrol import workspace.json` previews it before an explicit import. The CLI path
does not migrate provider secrets or manufacture verified owner identity. Treat exports
as sensitive configuration and inspect the result for partial/refused items.

[Release updates](https://passcontrol.vertias.eu/updates) and the
[learning center](https://passcontrol.vertias.eu/learn) are hosted-site resources.

</details>

For the full reference, see [API documentation](./DOCUMENTATION.md).
Contributions: [CONTRIBUTING.md](./CONTRIBUTING.md).
