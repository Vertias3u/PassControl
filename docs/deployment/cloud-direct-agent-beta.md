# Cloud Direct Agent beta — operator runbook

This is a prepared deployment path, not permission to deploy it. Production changes,
external invites, and package publication require an explicit owner go-ahead.

The application, personal-invitation and three-workspace funnel rollout is specified in
[`invite-beta-launch.md`](./invite-beta-launch.md). Migration 0025 is additive but must be
applied and verified before `PASSCONTROL_INVITE_SOURCE=database` is enabled. It changes no
existing product table or row and hardens future function-execution defaults.

## What ships in the first invite beta

- One Direct Agent Key credential type: a named, revocable bearer key bound to one
  existing agent, its live scopes, policy, suspension state, kill switches, and budgets.
- One provider-native setup flow. OpenAI-compatible providers receive OpenAI SDK variables;
  Anthropic receives its native SDK variables and Messages API example. The Direct Agent Key
  goes into the client; the real provider key stays in PassControl Vault.
- Honest receipts and stored call rows. A direct call says `direct_key`; it never claims
  a passport signed or a visa authorized the request.
- Upgrade in place. Adding a signing passport fills the same agent row and preserves the
  agent ID, logs, policy, scopes, budgets, and existing installation keys.

Not in this slice: a catalog of product-specific wizards, desktop Connect, durable
pre-dispatch audit intents, billing automation, or a final discriminated database CHECK.

The authorization scope and client model are separate. `gpt-*` is a useful scope rule but
not a model a provider can call, so the wizard requires a concrete model covered by the rule.

## Required rollout order

1. Take and verify a database backup where the Supabase plan permits it. If the free tier
   cannot produce a restorable backup, keep the cohort disposable, record that limitation,
   and use the explicit no-backup-risk acknowledgement below instead of claiming a backup exists.
2. Apply `db/migrations/0023_direct_agent_keys_expand.sql` while the old application is
   still live. It first drops `agent_logs.passport_id` and `jti` NOT NULL, then adds
   nullable identity columns with `auth_method default 'passport'`. The old writer stays
   valid throughout.
3. Verify migration grants and run Supabase security/performance advisors. Do not invite
   anyone if the service-only authentication or lifecycle RPCs are executable by `anon`
   or `authenticated`.
4. Deploy the dual-mode application and make one controlled Direct Agent Key call.
5. Verify the stored `agent_logs` row has `auth_method=direct_key`, no passport/JTI,
   both direct identity IDs, and a version-2 receipt that the public verifier labels
   “Direct Agent Key accepted.” Verify passport calls still write their existing shape.
6. Canary before considering a later constraint migration. The final NOT NULL and
   discriminated CHECK are intentionally absent from 0023; adding them is a separate
   migration after real writer evidence, using `NOT VALID` then `VALIDATE CONSTRAINT`.

`writeLog` remains best-effort: it retries once and emits a critical scrubbed error when
both inserts fail. It must not turn a provider-charged success into a late 503. Durable
audit intents are a separate reliability slice that needs measured latency first.

## Machine readiness gate

Invite-beta readiness is stricter than a normal self-host install. Set the production
environment without echoing it, then run:

```bash
npm run check:cloud-beta -- \
  --ack-no-backup-risk \
  --ack-supabase-auth \
  --ack-smtp \
  --ack-advisors \
  --ack-rollback \
  --ack-beta-auth-hook
```

The command validates only configuration shape and named operator acknowledgements; it never
prints secret values. The acknowledgements mean all of the following were actually completed:

`check:cloud-beta` runs `check:legal` first. Vercel's committed build command also runs
that legal gate before `next build`, so a production deployment cannot silently publish
the pre-launch draft state. The free invite beta requires an ISO effective date through
`PASSCONTROL_LEGAL_EFFECTIVE_DATE` and publishes the named individual operator and contact
email. It does not require or invent a public service address. Before accepting payment,
obtain qualified Bulgarian advice, configure `PASSCONTROL_PUBLIC_SERVICE_ADDRESS`, and run
`npm run check:paid-legal`; never expose a private home address merely to clear a check.

