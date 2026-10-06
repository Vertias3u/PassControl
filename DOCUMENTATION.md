# PassControl — API and behavior reference

This reference describes the current implementation. Start with [README](./README.md)
or the [tutorial](./TUTORIAL.md). The public self-host tree contains the gateway,
dashboard, authentication, control API, and artifact verifiers. Cloud's statement
operation and hosted beta machinery are separate; see the statement section below.
This documents the implemented workspace control API; a public developer API has not shipped.

| Surface | Authentication |
|---|---|
| Data plane | Direct Agent Key or Passport-derived work-visa; request proof when required |
| Passport mint | Ed25519 signed challenge; private key stays client-side |
| Control plane | Workspace `pc_…` key with read/write scope |
| Artifact verification | No account; explicitly trusted issuer and public keys |

Base URL (self-host or hosted): `https://<your-gateway>`  ·  all paths below are relative to it.

---

## Authentication

### Developer API keys (control plane)

Create keys in the **Control Tower → API keys**. A key is shown **once**;
we store only its hash. Send it as a bearer token:

```
Authorization: Bearer pc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

- **Scopes:** `read` (GET only) or `write` (full). Pick the least privilege per integration.
- Keys are prefixed `pc_` (so secret scanners catch leaks), revocable instantly, and
  multiple per account.
- **Never** put a key in a URL or commit it. Server-to-server only — don't ship it to a browser.

### Direct Agent Keys (data plane)

A `pc_agent_…` key is a named, reveal-once bearer credential for one agent. It has
optional expiry and independent revocation; only its hash is stored. It is checked
against durable credential/agent state on use, without a credential lookup cache.
Unreadable credential state or its pre-auth protection fails closed. It cannot mint a
visa or authenticate to `/api/control/v1`. Dashboard **Connect an agent** emits the
matching provider-native configuration, and refuses to create a key for a provider with
no stored provider key. The agent page's **Setup** section rebuilds that configuration
later with a placeholder for the key, since only its hash exists; a lost key is replaced
with a new installation key, never recovered. DAK and Passport may coexist on one agent.

### Work-visas (data plane)

Passport clients authenticate to the proxy with a short-lived (normally 5 min) JWT "visa", minted from a signed
challenge (below). Send it the way your provider SDK already sends a key — PassControl accepts
both `Authorization: Bearer <visa>` (OpenAI-style) and `x-api-key: <visa>` (Anthropic-style).

---

## Agent auth flow — mint a visa

`POST /api/auth/challenge`

The agent signs the exact serialized payload bytes with its passport private key:

```jsonc
// body
{
  "payload": "base64url(JSON{ passport_id, ts, nonce })",
  "signature": "base64url(ed25519_sign(payloadBytes))"
}
```

```jsonc
// 200
{ "visa": "<jwt>", "token_type": "Bearer", "expires_in": 300, "jti": "…" }
```

Replay-protected (single-use nonce, ±90s clock window). Rate-limited per IP. Errors:
`401 stale_timestamp | replay_detected | unknown_passport | bad_signature`, `403 agent_not_active | passport_expired`,
`429 rate_limited`.

**You don't normally call this by hand — use the SDK**, which mints, caches, and refreshes
visas for you.

---

## Data plane — proxy a model call

`POST /api/v1/:provider/*path`  ·  `provider` ∈
`openai | anthropic | groq | mistral | together | deepseek | gemini`

It supports the allowlisted inference and model-listing endpoints below: point your existing SDK's
`baseURL` at `…/api/v1/<provider>` and pass the visa as the API key. PassControl accepts the
path shape real SDKs send, then forwards to the provider's canonical upstream path:

| Provider | Accepted client paths | Canonical upstream path |
|---|---|---|
| `openai` | `POST /responses` or `/v1/responses`; `POST /chat/completions` or `/v1/chat/completions`; `POST /embeddings` or `/v1/embeddings`; `GET /models` or `/v1/models`; `GET /models/{id}` or `/v1/models/{id}` | `/v1/responses`; `/v1/chat/completions`; `/v1/embeddings`; `/v1/models`; `/v1/models/{id}` |
| `groq` | `POST /chat/completions` or `/v1/chat/completions`; `GET /models` or `/v1/models`; `GET /models/{id}` or `/v1/models/{id}` | `/v1/chat/completions`; `/v1/models`; `/v1/models/{id}` |
| `mistral` | `POST /chat/completions` or `/v1/chat/completions`; `POST /embeddings` or `/v1/embeddings`; `GET /models` or `/v1/models`; `GET /models/{id}` or `/v1/models/{id}` | `/v1/chat/completions`; `/v1/embeddings`; `/v1/models`; `/v1/models/{id}` |
| `together` | `POST /chat/completions` or `/v1/chat/completions`; `GET /models` or `/v1/models`; `GET /models/{id}` or `/v1/models/{id}` | `/v1/chat/completions`; `/v1/models`; `/v1/models/{id}` |
| `anthropic` | `POST /v1/messages`; `GET /models` or `/v1/models`; `GET /models/{id}` or `/v1/models/{id}` | `/v1/messages`; `/v1/models`; `/v1/models/{id}` |
| `deepseek` | `POST /chat/completions` or `/v1/chat/completions` | `/chat/completions` |
| `gemini` | `POST /chat/completions` or `/v1/chat/completions`; `GET /models` or `/v1/models`; `GET /models/{id}` or `/v1/models/{id}` | `/chat/completions`; `/models`; `/models/{id}`, appended to `https://generativelanguage.googleapis.com/v1beta/openai` |
| `xai` | `POST /responses` or `/v1/responses`; `GET /models` or `/v1/models`; `GET /models/{id}` or `/v1/models/{id}` | `/v1/responses`; `/v1/models`; `/v1/models/{id}`, appended to `https://api.x.ai` |
| `azure` | `POST /chat/completions` or `/v1/chat/completions`; `POST /responses` or `/v1/responses`; `POST /embeddings` or `/v1/embeddings`; `GET /models` or `/v1/models` | `/chat/completions`; `/responses`; `/embeddings`; `/models`, appended to the resource address stored with the key (`https://<resource>.openai.azure.com/openai/v1`) |
| `local` | `POST /chat/completions` or `/v1/chat/completions`; `GET /models` or `/v1/models` | `/chat/completions`; `/models`, appended to the server address stored with the credential (`http://localhost:11434/v1` for Ollama) |

**OpenAI server-side tools are refused.** OpenAI bills its hosted tools per call or per
session, outside token usage: web search, file search, code interpreter containers, and the
others. A budget that counts tokens cannot hold those charges, and a receipt would understate the
call. So an `openai` request is refused with 400 `server_side_tools_unsupported` before anything
is reserved or sent when it carries any of these:
- a `tools` entry that is not one the agent runs itself. Allowed: `function`, `custom`,
  `namespace` (of functions and custom tools), `computer`, `computer_use_preview`, `local_shell`,
  `apply_patch`, `shell` with `environment: {"type": "local"}`, and `tool_search` with
  `execution: "client"`. Anything else is refused, including a tool type OpenAI adds later;
- Chat Completions' `web_search_options`;
- a stored Responses `prompt`, which carries its own tools that PassControl cannot see.

The search models, `gpt-4o-search-preview` and `gpt-4o-mini-search-preview`, search on every call
and are refused as `blocked_endpoint`, including in the decision trace. A failover into OpenAI is
skipped for any such request. The refusal is answered, not logged, like any other malformed
request, so it does not appear in the activity feed.

OpenAI Responses supports buffered and streaming POST requests. It uses `input` and
`max_output_tokens`; terminal completion and valid usage determine whether accounting
is complete. Retrieval/deletion of stored responses is not allowlisted. Gemini uses
Google's OpenAI compatibility API, not native `generateContent`. DeepSeek model listing
is not proxied even though credential setup may probe its upstream model endpoint.

OpenAI, Mistral and Azure embeddings are governed like any other billed call. The request's `model` must be in
the visa's scope, the budget hold reserves the input alone because nothing is generated, and
the provider's `usage.prompt_tokens` settles it. The response is forwarded as it arrives rather
than buffered, so a large batch is not held in the gateway; a body that ends without one
top-level `usage` report is charged its estimate. `stream: true` is refused with 400
`stream_unsupported`. A `max_output_tokens` policy ceiling does not apply to embeddings.

An embeddings call **never fails over**, and a failed one names no alternative provider. A
fallback runs with its own model, and vectors from a different model live in a different
space (usually with a different length), so they would not match what the agent has already
stored. The primary's own error is returned instead.

Other providers' embeddings endpoints are not proxied. Together's and Gemini's
OpenAI-compatible embeddings responses carry no usage report, so every call could only be
charged a characters ÷ 4 guess, which can be below the real bill.

xAI is served through its **Responses API only**; its legacy Chat Completions endpoint is
refused as `blocked_endpoint`. Three things differ from OpenAI:
- **Output is billed as `total_tokens − input_tokens`.** xAI's own reference example reports
  reasoning tokens outside `output_tokens`, so reading `output_tokens` alone would miss most of a
  reasoning call. A usage report without `total_tokens` is treated as unknown and charged its
  estimate.
- **Server-side tools are refused** with 400 `server_side_tools_unsupported`, before anything is
  reserved or sent. That covers any `tools` entry whose `type` is not `function`, and any
  `search_parameters`. xAI bills web search, X search and code execution per call or per item
  fetched, outside tokens, so no budget here could hold them. Function tools, which the agent
  runs itself, pass. A failover into xAI is skipped for such a request.
- **Set `max_output_tokens`.** xAI defaults it to 128,000, and its reasoning models cannot turn
  reasoning off. Without a stated limit, the pre-call reservation (1024 output tokens) is far
  below what a call can generate, so a spend cap is only a reliable bound together with a policy
  output ceiling, which xAI requests must then state in `max_output_tokens`.

Not covered for xAI: an out-of-credit response is not recognised as one, so it never triggers
the `provider_credit_exhausted` answer; the MCP server's chat tool does not support it; xAI's
$0.05 usage-guideline violation fee has no token count and is not recorded. Prices use xAI's
long-context (≥ 200k prompt) rates, without the cached-input discount.
`grok-4.20-multi-agent` bills every agent's tokens in its `usage` (xAI's docs), but xAI does not
say whether `max_output_tokens` bounds its sub-agents, so an output ceiling may not bound that
model. Leave it out of an agent's scope if that matters (the default `grok-*` includes it).

Azure OpenAI is served through its **v1 API** (`/openai/v1`, no `api-version` needed). It is the
one provider with no host of PassControl's own: each Azure key is stored **with its resource
address**, and the key is only ever sent there.
- **The address rule.** `https://<resource>.openai.azure.com/openai/v1` or
  `https://<resource>.services.ai.azure.com/openai/v1`: HTTPS on 443, one resource label, nothing
  after `/openai/v1`. It is checked when the key is stored and again on every call, in every
  `PROVIDER_ENDPOINT_MODE`, hosted Cloud included; self-host's wider custom-endpoint rules do not
  apply to an Azure key. The portal's bare `https://<resource>.openai.azure.com/` is refused
  with the full address to use instead.
- **A key with no usable address is refused** with 409 `endpoint_required` before the key is
  read, and logged as such. The gateway never picks a host for it. Set the address on that key
  under Settings, Provider keys, Endpoint; do not add a second key. Azure keys are added there
  too: the key-import on-ramp does not ask for an address, so it does not offer Azure.
- **Unpriced.** A deployment name does not say which model or price is behind it, so Azure calls
  are logged with token counts and no cost, and an agent with a dollar limit (cumulative or
  periodic) is refused with 402 `unpriced_endpoint` before anything is reserved. Token limits
  apply as usual.
- **Scope matches the deployment name** the request sends as `model`. The default is `gpt-*`.
- **Hosted tools are refused** exactly as for OpenAI. The key is injected as `api-key`, redirects
  are refused, and a key echoed back is scrubbed.
- **Client.** Use the plain OpenAI client with the base URL `…/api/v1/azure/v1`, not
  `AzureOpenAI`: that class sends the credential as `api-key`, which the gateway does not read an
  agent credential from.

Not covered for Azure: Entra ID (bearer) authentication to the resource, the legacy
`/openai/deployments/<name>/…` API, and an out-of-credit signature (a quota 429 is not
recognised as one). An embeddings call still never fails over, including from OpenAI to Azure.

`local` is a model server you run yourself and that speaks OpenAI's API: Ollama, LM Studio,
vLLM. Like Azure it has no host of PassControl's own, so each `local` credential is stored
**with its server address**, and a credential without one is refused with 409
`endpoint_required` before its key is read. Unlike Azure, nothing admits that address except
`PROVIDER_ENDPOINT_MODE`: where it is off (hosted Cloud, and the code default) every `local`
call is refused that way, and the dashboard does not offer `local` at all.
- **Use Ollama.** On the local stack, Settings, Provider credentials shows *Models on this
  machine*. Its button asks Ollama at `http://localhost:11434/v1` for its models and, only if it
  answers, stores a `local` credential with no key and that address. The agent wizard then
  offers the server's models.
- **A key is optional.** An empty key is stored as "send none", and the gateway forwards no
  credential header. A key you do give is sent as `Authorization: Bearer` (vLLM's `--api-key`).
- **Unpriced, and free of estimates.** Calls are logged with token counts and no cost, the
  receipt says `prov: "local"` and `unp: true`, and nothing is charged to the agent's spend. An
  agent with a dollar limit is refused with 402 `unpriced_endpoint`; use a token limit.
- **Chat and model listing only.** The server's own admin API (Ollama's `/api/pull`, `/api/delete`)
  is never reachable through an agent key. Embeddings are not served on `local` yet.
- **Client.** The OpenAI client with the base URL `…/api/v1/local/v1` and the agent's key.
- **Scope** defaults to `*`: any model on that server, since the agent can only run models, not
  manage the server. Narrow it to exact names if that matters.

The packaged SDK uses `/api/v1/<provider>` as its base. For a static OpenAI-compatible
client, use the exact URL printed by **Connect an agent** or `passcontrol env`; the
accepted aliases above accommodate clients that append `/v1` and those that do not.


`GET .../models` is **narrowed to the visa's scope**: PassControl forwards to the provider,
then removes the entries this agent may not call. The rows that survive are the provider's own,
with their fields preserved — the filtered JSON is reserialized — and an unrecognised response shape
passes through untouched. Without it the listing answers with everything the *provider key* can
reach, which is the tenant's whole account rather than the agent's capability, so an SDK's model
picker offers choices guaranteed to be refused on first use. This is presentation of a boundary
the gate already enforces, not the enforcement itself.

`GET .../models/{id}` retrieves one model's metadata. It is read-only, returns strictly less
than the listing beside it, and — like the listing — carries no model to run inference on, so
it is exempt from the per-model scope check and gated by this allowlist alone. It is **not**
narrowed: discovery is scoped, an explicit lookup is not — the caller already knows the name, and
it still cannot *call* an out-of-scope model. Exactly one
extra segment is accepted, and it is URL-encoded into the upstream path, so it can only ever
be a model id and never a route into anything else. Agent SDKs call it to detect a model's
context length; without it that probe is refused around every prompt.

Both discovery paths accept the `v1`-less spelling on **every** provider that serves them,
including `anthropic`, because a client pointed at a base URL that already ends in `/v1` sends
the short one and a client pointed at the host sends the long one — and it cannot know which we
accept. Chat is not treated this way: `anthropic` still takes `POST /v1/messages` alone. Listing
runs no model and spends nothing, so being generous about how a client spells it costs nothing;
being generous about how it spells inference would widen what actually bills.

Endpoints outside that allowlist are denied by default. The gateway does **not** proxy
embeddings on providers other than OpenAI, Mistral and Azure, files, fine-tuning, batches, response retrieval/deletion, or token-counting endpoints. PassControl
verifies the visa → checks kill switch → checks scope → checks endpoint allowlist → reserves
budget → injects your real provider key → streams the response back, and attempts to log the call. It does not return the injected provider key.

Errors: `401 missing_visa | invalid_visa | invalid_credential | passport_secret_presented_as_bearer`, `503 blocked_budget_state`, `402 blocked_budget`, `402 blocked_budget_period` (with `retry-after` to the next UTC period boundary), `403 blocked_policy` (an output-ceiling refusal adds `rule: "max_output_tokens"`, `reason` and `limit` to the body and an `x-passcontrol-policy-rule` header), `403 blocked_suspended |
blocked_scope | blocked_endpoint`, `404 unknown_provider`, `413 payload_too_large`,
`429 rate_limited`, `502 upstream_unreachable`. `429 rate_limited` also answers a client IP that
has sent too many FAILED visas in a window (`VISA_FAIL_IP_LIMIT`, default 60 per 60 s); valid visas
are never counted by that limiter.

The proxy kill/suspend gate answers `403 blocked_suspended` for either cause, so a caller cannot
probe which control stopped it. Your **audit log** does distinguish them:
`blocked_killed` for the kill switch (platform, tenant, or denylist) and `blocked_suspended`
for a per-agent suspend. Invalid/revoked Direct Agent Keys can instead fail authentication with `401 invalid_credential`. Check `passcontrol logs` or the Control Tower when you need to know
which one fired.

---

## Data plane — call GitHub through the gateway

An agent can call the GitHub REST API through PassControl the way it calls a model: the
workspace's GitHub token is stored in Vault and injected by the gateway, so the agent never
holds it, and every call goes through the agent's identity, the kill switch and a signed
receipt.

```
GET|POST|PUT|PATCH|DELETE /api/v1/svc/github/<GitHub REST path>
Authorization: Bearer <work-visa or Direct Agent Key>
```

Point a GitHub client's base URL at `https://<gateway>/api/v1/svc/github` and give it the
agent's **PassControl** credential in place of a GitHub token. This route reads it from
`Authorization: Bearer <key>`, `x-api-key: <key>`, or GitHub's own `Authorization: token <key>`
(checked in that order, so `token` is used only when neither of the others is sent). With
Octokit, the `auth` option is enough:

```js
const octokit = new Octokit({
  baseUrl: "https://<gateway>/api/v1/svc/github",
  auth: process.env.PASSCONTROL_AGENT_KEY, // the agent's key, not a GitHub token
});
```

The `token` scheme is read on this route only; the model routes accept `Bearer` and
`x-api-key` as before. A real GitHub token sent here is refused with `401` and never
forwarded: the gateway sends GitHub only the workspace's stored token.

Through the local sidecar, `passcontrol env github` prints `GITHUB_API_URL` for the bridge;
there the client sends no credential at all, because the sidecar adds the visa.

**Setup, in the dashboard:**
1. **Settings → Services:** add a GitHub token. Use a fine-grained token limited to the
   repositories your agents need, with read-only permissions unless an agent's rules need a
   write (then grant just that permission, for example Issues: read and write). The token is
   the ceiling of what any agent can reach.
2. **Each agent's page → GitHub access:** name the repository (`owner/name`, or paste its
   github.com link) and tick what the agent may do: *Read code, issues and pull requests*,
   *Open issues*, *Comment on issues and pull requests*, *Open pull requests*. Each choice
   writes ordinary rules, shown in the table below; anything else goes under **Advanced:
   custom rules**, one method and path per rule. Access is **deny by default**: an agent
   with no rules cannot make a single GitHub call.

   | Choice | Rules it writes |
   |---|---|
   | Read code, issues and pull requests | `GET /repos/<owner>/<name>` and `GET /repos/<owner>/<name>/**` |
   | Open issues | `POST /repos/<owner>/<name>/issues` |
   | Comment on issues and pull requests | `POST /repos/<owner>/<name>/issues/*/comments` |
   | Open pull requests | `POST /repos/<owner>/<name>/pulls` |

**An agent that calls no model.** In **Connect an agent**, choose *Only services*.
The agent is created with no model access, so every model call it makes is refused, and no
provider key is needed. The key reveal and the agent's Setup show the configuration for
each service (GitHub, Telegram, Brave Search, Notion, Discord) instead of a model SDK. **Issue passport** has the same choice: the
passport is issued with no model access, and its setup wires Octokit through the SDK's
visa-refreshing `fetch` (`new Octokit({ baseUrl, request: { fetch: passcontrol.fetch } })`)
or points a static-key tool at the local sidecar (`passcontrol env github`). Its visa
carries an empty scope, and its service rules decide.

**Rules.** Each rule is a method and a path: `GET` (`HEAD` follows `GET`), `POST`, `PUT`,
`PATCH` or `DELETE`. `*` matches exactly one path segment. `**` matches one or more trailing
segments, only as the last segment and **only on a `GET` rule**: a write rule names its path
exactly. Query strings are not matched. For example, `GET /repos/acme/*/issues` lets the
agent list issues in any `acme` repository, and `POST /repos/acme/web/issues/*/comments`
lets it comment on issues in `acme/web` and nothing else. A write rule admits only the
method it names. Rules are read on
every call, so removing one stops the next call. A rule set the gateway cannot read, or
cannot validate, refuses every call to that service; it never falls back to allowing.

**Limits.** Each agent has an hourly GitHub call cap (default 500, set with the rules). A
GitHub call has no price, so it sits outside the agent's dollar limit and says so: its
receipt carries `unp: true` and `cls: "svc"`. The agent's model policy (deny rules, time
windows, its own hourly counter) does not apply to service calls; the GitHub rules are the
whole scope. The per-agent gateway request limit is shared with model calls.

**What the gateway does on the wire.** It sends only `accept`, `x-github-api-version`,
`if-none-match` and `content-type` from the agent (never a method-override header), sets its
own `User-Agent`, and never follows a redirect: a
redirect to another host (archive downloads go to `codeload.github.com`) is handed to the
agent to follow without the token. Pagination `link` URLs are rewritten to keep the path the
agent asked for, so page 2 of an allowed list is allowed. Response headers are limited to
content type, `etag`, `retry-after` and GitHub's rate-limit headers; `x-oauth-scopes`, which
names everything the workspace token can do, is not passed back. A token that appears in a
response body is redacted.

**Writes.** A write's body is read only after the call is admitted, so a refused write is
never read. It must be JSON (`415 unsupported_media_type` otherwise) and at most 1 MiB
(`413 payload_too_large`). It is sent to GitHub exactly as received, once, with no retry,
and its SHA-256 digest is signed into the receipt (`req`), so the receipt proves what was
written. The body itself is never logged.

**Refused whatever the rules say** (`403 service_endpoint_refused`):
- GitHub's GraphQL API (`/graphql`). It is one endpoint that can do anything the token can,
  so a path rule cannot scope it.
- Writes that change who can reach your repositories or whether they exist: deleting a
  repository, or changing its name, visibility, archive state or default branch
  (`DELETE`/`PATCH /repos/{owner}/{repo}`); transfers, collaborators, invitations, deploy keys,
  branch and tag protection, rulesets and environments.
- Webhooks (`/repos/{owner}/{repo}/hooks`): one would send every event to an address the agent
  chose.
- Secrets and variables (Actions, Dependabot, Codespaces), Actions permissions, runners and
  OIDC settings.
- Dismissing security alerts or turning security features off (secret scanning, code
  scanning, vulnerability alerts, automated security fixes, private vulnerability reporting).
- Any write to an account, organization, team, OAuth app or token (`/user`, `/orgs`,
  `/teams`, `/authorizations`, `/applications` and similar).
- Writing anything under `.github/` through the contents API: workflow files run code with
  the repository's secrets, and the folder also holds the local actions they run and
  `CODEOWNERS`.
- Updating, deleting or renaming an existing branch or tag (`PATCH`/`DELETE
  /repos/{owner}/{repo}/git/refs/...`, including a force update, and `POST
  .../branches/{branch}/rename`). Creating a branch (`POST .../git/refs`) is left to the rules.

The git data API (trees, commits, new refs) can also carry a workflow file inside a new
commit. GitHub requires the token's **Workflows** permission for that, so leave that
permission off the token: it is the ceiling there.

These are matched however the path is cased, and through both forms GitHub serves a
repository by: `/repos/{owner}/{repo}` and the numeric `/repositories/{id}`. Reads of the same
paths are not refused. The
dashboard refuses to save a write rule that could only ever reach this list.

**Known limits.** Next.js removes a client's own `path`
and `service` query parameters before the gateway sees them, so those two GitHub parameters
(for example the commits endpoint's `path` filter) cannot be sent through this route.

## Data plane — call Telegram through the gateway

An agent can call the Telegram Bot API through PassControl. The workspace's bot token is
stored in Vault and put into the request by the gateway, so the agent never holds it.

```
GET|POST /api/v1/svc/telegram/<methodName>
Authorization: Bearer <work-visa or Direct Agent Key>
```

Telegram puts the bot token in the URL (`https://api.telegram.org/bot<token>/<method>`), so
the agent calls `/api/v1/svc/telegram/sendMessage` and the gateway builds that URL itself.
Parameters go where Telegram accepts them: the query string, a JSON body, or a form body
(`application/x-www-form-urlencoded`).

