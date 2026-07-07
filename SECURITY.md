# Security Policy

PassControl is a credential gateway — security *is* the product. If you find a
vulnerability, thank you. Please report it responsibly.

## Reporting a vulnerability

**Email security@vertias.eu** (or use GitHub's private "Report a vulnerability"
advisory feature). **Do not open a public issue** for a security bug.

Please include: what you found, how to reproduce it, and the impact you think it has.
We'll acknowledge within a few days and work with you on a fix and a coordinated
disclosure timeline. We're a small team — there's no paid bug bounty, but we credit
reporters (with your permission) and genuinely appreciate the help.

## Status — read this

PassControl is **early and not yet independently audited.** It is built security-first
(test-first on auth/credential/money paths, RLS-isolated tenants, a CI gate that spins up
a fresh database and checks tenant isolation), but it has not been through a third-party
review. Treat it accordingly: **run it on a non-critical provider key first.**

## Architecture notes relevant to security

- **Bring-your-own-key.** Your provider API key lives encrypted in *your own* Supabase
  Vault. It is decrypted only in-flight to forward a request, and cached briefly
  (encrypted) in Redis/Upstash. PassControl operators never store it in plaintext.
- **Agents never hold the provider key.** They hold an Ed25519 passport (private key, only
  signs, never transmitted) and mint short-lived, revocable visas.
- **Tenant isolation** is enforced in code on the service-role path and by Postgres RLS;
  `db/tests/rls_invariants.sql` checks it, and CI runs it against a from-scratch database.
- **Revocation** is layered: Redis-backed per-tenant/platform kill switch, per-agent
  suspend, and short visa TTLs. Suspend/revoke also persist to Postgres (`agents.status`),
  and visa minting rejects a non-active agent — so revocation is durable at the *mint*
  boundary. The instant, in-flight layer (blocking an already-issued visa) is the Redis
  suspend/kill state; for that to be reliable, run Redis with **key eviction disabled**
  (Upstash paid tier, or self-hosted `maxmemory-policy noeviction`). On an evicting Redis
  under memory pressure, an evicted suspend/kill key can let an *already-issued* visa keep
  working until it expires — bounded by the visa TTL (default 5 min, max 15). Set
  `KILL_SWITCH_FAIL_CLOSED=true` to make kill-switch/suspend read failures block rather than
  pass through.

## In scope
Auth/visa flows, the proxy and key handling, tenant isolation / RLS, the control-plane API
and API keys, MFA, budgets/rate limits, and anything that could leak a credential or cross
a tenant boundary.

## Out of scope
Issues in third-party services themselves (Supabase, Upstash, Vercel, the LLM providers),
findings that require a compromised host/account you already control, and best-practice
nits without a concrete exploit. Self-hosters are responsible for their own deployment
secrets and infrastructure configuration.