- `--ack-backup`: a current database backup was restored into an isolated target and checked.
  Two limits are known and deliberate, so acknowledge it knowing what it does and does not
  cover. **(1) Vault is not in the backup.** Provider keys are encrypted with a root key
  Supabase manages per project and never puts in a dump, so `provider_credentials` restores
  as pointers to secrets nothing can decrypt. Take the ciphertext dump
  (`supabase db dump --schema vault --data-only`) — it restores correctly into the *same*
  project — but treat "operators re-enter their provider keys" as the stated recovery path
  after project loss, and tell beta users that before they rely on it. **(2) A bare
  `supabase/postgres` container cannot restore `auth` or `storage`; those schemas are
  platform-managed and the image ships a skeletal `auth.users`. Restoring there verifies the
  application layer only.** Exercise auth restore against a real Supabase project; a local
  application-schema restore is not evidence that Auth or Storage recovery works.
- `--ack-no-backup-risk`: the owner has confirmed that the current Supabase plan cannot
  produce the required restorable backup, accepts that beta data may be unrecoverable, keeps
  the initial cohort disposable, and will not represent this flag as evidence of a backup.
  Use exactly one of the two backup acknowledgements.
- `--ack-supabase-auth`: production Site URL, callback allowlist, email confirmation, signup,
  login, logout, forgotten-password, reset, and refresh-token revocation were exercised.
- `--ack-smtp`: custom SMTP delivered confirmation and recovery mail outside the owner account.
- `--ack-advisors`: Supabase security and performance advisors were reviewed after migration
  0023, including the service-only lifecycle RPC grants.
- `--ack-rollback`: the application-first rollback below was reviewed and is executable.
- `--ack-beta-auth-hook`: migration 0025's `public.hook_authorize_beta_signup` is configured
  as Supabase Auth's Before User Created hook, and a direct `/auth/v1/signup` attempt without
  PassControl's server-added invitation metadata was rejected. This is the admission boundary;
  hiding or validating only the PassControl signup form is not sufficient.

`SENTRY_DSN` is a release requirement for the invite beta even though it remains optional for
self-hosting. The `agent_log_insert_failed` event is the critical alert for a provider-charged
response whose durable call row could not be written after the retry. The
`proxy.cloud_beta_quota_unavailable` event reports a Redis outage that is fail-closed and returning
503s before dispatch; ordinary workspace/global quota exhaustion remains a normal 429, not an
infrastructure alert.

## Cloud beta controls

Set these only for the hosted invite beta; leave them unset/zero for self-hosting:

```dotenv
DIRECT_KEY_IP_LIMIT=60
DIRECT_KEY_IP_WINDOW_S=60
CLOUD_BETA_WORKSPACE_CALL_LIMIT=10000
CLOUD_BETA_GLOBAL_CALL_LIMIT=50000
```

The direct-key limiter runs before every database lookup and fails closed if Redis is
unreadable. Cloud quota counters use their own atomic Redis operation; workspace admission happens
before the shared counter is touched, and a shared-cap refusal rolls both attempted increments back.
This operation never modifies the atomic budget-reservation Lua.

The committed Cloudflare Worker sets `PASSCONTROL_TRUST_CF_CONNECTING_IP=true`, so the
limiter keys from Cloudflare's edge-overwritten `CF-Connecting-IP` header. Vercel and other
deployments leave it false and ignore that client-spoofable header. Any reverse proxy must
overwrite the forwarding header PassControl trusts rather than pass client input through.

The 10,000-call workspace ceiling deliberately selects for low-volume validation on the
current free infrastructure. Do not recruit an active high-volume coding-agent user under
that ceiling: either raise it and fund the resulting Upstash/Supabase usage first, or the
beta will teach them only that PassControl stops their work.

Keep the invite allowlist at at most five external workspaces. The adoption gate is:

> Three separate invited external workspaces complete setup and make a real governed
> call — not three conversations about whether they might.

## Provider-native canary configuration

For a key scoped to OpenAI:

```dotenv
OPENAI_BASE_URL=https://YOUR-PASSCONTROL-HOST/api/v1/openai/v1
OPENAI_API_KEY=pc_agent_REVEAL_ONCE_VALUE
OPENAI_MODEL=gpt-5
```

For Anthropic's native SDK, the wizard emits:

```dotenv
ANTHROPIC_BASE_URL=https://YOUR-PASSCONTROL-HOST/api/v1/anthropic
ANTHROPIC_API_KEY=pc_agent_REVEAL_ONCE_VALUE
ANTHROPIC_MODEL=claude-haiku-4-5
```

The OpenAI-compatible credential may be sent in `x-api-key` for clients that use that convention.
When a request sends both headers, `Authorization: Bearer` wins. A credential-created
screen is not evidence of routing; only a stored call row establishes that the gateway
handled a request, and a successful stored row establishes the provider path.