Through the local sidecar, `passcontrol env telegram` prints `TELEGRAM_API_URL` for the bridge;
the client then calls `$TELEGRAM_API_URL/<method>` with no credential at all.

**Setup, in the dashboard:**
1. **Settings → Services:** add the bot token BotFather gave you. It must have Telegram's
   shape (the bot's number, a colon, then the secret); anything else is refused, because the
   token goes into a URL. Use a bot made for your agents.
2. **Each agent's page → Telegram access:** tick *Read messages sent to the bot* (`getMe`
   and `getUpdates`) and *Send messages* (`sendMessage`), or add other Bot API methods under
   **Advanced: custom rules**, one per rule.

   Once the token is stored, **Connect an agent** shows those two choices and *Ask me first
   before each send* already ticked, so a new agent can use the bot straight away, with every
   send waiting for your approval. Untick any of them before creating the agent; an agent
   created without them has no Telegram access. A call no rule admits is refused with
   `403 service_call_not_allowed`, and its message links to that agent's access panel.

**Rules.** A Telegram rule names one method: `{ "call": "sendMessage" }`. Method names are
matched in any case, as Telegram does, over `GET` or `POST`; the HTTP verb decides nothing,
because Telegram accepts both for every method. There are no wildcards.

**Refused whatever the rules say** (`403 service_endpoint_refused`): `setWebhook`,
`deleteWebhook`, `logOut` and `close` (each would hand the bot's updates to someone else or end
its session), and file downloads (`/file/...`), whose URL carries the token.

