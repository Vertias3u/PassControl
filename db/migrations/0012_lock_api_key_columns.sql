-- ============================================================================
-- PassControl — lock privileged api_keys columns from dashboard-authenticated
-- users (defense-in-depth; mirrors 0011 for agents).
--
-- 0008 granted table-wide privileges to `authenticated` and relies on RLS for
-- tenant scoping. RLS stops cross-tenant edits, but it does NOT stop an owner
-- from PATCHing privileged columns on their OWN key through PostgREST — e.g.
-- flipping `scope` from read->write, or overwriting `key_hash`. The only column
-- a dashboard user legitimately updates is `revoked_at` (revoke = soft delete);
-- `last_used_at` is written by the service role, which bypasses these grants.
--
-- This is hardening, not a fix for a live escalation: an owner can already mint a
-- write-scoped key at will, so flipping an existing key's scope grants nothing
-- new, and key_hash is UNIQUE + row is RLS-scoped to the owner. The value is
-- consistency with the 0011 invariant (privileged columns are server-only) and
-- keeping key_hash tamper-proof after creation. As in 0011, a table-wide grant
-- can't be narrowed by a column-only REVOKE, so replace UPDATE with a
-- column-scoped grant.
-- ============================================================================

revoke update on public.api_keys from authenticated, anon;
grant update (revoked_at) on public.api_keys to authenticated;
