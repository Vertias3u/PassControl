# Security Policy

PassControl is a credential gateway — security *is* the product. If you find a
vulnerability, thank you. Please report it responsibly.

## Reporting a vulnerability

Use GitHub's **[private vulnerability reporting](https://github.com/Vertias3u/PassControl/security/advisories/new)**
(the "Report a vulnerability" button under the repository's Security tab). It's private
between you and the maintainer, and it's the only reporting channel — there is no
security@ mailbox, deliberately: an address nobody reads is worse than none.

**Do not open a public issue** for a security bug.

Please include: what you found, how to reproduce it, and the impact you think it has.
We'll acknowledge within a few days and work with you on a fix and a coordinated
disclosure timeline. This project is built by one developer — there is no paid bug bounty, but we credit
reporters (with your permission) and genuinely appreciate the help.

## Status — read this

PassControl is **early and not yet independently audited.** It is built security-first
(test-first on auth/credential/money paths, RLS-isolated tenants, a CI gate that spins up
a fresh database and checks tenant isolation), but it has not been through a third-party
review. Treat it accordingly: **run it on a non-critical provider key first.**

## Architecture notes relevant to security

- **Bring-your-own-key.** Your provider API key lives encrypted in your Supabase Vault when self-hosted,
  or in the managed server-side Vault on Cloud. It is decrypted only in-flight to forward a request, and cached briefly
  (encrypted) in Redis/Upstash. PassControl operators never store it in plaintext.
- **Agents never hold the provider key.** They use either a scoped Direct Agent Key or an Ed25519 Passport whose private
  key signs locally to mint short-lived visas. Required sender proof additionally binds
  each request to key possession; off/observe retain bearer-visa authentication.
- **Tenant isolation** is enforced in code on the service-role path and by Postgres RLS;
  `db/tests/rls_invariants.sql` checks it, and CI runs it against a from-scratch database.
- **Revocation** is layered: Redis-backed per-tenant/platform kill switch, per-agent
  suspend, and short visa TTLs. Suspend/revoke also persist to Postgres (`agents.status`),
  and visa minting rejects a non-active agent — so revocation is durable at the *mint*
  boundary. The layer blocking subsequent uses of an issued visa (blocking an already-issued visa) is the Redis
  suspend/kill state; for that to be reliable, run Redis with **key eviction disabled**
  (verify managed-service settings, or use self-hosted `maxmemory-policy noeviction`). On an evicting Redis
  under memory pressure, an evicted suspend/kill key can let an *already-issued* visa keep
  working until it expires — bounded by the visa TTL (default 5 min, max 15). Set
  `KILL_SWITCH_FAIL_CLOSED=true` to make kill-switch/suspend read failures block rather than
  pass through.
- **Client IP rate limits assume a trusted proxy.** The unauthenticated challenge throttle
  and control-plane pre-auth flood guard key on `X-Forwarded-For` / `X-Real-IP`. Behind
  Vercel or another trusted reverse proxy, those headers represent the real client IP. If
  you run bare `next start` directly on the internet, clients can forge/rotate those
  headers and the per-IP limits become advisory; self-hosters should put PassControl behind
  a proxy that overwrites forwarding headers.

## In scope
Auth/visa flows, the proxy and key handling, tenant isolation / RLS, the control-plane API
and API keys, MFA, budgets/rate limits, and anything that could leak a credential or cross
a tenant boundary.

## Out of scope
Issues in third-party services themselves (Supabase, Upstash, Vercel, the LLM providers),
findings that require a compromised host/account you already control, and best-practice
nits without a concrete exploit. Self-hosters are responsible for their own deployment
secrets and infrastructure configuration.


## Assurance limits in 0.9.0

Sender proofs bind method, gateway origin/path, timestamp, nonce and visa hash, not body
or query. Only required mode enforces them; observed proofs are diagnostics. The sidecar
supplies proofs; direct CLI calls, MCP chat and the TypeScript SDK do not attach them.
Required-mode replay checks and DAK validation fail closed on unavailable state.

OS credential-store support reduces file exposure but still exposes keys to the signer
process. Gateway custody is DECLARED evidence, not hardware/storage attestation. Public
revocation-list signatures need freshness checks and exclude expiry/suspend/kill; they
cannot establish current lifecycle validity from indefinite offline storage.

Custom endpoints require operator opt-in. `selfhost` permits private-network HTTP;
host-list validation does not resolve/pin DNS and is not full SSRF prevention. Upstream
redirects are refused. The application operator can access plaintext during forwarding;
this boundary does not protect against a compromised gateway or signing runtime.

Budget holds are estimates. Unknown usage can conservatively consume capacity, lost
established state blocks, and recovery cannot recreate unrecorded spend. Signed receipts
and Cloud statements authenticate issuer assertions, not independent truth, complete
traffic coverage or provider invoices. The public tree ships statement verification,
not its operating service. See [the reference](./DOCUMENTATION.md).