**Known limits.**
- A rule for `sendMessage` reaches any chat the bot is in: the chat is chosen in the request,
  not the rule.
- Agents that share one bot share its `getUpdates` queue, so one agent's call consumes updates
  another was waiting for.
- Uploads (`multipart/form-data`) are refused with `415`; send a file by URL or `file_id` in
  JSON instead.
- Only a request BODY is bound into the receipt (`req`). A call that passes its parameters in
  the query string, such as `GET /sendMessage?chat_id=…&text=…`, is recorded and receipted,
  but what it sent is not; use `POST` with a JSON body where that matters.
- The gateway gives Telegram 30 seconds to answer. A `getUpdates` long poll longer than that
  is cut off and recorded as an upstream error; keep its `timeout` parameter at 25 or less.
- The `link` and `location` headers are never passed back, since Telegram's URLs carry the
  token. A token that ever appears in a response body is redacted.

Everything else is as for GitHub: the hourly call cap (default 500), the per-service stop on
the Services page, and receipts with `cls: "svc"`, the request digest for a body, and the
method name as the path, never the URL.

Errors: `401` as for model calls, `403 blocked_suspended`, `403 service_call_not_allowed`
(no rule matched; the body names the method and path), `403 service_rules_invalid`,
`403 service_endpoint_refused`, `404 unknown_service`, `400 invalid_path`,
`409 no_service_credential`, `429 service_rate_limited` (with `retry-after`),
`429 rate_limited`, `503 service_rules_unavailable | service_rate_limit_unavailable |
credential_unavailable`, `502 upstream_unreachable`. A GitHub error is passed through with
GitHub's own status and body.