### Prepare disposable canary identities

The active command below does not change production configuration. Before running it, prepare:

1. A dedicated confirmed canary user and a **read-scoped** control-plane API key for that user.
2. One Direct Agent Key whose agent allows the chosen concrete model. This makes one real call.
3. A second Direct Agent Key whose agent allows that model but has less remaining token budget
   than `PASSCONTROL_CANARY_BUDGET_MAX_TOKENS` (default 8192). This must refuse before dispatch.
4. A third Direct Agent Key that has already been revoked. Keep its reveal-once value only for
   this check; the next request must answer 401 and must not advertise a receipt row.
5. A signing passport on an active agent that allows the same provider and model. This makes the
   passport regression call and must remain a version-1 receipt.
6. A concrete model outside the first Direct Agent's scope. It must be a real-looking model id,
   not a wildcard; the gateway must stop it before it reaches the provider.

Keep these values in the operator shell or a temporary password-manager-backed environment. Do
not put them in the deployment environment and do not commit them to `.env` files:

```dotenv
PASSCONTROL_CANARY_ORIGIN=https://YOUR-PASSCONTROL-HOST
PASSCONTROL_CANARY_PROVIDER=anthropic
PASSCONTROL_CANARY_MODEL=claude-haiku-4-5
PASSCONTROL_CANARY_SCOPE_DENIED_MODEL=claude-canary-denied
PASSCONTROL_CANARY_DIRECT_KEY=pc_agent_REVEAL_ONCE_HAPPY_KEY
PASSCONTROL_CANARY_BUDGET_KEY=pc_agent_REVEAL_ONCE_LOW_BUDGET_KEY
PASSCONTROL_CANARY_REVOKED_KEY=pc_agent_REVEAL_ONCE_THEN_REVOKED_KEY
PASSCONTROL_CANARY_PASSPORT_ID=BASE64URL_PUBLIC_KEY
PASSCONTROL_CANARY_PASSPORT_SECRET=BASE64URL_PRIVATE_SEED
PASSCONTROL_CANARY_EMAIL=canary@example.com
PASSCONTROL_CANARY_PASSWORD=CANARY_ACCOUNT_PASSWORD
PASSCONTROL_CANARY_BUDGET_MAX_TOKENS=8192
NEXT_PUBLIC_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=PRODUCTION_ANON_KEY
PASSCONTROL_API_KEY=pc_READ_SCOPED_CONTROL_KEY
```

Then run exactly:

```bash
npm run canary:cloud-beta -- --confirm-billable-production-canary
```

Without that acknowledgement the command refuses before any network call. With it, the command:

- loads `/login` and the deployed JWKS;
- performs a real Supabase password login and validates the returned session with the auth server;
- drives one Direct Agent call and one passport call through the matching official SDK;
- polls each receipt through the tenant-scoped control API until its durable row exists;
- verifies the Ed25519 receipt against the deployed JWKS and matches its verdict to the row;
- requires the Direct row to have `auth_method=direct_key`, both direct identity IDs, and no
  fabricated passport/JTI, while the passport row retains the passport identity shape;
- requires durable `blocked_scope` and `blocked_budget` rows; and
- requires the already-revoked key to fail on its next request before a receipt exists.

The two success calls are billable. The other three requests must be refused before provider
dispatch. Do not substitute `curl`: this check exists to catch the official clients' path and
header behavior. A failure prints no credential values. Stop invites and roll back the
application first; preserve migration 0023 and all evidence rows.

## Rollback without destroying evidence

If the dual-mode application misbehaves, rollback the application first to the previous
passport-only release. Existing passport traffic can resume because migration 0023 is an
expansion migration and its defaults preserve the old writer shape. Direct Agent Keys will be
refused by the old application, which is the safe degraded state.

Do not reverse migration 0023 during an incident and do not drop direct-key rows or identity
columns. That would destroy attribution and can turn a reversible application rollback into data
loss. Keep the expanded schema, preserve `agent_logs` and `agent_access_keys`, diagnose, and roll
forward. Database restore is a last resort requiring the verified backup and an explicit owner
decision, because restoring also rewinds budgets, revocations, audit history, and provider-key
changes.

Nothing in this runbook authorizes a deploy, secret provision, invite, or publication. Those are
owner-only outbound actions after the local release candidate is reviewed.
