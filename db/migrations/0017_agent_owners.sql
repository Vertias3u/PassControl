-- ============================================================================
-- PassControl — owner binding.
--
-- Until now a passport answered "was this issued by us, and is it still valid?"
-- It could not answer "whose is it?" — public.agents carries a user_id and
-- nothing else, and a tenant uuid is not an answer anyone can act on.
--
-- This binds a passport to an accountable owner, with an explicit TIER saying
-- how much that binding is worth:
--   self_attested / unverified — the operator typed a name. Proves nothing, and
--                                is always labelled as proving nothing.
--   domain         / domain    — control of a web server answering for that
--                                host was demonstrated. Free, no third party.
--   idv            / idv       — reserved. No code implements this yet; the
--                                value exists so adding it later needs no
--                                migration. An adapter would live in lib/owner/.
--
-- ── Amending the 0015 doctrine, deliberately and in the open ────────────────
--
-- Migration 0015 says: "user_id — the tenant is never named on a public
-- surface." Publishing an owner looks like a reversal. It is not, and the
-- distinction is the whole design:
--
--   * The tenant's identity still never leaves. verify_passport does not return
--     user_id, and this migration does not change that.
--   * What becomes public is an assertion the owner CHOSE to publish —
--     `published` defaults to false, and nothing is shown until it is true.
--   * The tier travels with it, always. A self-attested claim can never render
--     as a verified one, because the page keys its wording off tier, not kind.
--
-- The difference is between a tenant identity LEAKING and an owner ASSERTING.
-- 0015's rule governs the first and remains intact.
-- ============================================================================

-- Apply via scripts/migrate.sh, which ledgers each file in
-- public.schema_migrations and will not run this twice. Note this migration is
-- NOT safe to re-run by hand: `create policy` has no IF NOT EXISTS, so a second
-- manual apply errors after the table creation is skipped.
--
-- `user_id` is the primary key, so there is exactly one owner row per tenant.
-- That is load-bearing beyond tidiness: lib/owner/manage.ts upserts with
-- onConflict "user_id", readOwner and readCurrentOwner both use maybeSingle()
-- (which errors on more than one row), and verify_passport's LEFT JOIN below
-- would multiply agent rows without it.
create table if not exists public.agent_owners (
  user_id            uuid primary key references public.users(id) on delete cascade,
  kind               text not null check (kind in ('self_attested', 'domain', 'idv')),
  subject            text not null,
  tier               text not null default 'unverified'
                       check (tier in ('unverified', 'domain', 'idv')),
  published          boolean not null default false,
  verification_token text,
  verified_at        timestamptz,
  last_checked_at    timestamptz,
  failure_count      integer not null default 0,
  created_at         timestamptz not null default now()
);

comment on table public.agent_owners is
  'Who a tenant''s passports belong to, and how well that is evidenced. One row '
  'per tenant. Published rows surface on the public /verify page with their tier.';

comment on column public.agent_owners.tier is
  'How much the binding is worth. Never derive a verified label from `kind` — '
  'kind records the method attempted, tier records what was actually proven.';

alter table public.agent_owners enable row level security;

-- Read-your-own only. There is deliberately no insert/update/delete policy:
-- every mutation runs the verification ladder server-side under service_role.
-- Following 0011's precedent for agents.status, a client that could write its
-- own `tier` would make the tier meaningless — which is the entire point of it.
create policy agent_owners_select_own on public.agent_owners
  for select to authenticated using (user_id = (select auth.uid()));

grant select on public.agent_owners to authenticated;
revoke insert, update, delete on public.agent_owners from authenticated, anon;

-- ============================================================================
-- verify_passport v2 — same question, plus "whose is it?"
--
-- NOTE this is a DROP, not a `create or replace`. Postgres refuses to change the
-- return type of an existing function, and widening a RETURNS TABLE is exactly
-- that ("cannot change return type of existing function").
--
-- The drop is the dangerous part, and it is why the grants below are repeated
-- verbatim rather than assumed: dropping a function discards its ACL, and the
-- default for a NEWLY created function is EXECUTE to PUBLIC. Without the revoke
-- re-issued here, anon could call this RPC directly through PostgREST again —
-- silently undoing 0015's central protection. 0015 documents the same trap.
-- ============================================================================

drop function if exists public.verify_passport(text);

create function public.verify_passport(p_passport_id text)
returns table (
  passport_pubkey   text,
  status            text,
  created_at        timestamptz,
  owner_kind        text,
  owner_subject     text,
  owner_tier        text,
  owner_verified_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    a.passport_pubkey,
    a.status::text,
    a.created_at,
    o.kind,
    o.subject,
    o.tier,
    o.verified_at
  from public.agents a
  -- `and o.published` is part of the JOIN, not a WHERE: an unpublished owner
  -- must yield NULL owner columns, not suppress the passport row entirely.
  left join public.agent_owners o
    on o.user_id = a.user_id and o.published
  where a.passport_pubkey = p_passport_id
  limit 1
$$;

comment on function public.verify_passport(text) is
  'Public passport verification (PAVP). Returns the issued/revoked state of one '
  'passport by its public key, plus a published owner assertion and its tier. '
  'Never returns user_id, name, scopes, budgets, or traffic. SECURITY DEFINER, '
  'service_role execute only; the web tier gates anonymous access and rate limits it.';

-- Re-issued after the drop. See the note above: this is not belt-and-braces,
-- it is the only thing standing between anon and this function.
revoke all on function public.verify_passport(text) from public, anon, authenticated;
grant execute on function public.verify_passport(text) to service_role;