---

## Data plane — search with Brave Search through the gateway

An agent can search through Brave's Search API with the workspace's key, which the gateway
injects as `X-Subscription-Token`, so the agent never holds it.

```
GET /api/v1/svc/brave/<path>?<Brave's query parameters>
Authorization: Bearer <work-visa or Direct Agent Key>
```

The gateway pins Brave's `/res/v1`, so the agent's path starts after it:
`/api/v1/svc/brave/web/search?q=…` reaches `https://api.search.brave.com/res/v1/web/search?q=…`.
Through the local sidecar, `passcontrol env brave` prints `BRAVE_SEARCH_API_URL` for the bridge.

**It costs money.** Brave bills every search to the card on the Brave account, with no spending
limit on Brave's side. PassControl's hourly call cap is therefore the bill guard, and for Brave
it defaults to **30 calls an hour per agent** (other services: 500) unless the agent's rules
set their own `max_requests_per_hour`.

**Setup, in the dashboard:**
1. **Settings → Services:** add the Brave Search API key.
2. **Each agent's page → Brave Search access:** tick *Search the web* (`GET /web/search`),
   *Fetch search context for a model* (`GET /llm/context`) or *Look up local places*
   (`GET /local/pois`, `GET /local/descriptions`), or add other GET paths under
   **Advanced: custom rules**.

**Refused whatever the rules say** (`403 service_endpoint_refused`): every method but `GET` and
`HEAD` (Brave Search is read-only), and `chat/completions`, Brave's token-billed answer endpoint,
which is an LLM call and belongs on the model gateway.

Everything else is as for GitHub: rules, the per-service stop on the Services page, receipts
with `cls: "svc"`, and the same error codes.

---

## Data plane — call Notion through the gateway

An agent can call Notion's API with the workspace's integration token, which the gateway sends
as `Authorization: Bearer`, so the agent never holds it.

```
GET|POST|PATCH|DELETE /api/v1/svc/notion/v1/<path>
Authorization: Bearer <work-visa or Direct Agent Key>
Notion-Version: <the version your code was written for>
```

Paths keep `/v1`, exactly as Notion's SDK sends them, so `@notionhq/client` works unchanged:
`new Client({ baseUrl: process.env.NOTION_API_URL, auth: <agent key> })`. The agent's
`Notion-Version` header is forwarded and never set by the gateway; Notion refuses a request
without one. Through the local sidecar, `passcontrol env notion` prints `NOTION_API_URL`.

**What the token reaches is decided in Notion:** only the pages and databases shared with the
integration. Share only what your agents need.

**Setup, in the dashboard:**
1. **Settings → Services:** add the internal integration's token (`ntn_…`).
2. **Each agent's page → Notion access:** tick *Search and read pages and databases*, *Create
   pages*, *Edit page content and properties* or *Comment*, or add rules under **Advanced:
   custom rules** (paths start with `/v1/`).

Some Notion reads are `POST`s (`/v1/search`, `/v1/data_sources/{id}/query`,
`/v1/databases/{id}/query`, `/v1/views/{id}/queries`, the meeting-notes, agents and sessions
queries); the Services page counts a rule for one of these as a read.

