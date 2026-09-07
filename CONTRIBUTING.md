# Contributing to PassControl

Thanks for considering a contribution. This is an early, security-focused project — issues
and PRs are welcome, and so is patience. Be kind.

## Getting started

Fastest local setup:

```bash
git clone https://github.com/<you>/passcontrol && cd passcontrol
npm install
npm run dev:stack      # starts Supabase + Redis, applies migrations, seeds a dev user
npm run dev:docker     # runs the app with .env.docker loaded
```

That starts Supabase locally, Redis-over-REST, applies migrations, and seeds the dev login
documented in the README. Docker Desktop and the Supabase CLI are required; host `psql` is
not.

For local synthetic calls, `PASSCONTROL_DEMO=1` enables the keyless demo provider.
The removed `try` command is not part of 0.9.0. Use `passcontrol call` with a configured
demo agent, or the login/doctor self-test on a demo-enabled gateway. The demo exercises
governance and synthetic accounting, not a provider invoice. Keep local seeded accounts
out of production.

Manual setup against your own Supabase/Redis:

```bash
git clone https://github.com/<you>/passcontrol && cd passcontrol
npm install
cp .env.example .env.local      # fill in Supabase / Upstash / secrets
DATABASE_URL='postgresql://…' npm run migrate   # applies db/migrations/*.sql in order, once each
npm run dev
```

See the [README](./README.md) for the stack and a fuller setup.

## Before you open a PR

CI runs these and they must pass — run them locally first (a pre-push hook does too):

```bash
npm run typecheck
npm test
npm run build
```

The CI gate also spins up a fresh Supabase stack, applies every migration from scratch, and
runs `db/tests/rls_invariants.sql` to verify tenant isolation. If you touch the schema, add
your migration as the next `db/migrations/NNNN_*.sql` (forward-only) and keep that test green.

## Project conventions

- **Test-first for anything touching auth, credentials, money, or tenant isolation.** Write
  a failing test that captures the behavior/bug, then make it pass. PRs that change these
  paths without tests will be asked for them.
- **Tenant isolation is the cardinal rule.** The control plane uses a service-role client
  that bypasses RLS, so every query/mutation must be scoped by `user_id` in code. If you add
  a control-plane endpoint, scope it and add an isolation test (see `tests/control-*.test.ts`).
- **Never log or return a provider key**, and don't put secrets in source — everything goes
  through env (`.env.example` documents the surface).
- Match the surrounding code's style; keep changes focused.

## Manual test note (no automated coverage)

The **MFA login step-up** can't be fully exercised by the unit tests (it needs a real
Supabase Auth session). If you change the login / MFA flow, manually verify: enroll in the
dashboard Security panel → sign out → sign in → you should land on `/login/verify` → a TOTP
code lets you in, and a recovery code resets MFA. Also confirm a **non-MFA** user's login is
unchanged.

## Reporting security issues

Do **not** use public issues for vulnerabilities. Report them through GitHub's
[private vulnerability reporting](https://github.com/Vertias3u/PassControl/security/advisories/new)
(Security tab → "Report a vulnerability") — details and scope in [SECURITY.md](./SECURITY.md).
