-- ============================================================================
-- PassControl — public agent verification (PAVP).
--
-- Backs the unauthenticated page at /verify/<passport-id>. A stranger holding a
-- passport id can ask one question and get one answer: was this passport issued
-- by us, and is it still valid?
--
-- The readable surface is fixed HERE rather than hand-scoped in the route. That
-- is the whole point of routing a public read through a function: a later edit
-- to the page cannot widen the column list, because the function only ever
-- returns these three columns.
--
-- Deliberately absent, and none of these should be added later without deciding
-- again in the open:
--   * name            — agent names are customer-identifying. `acme-prod-billing`
--                       on a public URL is a customer list.
--   * allowed_scopes  — reveals which model vendors a company buys from.
--   * budget/spend    — commercially sensitive, and not what verification asks.
--   * agent_logs      — traffic history is private, always.
--   * user_id         — the tenant is never named on a public surface. The
--                       issuer is Vertias; the holder is the passport itself.
--
-- SECURITY DEFINER because the caller is service_role and public.agents is RLS'd
-- to the owning tenant. Execute is service_role-ONLY: anon and authenticated
-- cannot reach this function at all, so the surface those roles see is exactly
-- what it was before this migration. The web tier, not the database, is what
-- decides that an anonymous visitor gets an answer — and it rate limits first.
--
-- Lookup is by passport_pubkey only. The internal agent uuid is never a valid
-- input, so a dashboard URL pasted into /verify resolves to nothing and cannot
-- be correlated with a public identity.
-- ============================================================================

create or replace function public.verify_passport(p_passport_id text)
returns table (
  passport_pubkey text,
  status          text,
  created_at      timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    a.passport_pubkey,
    a.status::text,
    a.created_at
  from public.agents a
  where a.passport_pubkey = p_passport_id
  limit 1
$$;

comment on function public.verify_passport(text) is
  'Public passport verification (PAVP). Returns the issued/revoked state of one '
  'passport by its public key and nothing else. SECURITY DEFINER, service_role '
  'execute only; the web tier gates anonymous access and rate limits it.';

-- Explicit grants: the implicit default-privilege grants do not reproduce on a
-- from-scratch apply (see 0007_grants.sql, which exists because of exactly that).
-- EXECUTE defaults to PUBLIC for new functions, so the revoke below is what
-- actually keeps anon and authenticated out.
revoke all on function public.verify_passport(text) from public, anon, authenticated;
grant execute on function public.verify_passport(text) to service_role;