**Refused whatever the rules say** (`403 service_endpoint_refused`): any path outside `/v1`,
the OAuth endpoints (`/v1/oauth/...`, which use the integration's client secret), file uploads
(multipart; attach files by URL instead), and running, changing or deleting Notion's own AI
agents (`POST /v1/sessions` spends the workspace's Notion AI credits). Moving a page or block
to the Trash (`DELETE /v1/blocks/{id}`) is left to the rules, because Notion keeps it
restorable.

Everything else is as for GitHub: the hourly call cap (default 500), the per-service stop on
the Services page, receipts with `cls: "svc"`, and the same error codes.

---

## Data plane — call Discord through the gateway

An agent can act as the workspace's Discord bot. The gateway sends the bot token as
`Authorization: Bot <token>`, with the User-Agent Discord requires, so the agent never holds it.

```
GET|POST|PUT|PATCH|DELETE /api/v1/svc/discord/v10/<path>
Authorization: Bearer <work-visa or Direct Agent Key>
```

Paths keep the API version, as discord.js builds them, and reach `https://discord.com/api/v10/…`.
Only `v10` is served: an unversioned path would reach Discord's default, v6. discord.js sends
`Authorization: Bot <token>` by default, so with a Direct Agent Key set it to `Bearer`:

```js
const rest = new REST({ api: process.env.DISCORD_API_URL, version: "10", authPrefix: "Bearer" })
  .setToken(process.env.PASSCONTROL_AGENT_KEY);
```

Through the local sidecar, `passcontrol env discord` prints `DISCORD_API_URL`; the sidecar
replaces whatever token the client sends, so `setToken("sidecar")` with the default prefix works.

**What the token reaches is decided in Discord:** the servers the bot was invited to, with the
permissions it was given there.

**Setup, in the dashboard:**
1. **Settings → Services:** add the bot token from the Developer Portal (Bot → Reset Token).
2. **Each agent's page → Discord access:** enter one channel (its ID, or a
   `discord.com/channels/…` link) and tick *Read messages in the channel*, *Send messages to the
   channel*, *Add reactions* or *Start threads*, or add rules under **Advanced: custom rules**.

**Refused whatever the rules say** (`403 service_endpoint_refused`), written from Discord's route
tables:
- every webhook route, reads included (a webhook's details carry its own token), interactions
  and OAuth2;
- changing or deleting a server or a channel; roles, member roles and channel permissions;
  kicks, bans, bulk bans and prunes; auto-moderation, onboarding, welcome screen, widget,
  incident actions and integrations; creating or reordering a server's channels;
- invites, channel followers, group DM members and bulk message deletion;
- the bot's own account (renaming it, leaving a server, role connections) and the application
  (commands, entitlements), and lobbies.

Sending, editing and deleting single messages, reactions, pins, threads, opening a DM and the
bot's own nickname are left to the rules. Uploads (`multipart/form-data`) are refused with
`415`; send attachments by URL.

Everything else is as for GitHub: the hourly call cap (default 500), the per-service stop on
the Services page, receipts with `cls: "svc"`, and the same error codes. Discord's
`X-RateLimit-*` and `Retry-After` headers are passed back.

---

## Data plane — "Ask me first": approve a service call before it is sent

Any service rule can ask the owner before the call it admits is sent. On an agent's page,
in a service's access panel, tick **Ask me first before each write** (every rule the service
counts as a write: GitHub, Notion and Discord's non-GET methods, Telegram's methods that do
not start with `get`), or tick **Ask me first** on one custom rule, read rules included.
Stored as `"ask": true` on the rule:

```json
{ "discord": { "allow": [{ "method": "POST", "path": "/v10/channels/123/messages", "ask": true }] } }
{ "telegram": { "allow": [{ "call": "sendMessage", "ask": true }] } }
```

`ask` is a boolean or absent (absent means no). Any other value makes that service's rules
invalid, so every call to it is refused with `403 service_rules_invalid`, as for any rule
this build does not understand. Turning it on or off changes the receipt's `pol`.

**What happens to the call.** After the rules, the hourly cap and reading the body, and
before the token is decrypted:
1. The gateway takes a fingerprint of exactly what it would send: method, path, the
   forwarded query, the forwarded headers and the body.
2. The first time it sees that fingerprint, it opens a question, sends the owner a prompt,
   and holds the call for up to 15 seconds in case the answer comes quickly.
3. Approved in time: the call is sent. Otherwise the agent gets
   `409 approval_pending` with `retry-after: 15`. Sending the **same** request again finds
   the answer.

An approval admits that exact request **once**, within 10 minutes of the answer. A changed
body, query or header is a new question. If **any** rule admitting a call asks, the call is
held, whichever rule is listed first. The owner approves what they can read: the Approvals
page shows the whole query and body, and a call with more than 16 KB of them is refused with
`413 approval_body_too_large` instead of being asked about. Two identical retries racing get one admission
between them. A question nobody answers expires after 15 minutes. A denial answers every
retry with `403 approval_denied` for 15 minutes.

**Where the owner answers:**
- **Dashboard → Approvals.** Every open question, with the method, path and the start of
  the body. Approve or Deny there.
- **Telegram alerts** get **Approve** and **Deny** buttons on the message. Taps are read by
  polling the bot's `getUpdates`, so no public webhook is needed and it works on a
  localhost self-host. A tap decides only if it comes from the message PassControl sent, in
  the chat it sent it to, still showing the text it was sent with. If the request is too
  long for the message (over 1,500 characters of query and body), the message says how much
  is left out and offers only **Deny**: approve it on the Approvals page. An `@` in the
  request shows as `＠`, so it pings nobody but stays visible.
- **Give PassControl's alerts their own bot.** An agent whose Telegram rules use the same
  bot could take the taps through `getUpdates`, or edit the question's text through
  `editMessageText`. An edited question is refused, so the result is a question you
  answer in the dashboard, but it is still interference you can avoid. A bot with a
  webhook set cannot be polled, so its questions are answered in the dashboard.
- **Slack and Discord alerts** get the request and a link to the Approvals page: an incoming
  webhook cannot carry buttons that answer back.
- **No alert destination:** the Approvals page only.

Prompts are sent whatever alert kinds are ticked, and are not throttled: one per question.
They contain the agent's name, the service, the method, the path and the start of the query
and body (up to 1,500 characters on Telegram, 900 on Slack and Discord), so that text reaches
your alert service.

Errors: `409 approval_pending` (with `retry-after`), `403 approval_denied`,
`413 approval_body_too_large`,
`429 approval_queue_full` (20 open questions per workspace), and
`503 approval_unavailable`. If the approval store cannot be read, the call is refused:
an ask rule exists to keep a human in the way. Each held retry counts against the hourly
call cap. Audit rows record held and denied calls as `blocked_policy`. Answers given in the
dashboard are recorded in the admin audit as `approval.decide`. LLM calls cannot be held for
approval yet.

---

## SDK quickstart

The client SDK hides visa minting/refresh so integration is re-pointing your SDK, not rewriting
your agent. The compiled ESM SDK ships in the `passcontrol` npm package at `passcontrol/sdk`.
Its TypeScript source is in `sdk/`.

```ts
import OpenAI from "openai";
import { PassControl } from "passcontrol/sdk";

const pc = new PassControl({
  gateway: process.env.PASSCONTROL_GATEWAY!,
  passportId: process.env.PASSPORT_ID!,        // base64url Ed25519 public key
  passportSecret: process.env.PASSPORT_SECRET!,// base64url Ed25519 private key (stays local)
});

const openai = new OpenAI(pc.clientOptions("openai")); // baseURL + fetch wired
await openai.chat.completions.create({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] });
```

Anthropic is identical with `pc.clientOptions("anthropic")`. The SDK caches the visa, refreshes
before expiry, single-flights concurrent mints, and retries once on a 401 when the effective body is replayable. It does not generate sender proofs.

For third-party agents that expect a static key, run the visa sidecar and point the agent at
`http://127.0.0.1:8788/api/v1/<provider>` with any API key value. CLI presets print the
right variables/settings:

On Windows, run these shell commands in PowerShell. Replace placeholders before running.

```bash
passcontrol env openhands
passcontrol env aider
passcontrol env cline
passcontrol env continue
passcontrol env litellm
passcontrol env hermes
```

Hermes uses its current `custom` model provider. The printed YAML points at the
local sidecar and uses `api_key: passcontrol` as a placeholder; the real provider
key never enters Hermes.

Desktop chat apps work the same way, and are the case where the sidecar earns its keep:
each of these normally stores a raw provider key in local app storage.

```bash
passcontrol env chatbox
passcontrol env jan
passcontrol env msty
passcontrol env cherry-studio
passcontrol env open-webui
passcontrol env librechat
```

These print configuration fields for the client; check the emitted provider-native URL. The placeholder API key is replaced by the sidecar.

### `configure` vs `env`

Both accept the same integrations — the coding agents and desktop apps above, the catch-all
`generic`, plus the MCP clients `claude-desktop`, `cursor` and `claude-code` — and differ
only in what they do
with the result. Run `passcontrol env` with an unknown name to print the authoritative list;
it is generated from the CLI's own preset table, so it cannot drift from what is accepted:

- **`passcontrol configure <integration>`** is the one to reach for. It previews the config,
  and `--write` creates it for the three integrations that own a config file
  (`aider`, `claude-desktop`, `cursor`). For the others `--write` is refused with the reason,
  rather than accepted and silently ignored.
- **`passcontrol env <integration>`** only ever prints. It never writes and takes no
  `--write`.

For the MCP targets the two print different things: `configure` shows the client config file
it would merge into, `env` prints just the `mcpServers` JSON.

Continue: OpenAI `/responses` is supported, so the old instruction to set
`useResponsesApi: false` is no longer required. It remains a valid compatibility choice
in your own Continue config — the CLI does not set it for you: `passcontrol env continue`
prints only a base URL, an API key, and a model. Other provider IDs do not acquire
Responses support.

---

## MCP integration

The CLI exposes a local stdio MCP server with governed `chat` and `list_models` tools. Keep
the passport in the global PassControl profile; generated client configs contain only the
absolute Node executable and CLI path:

```bash
passcontrol login                              # or `passcontrol init --global` to do it by hand
passcontrol configure claude-desktop --write   # or: cursor
# Claude Code: passcontrol configure claude-code prints the CLI-managed add command
```

Restart the client after configuration. Every `chat` invocation uses the normal challenge
and proxy flow, so scope, budget, endpoint allowlisting, suspension, and kill switches still
apply. Use `passcontrol env claude-desktop` or `passcontrol env cursor` to print the
secret-free `mcpServers` JSON without writing it.

---

## Control plane — manage your fleet

Base: `/api/control/v1` · `Authorization: Bearer pc_…` · JSON · responses carry `X-Request-Id`.

API-key creation/revocation is available in the Control Tower. The control-plane API
includes tenant-scoped agent lifecycle, logs, audit, spend, and kill-switch endpoints, with
`Idempotency-Key` support on writes.

### Conventions
- **Versioning:** URI (`/v1`); breaking changes → `/v2`.
- **Pagination:** list endpoints clamp `?limit=` to 1–100 (default 50). There is no cursor
  parameter on most list endpoints; `/logs` accepts `cursor` and returns `next_cursor`.
- **Idempotency:** send `Idempotency-Key` on writes; retries won't double-apply.
- **Errors:** `{ "error": { "code", "message", "request_id" } }` + HTTP status.
- **Rate limits:** per key (read 600/min, write 120/min) → `429` + `Retry-After`.
- **Scopes:** GET needs `read`; everything else needs `write`.

### Agents
| Method | Path | Scope | Description |
|---|---|---|---|
| GET | `/agents` | read | List agents (filter `?status=`). |
| POST | `/agents` | write | Create. Body: `name`, `passportPubkey`, `scopes`, `budget_tokens?`, `budget_cents?`, `expiresAt?`. **You generate the Ed25519 keypair and send only the public key.** |
| GET | `/agents/{id}` | read | Fetch one. |
| PATCH | `/agents/{id}` | write | Update name / scopes / budgets. A periodic limit is `budget_period` (`"day"`/`"month"`) with `budget_period_cents`, sent together; both null removes it. Write-only for now: GET does not return it. |
| POST | `/agents/{id}/suspend` · `/resume` | write | Per-agent kill toggle. |
| DELETE | `/agents/{id}` | write | Revoke (history preserved). |

### Provider credentials
Provider keys are dashboard-only today — **Settings → Provider credentials** in the Control
Tower. Raw provider secrets are never returned by the API and are never accepted by the
control plane; the panel lists stored credentials by **nickname** only, because the secret
lives in Supabase Vault and has no column to render.

You may store several credentials per provider, and exactly one of them is **in use** — the
one the gateway injects. The four operations, and when each is the right one:

| Action | What it does | Use it when |
|---|---|---|
| **Add a new key** | Stores another credential *alongside* the existing ones. Does **not** replace anything. The first key you store for a provider becomes the one in use; later ones do not. | You want a second account or environment available to switch between. |
| **Replace secret** | Swaps the secret behind an existing nickname, in place. Which credential is in use does not change. | Your key expired or was rotated at the provider and you want the same slot to keep working. This is usually what you want. |
| **Use this key** | Makes that credential the one the gateway injects for every agent that calls this provider. | You added a replacement as a new key and now want to cut over to it. |
| **Delete** | Removes the credential row and its Vault secret. Refused for the credential currently in use — switch to another one first, so a delete can never quietly change which upstream account is billed. | You are retiring a credential you have already switched away from. |

Writes attempt to purge the 60-second provider-key cache. A failed purge can leave the
old cached credential usable until its cache expires. There is no per-agent choice of
credential: every agent in the workspace that calls a provider gets the credential in use.
To run agents against different accounts or servers, use different providers (for example
`local` for a model server on your machine, alongside a real `openai` key).

### Kill switch
| Method | Path | Scope | Description |
|---|---|---|---|
| GET | `/kill-switch` | read | Current per-tenant state. |
| PUT | `/kill-switch` | write | Arm/disarm the master kill for your tenant. |

### Observability
| Method | Path | Scope | Description |
|---|---|---|---|
| GET | `/logs` | read | Gateway calls; filter by `agent_id`, `status`, `class` (`inference`, `housekeeping` or `service`) and `limit`. Returns each call's `id`; a service call also carries `call_kind: "service"` and `endpoint`, the rule that admitted it. |
| GET | `/audit` | read | Admin-action trail. |
| GET | `/spend` | read | Per-agent + fleet totals (micro-cents; $ = µ¢ / 100,000,000). |
| GET | `/receipts/{id}` | read | One call **plus its signed receipt**. See [Receipts](#receipts--signed-issuer-records). |

`/receipts/{id}` takes a call `id` from `/logs`. Receipts are fetched one at a time rather
than folded into `/logs`, because a receipt is ~700 bytes of JWS and would bloat every page
of results for the one caller in a hundred who wants a proof.

```json
{ "data": { "id": "…", "provider": "anthropic", "status": "ok", "cost_microcents": 61,
            "receipt": "eyJhbGciOiJFZERTQSIs…" } }
```

If `receipt` is `null`, the response carries `"reason": "receipts_not_enabled"` — the
row has no stored receipt. This reason is also emitted for a signing failure; it does
not conclusively diagnose missing configuration. A row can also be absent or not yet visible
because writes are asynchronous and best-effort.

A 404 is returned for another tenant's call id rather than a 403, so the endpoint can't be
used to discover which ids exist.

---

## Receipts — signed issuer records

Your logs convince you. They don't convince a counterparty, because you control your own
database. A **receipt** is a record of one call that a third party can check without an
account, without your database, and without your cooperation.

It's a compact JWS (`typ: passcontrol-receipt+jwt`) signed with your deployment's Ed25519
key. Governed approvals and refusals can receive receipts. Early authentication failures
may have no tenant log; signing and persistence are best-effort. "The gateway stopped
this agent from touching that model, here is the proof" is often the more useful document.

### Enabling them

| Variable | Purpose |
|---|---|
| `INSTANCE_SIGNING_KEY` | 32-byte base64url seed. Signs receipts and agent tokens. `passcontrol keygen instance` generates one. |
| `INSTANCE_SIGNING_KEY_PREV` | **Never signs anything.** Its public half stays published so receipts signed before a rotation still verify. Holds one generation. |
| `INSTANCE_SIGNING_KEY_HISTORY` | Every key retired before that one, as comma-separated `<kid>:<public>` pairs. Public halves only, appended and never removed. |
| `PASSCONTROL_ISSUER` | This deployment's https origin. Becomes the `iss` claim and the address others fetch your keys from. |

Without both `INSTANCE_SIGNING_KEY` and `PASSCONTROL_ISSUER`, no receipt is signed — an
unverifiable `iss` is worse than no receipt, because it looks authoritative and resolves to
no key set.

### `GET /.well-known/jwks.json`

Public and unauthenticated, with no route-specific limiter. The public halves of your signing keys — this is what
anyone verifying a receipt fetches.

```json
{"keys":[{"kty":"OKP","crv":"Ed25519","x":"kMtk4JHLIW2GLbTw2GPORDQyOE5UspTaUSQK9fUhq7U",
          "alg":"EdDSA","use":"sig","kid":"uqcSRpjIq2Y9UdUic3BebzbubwDfZoezMpkUlCwWSfA"}]}
```

Served with `Cache-Control: public, max-age=300, stale-while-revalidate=86400`
(`max-age` is configurable via `JWKS_MAX_AGE_SECONDS`). CORS is open and the global
`Cross-Origin-Resource-Policy` is relaxed here — this is the one document other deployments
exist to read.

`{"keys":[]}` means no signing key is configured. Every verification against that deployment
will then fail with `unknown_key`, which reads like a forgery and is not one.

### Claims

Names are abbreviated deliberately — a receipt travels in URLs and QR codes.

| Claim | Type | Meaning |
|---|---|---|
| `iss` | string | Issuing deployment's origin. Its JWKS is at `{iss}/.well-known/jwks.json`. |
| `sub` | string | Passport public key, or agent UUID for a DAK receipt. Interpret with `auth`. |
| `jti` | uuid | Receipt id — the same id as the call's log row. |
| `iat` | int | Signed at (Unix seconds). |
| `agid` | uuid | Agent id. |
| `auth` | object | DAK: `{kind:"direct_key",kid,use}`; enforced proof: `{kind:"passport_proof_per_request"}`. Omitted for bearer Passport receipts. |
| `vjti` | uuid | Visa ID on Passport receipts; not a DAK claim. |
| `prov` | string | Provider (`anthropic`, `openai`, …). |
| `mdl` | string \| null | Model, when one was named. |
| `mth` | string | HTTP method. |
| `path` | string | Upstream path called. |
| `use` | `{in,out}` | Input / output tokens. |
| `unp` | boolean | True means unpriced. A numeric zero in `cost` then does not mean free. |
| `cls` | string | `svc` on a call to a non-LLM service (GitHub) through `/api/v1/svc/…`. Omitted on model calls. |
| `cost` | int | **Micro-cents.** $ = `cost` / 100,000,000. `61` is $0.00000061, not $61. |
| `res` | `{status,http}` | The gateway's verdict and the HTTP status. |
| `t0` | int | Call start (Unix **milliseconds**). |
| `lat` | int | **Total** elapsed ms for the whole request, measured at the gateway — pre-checks, the provider call, and post-response bookkeeping. **Not** the gateway's own overhead: on an approved call the provider dominates it. On a refusal nothing goes upstream, so it really is gateway time. |
| `ver` | int | Receipt schema version. |
| `req` | `{alg,dig,len}` | SHA-256 over the exact request bytes, and their length. **Omitted** when the gateway refused before reading the body — absent means "never read", whereas a digest of `""` would mean "the client sent nothing". |
| `own` | `{kind,sub,tier,vat}` | The workspace owner claim, if published. **Per tenant, not per agent.** Read `tier`, not `kind`. Omitted when none is bound. |

Versioning is additive: a verifier refuses a receipt **newer** than it understands, but
ignores unknown claims within a supported version. That's what lets you add a field without
invalidating verifiers already in the field.

### Verifying one

Three ways, all running the same checks in the same order:

```bash
# 1. CLI — needs no config, no passport, no API key.
passcontrol verify receipt "<jws>" --issuer https://passcontrol.example.com
```

```js
// 2. SDK — the same function the CLI and the web page call.
//    Exported by the packaged SDK; also available as source in sdk/.
import { verifyReceipt } from "passcontrol/sdk";
const result = await verifyReceipt(jws, { trustedIssuers: ["https://passcontrol.example.com"] });
// { ok: true, claims } | { ok: false, reason }
```

3. **The web page** at `/verify/receipt` on your own deployment — paste-and-check, no install.
   Verification runs **in the visitor's browser**; the receipt is never uploaded. "Copy
   shareable link" puts the receipt in the URL fragment, which browsers never send to a
   server.

`trustedIssuers` (or `--issuer`) is required and has no default. A verifier that accepts
whatever issuer the artifact names is not verifying anything — the `iss` claim is attacker-
controlled until a signature says otherwise.

**What a successful verification means:** the named issuer signed this record and nothing in
it has changed since. It does **not** mean the issuer is trustworthy — anyone can run
PassControl — and it does **not** describe the provider's reply, only the request and the
gateway's decision about it. The absence of a receipt proves nothing: receipt writing is
best-effort by design.

Failure reasons are the `VerifyFailure` union exported by `sdk/verify.ts`; the CLI maps them
to sentences in `FAILURE_REASONS` (`cli/verify.mjs`). Two worth knowing:

- `unknown_key` — the key id isn't in the issuer's JWKS. Before reporting this the verifier
  refetches once bypassing the HTTP cache, because a cached key list can be up to a day old
  and would otherwise make a genuine post-rotation receipt look forged.
- `jwks_unreachable` — the key set couldn't be fetched. **Not** a statement that the receipt
  is bad; it means the check never completed.

### Rotating the signing key

Receipts have **no expiry**. They're checked against the keys you publish *now*, so removing
an old public key from JWKS prevents this live-key verifier from checking its receipts.
The old signatures remain mathematically valid against a retained trusted public key.

```bash
# 1. Record the retiring key permanently. Prints a `<kid>:<public>` pair.
passcontrol keygen instance --retire "REPLACE_WITH_CURRENT_SEED"
```

Then update the server environment/configuration values (not shell commands):

```dotenv
INSTANCE_SIGNING_KEY_HISTORY=<existing entries>,<the pair it printed>

# 2. Then rotate.
INSTANCE_SIGNING_KEY_PREV=<the old seed>   # the changeover window
INSTANCE_SIGNING_KEY=<the new seed>
```

This is **inverted relative to `VISA_SECRET_PREV`.** Nothing is ever signed with
`INSTANCE_SIGNING_KEY_PREV`; it exists only so its public half remains in the JWKS. Publish
both, wait one `max-age` window (5 minutes) for caches, then start signing with the new key.

**Step 1 is the one that lasts, and skipping it is a one-way mistake.** `_PREV` is a single
slot: your *next* rotation needs it for the key you are retiring today, and the key you
retired before that has nowhere to go. It disappears from the JWKS, and because receipts
have no expiry, every receipt ever signed under it stops verifying — permanently, for
everyone you ever gave one to. `_HISTORY` is append-only for the same reason. Remove an
entry only when you intend to withdraw trust in that key, which is a decision about those
receipts, not about the key.

History takes **public** halves, never seeds. A retired seed sitting in configuration can
mint new receipts backdated under the old `kid`; a public key cannot sign anything. The app
recomputes each `kid` from its key and ignores any pair that does not match, so a pasted
seed is discarded rather than published as a key nothing ever signed with.

---

## Agent-to-agent tokens

`POST /api/auth/agent-token` mints a short-lived EdDSA token (`typ:
passcontrol-agent+jwt`) that one agent presents to **another service** — as opposed to a
work-visa, which is only ever for the gateway.

The agent signs a payload with its passport private key:

```
{ payload: base64url(JSON{ passport_id, ts, nonce, aud, ttl? }), signature }
```

**`aud` lives inside the signed payload**, not beside it. The agent cryptographically
authorises which audience it is minting for; an `aud` passed as a sibling of the signature
could be swapped in transit.

The receiving service verifies it with the same JWKS as a receipt — but must pin the
audience it expects:

```bash
passcontrol verify token "<jwt>" --audience my-service --issuer https://passcontrol.example.com
```

Unlike receipts, agent tokens **do** carry `exp` and are checked for expiry and audience.

---

## Security notes for integrators

- Treat `pc_` keys and passport private keys like passwords: env vars / secret managers, never
  in source, URLs, or browsers. Rotate on suspicion; revoke instantly from the dashboard.
- Each API key only ever touches **its owner's** data (tenant-isolated server-side). There is
  no cross-tenant access and no way to widen scope without a new key.
- Provider secrets enter through authenticated dashboard operations (and supported encrypted
  workspace import), then live in Vault. They are not returned by the control-plane API.
  The gateway handles plaintext during forwarding; the deployment operator is trusted.
- Gateway call logs are append-only (DB-enforced; direct `UPDATE`, `DELETE`, and `TRUNCATE`
  are rejected). They are not a cryptographic hash chain.

## Limitations

- A visa is reusable until expiry in off/observe mode (default 5 minutes, configurable
  to 15). Required mode additionally enforces a fresh sender proof for every request.
- The data-plane proxy covers the inference and model-listing endpoints listed
  above. It does not proxy embeddings on providers other than OpenAI, Mistral and Azure, files, fine-tuning, batches,
  response retrieval/deletion, or token-counting endpoints.
- Pricing is a best-effort in-code table and can lag provider price changes. Use it for
  budgets and monitoring, not as billing reconciliation against provider invoices.
- **Gemini thinking tokens are charged as output, from `total_tokens`.** Google bills thinking at
  the output rate, but its OpenAI-compatible endpoint, which PassControl proxies, leaves thinking
  out of `usage.completion_tokens`. A real call checked on 2026-09-27 reported prompt 13,
  completion 127, total 304. So for Gemini PassControl charges output as
  `total_tokens − prompt_tokens` (never less than `completion_tokens`). A Gemini usage report
  whose `total_tokens` is missing, malformed or below the input settles as `usage_unknown`,
  which charges the larger of what was reported and the reservation. A stated output limit caps
  thinking and visible output together, approximately: streamed calls at
  `reasoning_effort: "medium"` stopped with `finish_reason: "length"` at 46 and 396 billed output
  tokens for `max_tokens` 50 and 400, and at **51** for `max_completion_tokens` 50. So a
  reservation or output-token ceiling bounds a Gemini thinking call to within about one token of
  the stated limit, and the call is charged what Gemini reports, even when that is over. Not
  checked: other effort levels. A request that states no limit is reserved at the 1024-token
  default, which thinking can exceed.
- **A streamed Gemini call is complete on its last chunk before `[DONE]`.** Gemini sends usage
  on its content chunks rather than on a separate `choices: []` chunk, so its report counts as
  final only when it rides on the last data chunk before `[DONE]` and every choice on it has a
  `finish_reason`. A stream that ends without `[DONE]`, or continues after that chunk, settles
  as `usage_unknown`. Other OpenAI-compatible providers still need the `choices: []` chunk.
- Instant revocation assumes Redis is configured for persistence/no-eviction behavior. If
  Redis evicts suspend/kill keys, enforcement falls back to short visa TTLs and durable agent
  status checks at the next mint.
- Receipts are **best-effort**: signing failures never abort a call, so the absence of a receipt
  is not evidence a call did not happen. They are signed issuer records, not a complete ledger or independent evidence of provider execution.
- A receipt covers the request and the gateway's decision. It does **not** record the provider's
  response body, so it cannot prove what a model replied.
- Verifying a receipt proves the named issuer signed it. It says nothing about whether that
  issuer is honest — anyone can run PassControl, and deciding whom to trust stays with the reader.


## Passport lifecycle and sender proof

Newly issued/rotated Passports default to 365 days; an explicit null expiry means no
expiry, including legacy rows. Expiry is checked at challenge and agent-token mint.
Dashboard lifecycle controls manage expiry and sender-proof mode.
`POST /api/control/v1/agents/{id}/rotate` takes `{passportPubkey, graceSeconds?, expiresAt?}`
(write scope); default grace is 3600 seconds. Rotation takes a new public key and a grace period from zero through seven days; the
previous key can mint until its grace deadline, subject to agent status and expiry.
A second rotation during an open grace window is refused. Neither expiry nor grace
retroactively expires a visa already minted; it can last another 300–900 seconds.
Stop controls block subsequent admitted calls, not an already-dispatched provider stream.

Sender proof is an agent setting (`off` / `observe` / `required`), enforced on Passport
requests only. DAK authentication is not upgraded by enabling it.

| Mode | Behavior | Logged authentication |
|---|---|---|
| `off` | Does not inspect a supplied proof | `passport` |
| `observe` | Records pass/missing/invalid/clock_skew/replayed where available; does not refuse on proof failure | `passport` |
| `required` | Refuses missing/invalid/stale/replayed proofs; replay-store failure is a 503 | `passport_proof_per_request` only after enforced success |

Unreadable sender-mode state is `503 sender_constraint_state_unavailable`. In observe
mode an unavailable replay store omits the observation rather than blocking or inventing
one. Current v2 visas contain `cnf.jkt`, the Passport public-key thumbprint; this claim
alone is not evidence that the gateway enforced a proof on any particular request.

`x-passcontrol-proof` is `base64url(payloadBytes).base64url(Ed25519 signature)`.
Its JSON fields are `htm` (uppercase method), `htu` (gateway origin + pathname, without
query), `iat` (integer seconds, ±30 seconds), `jti` (fresh nonce), and `vh` (base64url
SHA-256 of the exact visa). Successful verification consumes a replay nonce. It binds
neither body nor query and is not hardware attestation or a complete HTTP signature.

The sidecar generates proofs. The direct CLI call, MCP chat, and TypeScript
`PassControl` SDK paths only supply the visa: use off/observe or a correct proof-capable
transport before requiring proofs. Plain `getVisa()` plus a provider SDK also lacks request proofs.

CLI key custody: `passcontrol key status` reports storage; `passcontrol key migrate`
moves a file key into macOS Keychain, Linux Secret Service (`secret-tool`), or Windows
DPAPI-backed storage. `PASSPORT_KEY_STORAGE=os` marks that profile. Environment secrets
win; an unavailable store can use an existing file fallback with a warning. OS-backed
storage is still read into the signer process, not a non-exportable hardware key.
A signed challenge can declare `key_storage`; attribution to the key holder proves
only that it made the declaration. The gateway's custody evidence is DECLARED, not
verified, and a custody expectation is advisory rather than a storage enforcement gate.

## Public Passport revocation list

`GET /.well-known/passport-revocations` publishes a signed `passcontrol-crl+jws`
list using the instance signer. It includes revocations and recorded retired keys
with `notValidAfter`; it excludes expiry, suspension, and kill switches. Older rotations
without retained audit metadata may be absent. It is rate-limited and unavailable if
it cannot build/sign the list; do not treat a failed fetch as an empty list.

A consumer must verify issuer/key/type and apply its own freshness policy to signed
`iat`. A saved list does not learn future revocations. Absence is not proof that a
Passport is active; use public `/verify/<passportId>` or the corresponding verification
API for current lifecycle status. Receipt signature verification does not automatically
perform this lifecycle check or fetch this list.

## Custom endpoints and egress

Provider credentials can carry `endpoint_base_url`. The address belongs to the credential,
so it applies to every agent calling that provider through the credential in use; it does
not add a provider ID or new API paths.
`PROVIDER_ENDPOINT_MODE` is unset/off by default in code and in `.env.example`. The local
stack's launcher (`scripts/dev-docker.mjs`, used by `npm run dev:docker` and `passcontrol start`)
applies `selfhost` when neither `.env.docker` nor the shell sets the mode, because a local
stack is one developer's own gateway; set `PROVIDER_ENDPOINT_MODE=off` there to refuse custom
endpoints. `selfhost` accepts HTTP/HTTPS, arbitrary
ports, IP literals and private addresses. A comma-separated list such as
`models.example.com,proxy.example.com` permits exact listed public-style hostnames,
HTTPS and port 443. Do not set the literal string `allowlist` expecting it to load hosts.

All modes reject URL credentials, query/fragment, control characters, and invalid path
shapes. Stored endpoints are revalidated on use. This does not resolve DNS or pin its
answer: a hostname may resolve privately or change later. Use egress restrictions and
trusted operators; a custom endpoint receives the injected credential and controls its
response. The gateway's upstream fetch uses manual redirect handling and returns
`502 upstream_redirect` for 3xx. This is separate from the SDK's initial-origin check:
the TypeScript SDK uses fetch's redirect behavior and does not pin a redirect chain.

## Accounting and recovery

Admission uses atomic holds for each attempt. The estimate uses serialized prompt size
and an output limit (`max_tokens`, `max_completion_tokens`, or `max_output_tokens`),
with a default output estimate of 1024. It is not a tokenizer or a provider-enforced
maximum. Actual settlement can exceed the estimate/cap; subsequent admission sees that
spend. Anthropic cache read/write tokens are included in token accounting.

Complete usage settles observed figures. Failed/broken streams, missing terminal usage,
unreadable bodies, or ambiguous network failure settle as `usage_unknown`, charging at
least the estimate or a higher observation in each dimension. Definitive upstream
refusals have their own settlement classification; HTTP failure alone is not proof of
zero billing. An abandoned attempt can remain an open, non-expiring hold.

Prices on built-in endpoints use the in-code table and provider fallback for unknown
models. Custom endpoints are unpriced: `cost_microcents: null`, `unpriced: true`, receipt
`unp: true` with a placeholder numeric cost. Tokens still count. Nothing is reserved or
charged to the cost budget for them, and an agent with a dollar limit (cumulative or periodic)
is refused them with 402 `unpriced_endpoint`, so no cost cap depends on a price nobody knows.
`enforced_*` accounting can differ from reported usage/cost. A spend figure must be read
alongside unknown pricing, uncertain usage, and reserved headroom.

**Periodic limits.** An agent may also have one spend limit per calendar UTC day or month.
It is derived from the same cumulative counter, checked in the same atomic reservation, after
the cumulative caps, and refused with `402 blocked_budget_period` plus `retry-after`. A call
counts toward the period in which it finishes; reservations still in flight count against the
current period, and one that never settles keeps counting until an operator resolves it. When
the gateway has no record of the current period (a new limit, a changed period, a rebuild, a
lost key) it reads the audit log's spend for the period once, so spend earlier that day or
month counts; if that read fails the call is refused `503 blocked_budget_state`. A periodic
limit on a custom endpoint is refused `402 unpriced_endpoint`, like a cost cap.

**Models PassControl cannot price.** Prices come from an in-code table, one row per model id
(plus its dated snapshots), each read from the provider's own pricing page; the read date is
pinned in `tests/pricing-table.test.ts`. Where a page gives two rates, the higher is used:
long-context rates, cache writes above input, audio input, DeepSeek's peak hours. Under a dollar
limit (a cost cap or a periodic limit), a call to a model with **no row of its own** is refused
`402 unpriced_model` before anything is reserved or sent, and logged `blocked_unpriced_model`:
its cost could only be a fallback, and a limit enforced with a number that is not the model's
price does not hold. The same applies to a fallback model during failover. Without a dollar
limit the call proceeds and is estimated at the provider's highest listed rate. Model
listings and the demo provider are exempt; Gemini's `models/` spelling prices as the bare id.
Under a dollar limit, a request option that bills above the model's row is refused the same
way, `402 {"error":"unpriced_option","field":…}`, before anything is reserved: a `service_tier`
other than `auto`, `default`, `standard`, `standard_only` or `flex` (OpenAI Fast/`priority`,
Gemini and Mistral Priority), and Anthropic `speed` (fast mode) or a non-global
`inference_geo`. That refusal is not written to the activity feed, like the hosted-tools
refusal. All three unpriced refusals are `402`, like a spent budget, and not `409`: the OpenAI
and Anthropic SDKs retry `409` on their own, which would send (and log) each refused call up
to three times, and a retry cannot price anything. Read the `error` field to tell them apart
from `blocked_budget`: raising the budget fixes none of them. Not covered: an OpenAI project whose *default* tier is set to Fast in OpenAI's
settings bills plain requests at the Fast rate, which nothing in the request shows.

**Output ceiling.** A policy's `max_output_tokens` refuses (never shortens) any inference
request whose stated output limit — `max_tokens`, `max_completion_tokens` or
`max_output_tokens` as the request's shape uses them, times `n` — is missing or above it.
Combined with `max_requests_per_hour` it bounds requested output per hour.

Established budgets carry generations across Postgres and Redis. Missing counters or
mismatched generations refuse with `503 blocked_budget_state`; cap exhaustion is
`402 blocked_budget`. Cron reconciliation raises checkpoints/counters and reports open
holds; it does not release them because they are old. Recovery endpoints are:

- `GET /api/control/v1/agents/{id}/holds` (read).
- `POST /api/control/v1/agents/{id}/holds/{attemptId}/resolve` (write).
- `POST /api/control/v1/agents/{id}/budget/rebuild` (write).

`may_have_dispatched: true` means the attempt claimed dispatch permission and might be
billed; `not_spent` is refused. False permits that decision because this attempt did
not claim dispatch permission. Rebuilds use retained logs/adjustments, not independent
provider data. Review [the recovery runbook](./docs/budget-recovery.md) before acting.

## Signed spend statements

Cloud serves `GET /api/control/v1/statements` and `GET /api/control/v1/statements/{seq}`;
`?receipt_id=<id>` requests an inclusion proof. These operating routes, their storage,
and scheduler are not included in the public self-host tree. The packaged control SDK
can call them on Cloud; it does not install them on a self-hosted gateway.

```bash
passcontrol statements
passcontrol verify statement "<jws>" --issuer https://your-gateway.example
```

`/verify/statement`, `verifyStatement`, and `verifyInclusion` are public verifier
surfaces. Verify the receipt and statement signatures against trusted keys before
checking inclusion, then check workspace/window and chain links against the expected
history. A single valid signature is not a whole-chain verification. `nr > n`, `unp`,
and `unk` describe coverage/pricing gaps; surface them rather than displaying a clean
bill. Commitment is not an independent audit of totals or completeness. Full wire
format, Merkle construction and vectors: [statement format](./docs/statement-format.md).

## Interactive CLI

`passcontrol` (or `passcontrol menu`) opens the searchable command browser on a TTY,
with grouped actions and recent commands. Noninteractive use prints static guidance;
explicit subcommands and `--help` remain available for scripts. The browser is a CLI
navigation surface, not an additional authentication method.


Policy outage posture is separate from kill-state posture. `POLICY_FAIL_CLOSED=true`
opts into blocking an unreadable policy; readable but malformed policy is denied.
Other authentication/state gates may still refuse a request even when this policy
check is configured fail-open. Shadow writes and observations are best-effort, so
counts are a lower bound, not a complete traffic census.

Passport receipt `use.cr` / `use.cw` carry Anthropic cache reads/writes where reported;
`pol` identifies the effective policy revision. Failover receipts use `prev` / `why`
to link attempts. Each receipt describes one attempt, not one complete multi-provider
transaction. The gateway may reserialize client JSON or add stream usage options, so
`req` is a digest of client bytes, not necessarily upstream wire bytes.
