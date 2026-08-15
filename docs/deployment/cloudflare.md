# PassControl on Cloudflare Workers

This is an **additive deployment path** for PassControl Cloud. The committed Next.js source keeps
its explicit Edge runtime declarations for the existing Vercel path. `npm run build:cloudflare`
copies only application source into an ignored, temporary directory, removes those runtime hints
in that copy, builds with OpenNext, and writes the generated Worker to `.open-next/`. The source
tree is never rewritten.

## $0 launch shape

- **Cloudflare Workers:** Next.js application, dashboard, API routes, streaming proxy, static assets,
  and a Cron Trigger every five minutes.
- **Supabase:** Postgres, Row Level Security, Auth, and Vault. PassControl relies on `auth.uid()` for
  tenant isolation, so Supabase Auth stays part of this architecture.
- **Upstash Redis:** rate limits, replay protection, kill/suspend state, and budget reservations.
- **Provider accounts:** bring-your-own-key; PassControl stores each credential in Supabase Vault.

The Worker has no R2/KV dependency. PassControl does not use Next's incremental cache for a trust
decision, and the first Cloud launch should not provision storage it does not need.
The committed Worker variable `PASSCONTROL_TRUST_CF_CONNECTING_IP=true` is safe only because
Cloudflare overwrites that header at its public edge; do not copy the opt-in to Vercel or a proxy
that passes client-supplied `cf-connecting-ip` through.

## Supabase Auth production checklist

In Supabase Auth settings, the owner must:

1. Set the Site URL to the final HTTPS PassControl origin.
2. Add `https://YOUR-DOMAIN/auth/callback` to allowed redirect URLs.
3. Enable email/password and email confirmation.
4. Configure a **custom SMTP provider** and test delivery. Supabase's default SMTP is a development
   convenience with recipient/rate restrictions; it is not a production mail path.
5. Choose `PASSCONTROL_SIGNUP_MODE=open`, `invite`, or `closed`. Missing or invalid configuration
   fails safely to `invite`; `INVITE_CODE` is only read in invite mode.

Signup now distinguishes an active session from pending confirmation. Recovery links return through
the same canonical callback to `/login/reset`; after a successful password change, all refresh
tokens for that operator are revoked and the user signs in again.

## Build and local Workers-runtime verification

Install from the committed lockfile, provide build-time public Supabase values, and run:

```bash
npm ci
npm run typecheck
npm test
npm run build:cloudflare
XDG_CONFIG_HOME=/tmp/passcontrol-wrangler-config \
  WRANGLER_LOG_PATH=/tmp/passcontrol-wrangler.log \
  npx wrangler deploy --dry-run
npm run preview:cloudflare
```

The `deploy --dry-run` command only bundles and validates locally; it does not upload. The preview
runs the produced bundle in `workerd`, which is the compatibility check that a normal `next build`
cannot provide.

## Runtime configuration

Set these as Cloudflare Worker secrets or variables before any real deployment. Never commit their
values:

- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `VISA_SECRET` and optional `VISA_SECRET_PREV`
- `INSTANCE_SIGNING_KEY` and optional `INSTANCE_SIGNING_KEY_PREV`
- `PASSCONTROL_ISSUER` (the final bare HTTPS origin)
- `CACHE_ENC_KEY`
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`
- `CRON_SECRET`
- optional alerting/Sentry/fail-closed settings documented in `.env.example`

`NEXT_PUBLIC_*` values are also needed during the build because Next embeds public configuration in
browser assets. Use the same Supabase project at build and runtime.

The custom Worker entry point delegates all HTTP requests to OpenNext and handles two scheduled
events. The five-minute trigger calls the authenticated `/api/cron/reconcile` route and the daily
trigger calls `/api/cron/beta-retention`, both internally with `CRON_SECRET`. Neither duplicates
application logic or creates a second write path.

Before an external invite, run the stricter configuration and human-gate check documented in
[`cloud-direct-agent-beta.md`](./cloud-direct-agent-beta.md). It requires the production environment
plus explicit acknowledgements for restore-tested backup, Supabase Auth, SMTP, advisors, and
rollback; it inspects shapes and variable names and never prints secret values.

## The outbound step (owner only)

After the local preview, secret setup, custom-domain setup, and a final diff review, the owner may
run `npx opennextjs-cloudflare deploy`. That uploads code and is intentionally **not** performed by
an agent or by the build/test scripts. Start on a non-production Worker, verify login/signup/reset,
one real governed call, receipt verification, kill switch, and scheduled reconciliation, then move
the custom domain.
