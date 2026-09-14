# PassControl on Cloudflare Workers

This is an **additive deployment path** for PassControl, including the public self-host tree. The committed Next.js source keeps
its explicit Edge runtime declarations for the existing Vercel path. `npm run build:cloudflare`
copies only application source into an ignored, temporary directory, removes those runtime hints
in that copy, builds with OpenNext, and writes the generated Worker to `.open-next/`. The source
tree is never rewritten.

## Runtime shape

- **Cloudflare Workers:** Next.js application, dashboard, API routes, streaming proxy, static assets,
  and a Cron Trigger every five minutes.
- **Supabase:** Postgres, Row Level Security, Auth, and Vault. PassControl relies on `auth.uid()` for
  tenant isolation, so Supabase Auth stays part of this architecture.
- **Upstash Redis:** rate limits, replay protection, kill/suspend state, and budget reservations.
- **Provider accounts:** bring-your-own-key; PassControl stores each credential in Supabase Vault.

The Worker has no R2/KV dependency. PassControl does not use Next's incremental cache for a trust
decision, and no storage service is required for that purpose. Hosting costs depend on workload and service plans.
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

The custom Worker entry point delegates all HTTP requests to OpenNext and handles its scheduled
events. The five-minute trigger calls the authenticated `/api/cron/reconcile` route internally with
`CRON_SECRET`.
No trigger duplicates application logic or creates a second write path.


## The outbound step (owner only)

After the local preview, secret setup, custom-domain setup, and a final diff review, the owner may
run `npx opennextjs-cloudflare deploy`. That uploads code and is intentionally **not** performed by
an agent or by the build/test scripts. Start on a non-production Worker, verify login/signup/reset,
one real governed call, receipt verification, kill switch, and scheduled reconciliation, then move
the custom domain.


## Self-host boundaries and database setup

Set `DATABASE_URL` in your shell environment and apply the migrations included in your public checkout with `npm run migrate`
before serving traffic. A fresh install applies its full migration tree; existing deployments
must review ordering requirements before upgrades. Do not copy a private deployment's migration
count: Cloud-only statement-operation migrations are absent from the public tree.

The public build includes receipt/statement verification but not Cloud statement issuance,
proof-serving routes, invite operations, or hosted quotas. The local `dev:stack` setup is
for development; it does not provision a production Supabase, SMTP, backups, or egress policy.
Use **Node 22+**: the locked Wrangler requires it, while the locked Supabase client
requires Node 20+. The CLI package's Node ≥18 declaration does not cover the full build stack.

For custom upstreams, `PROVIDER_ENDPOINT_MODE` defaults off. A hostname list enables selected
HTTPS/443 hosts; `selfhost` deliberately permits private HTTP destinations. DNS is not resolved
or pinned by validation. Enforce network egress externally. Provider redirects are refused.
Schedule reconcile reliably: it raises spend checkpoints and reports unresolved holds rather
than releasing them. See [budget recovery](../budget-recovery.md).
