-- ============================================================================
-- PassControl — the public surfaces learn about expiry and rotation.
--
-- Two unauthenticated pages have been making false statements about people's
-- identities, and both for the same reason: neither RPC returned the columns
-- 0021 added, so neither TypeScript reader could have known.
--
--   /verify/<passportId>  reported an EXPIRED passport as "Valid". The gateway
--                         refuses it with `passport_expired`; the page vouched
--                         for it.
--   /verify/<passportId>  returned 404 for a key inside its ROTATION GRACE
--                         WINDOW — a key that authenticates right now. "No such
--                         passport" about a working credential is the same class
--                         of falsehood pointing the other way.
--   /u/<handle>           listed an expired agent as active, from its own
--                         separate RPC and its own separate status union.
--
-- The third is the one that would have survived a partial fix: widening
-- verify_passport does not touch public_operator_agents, and nothing in the
-- type system connects them. Both are widened here, in one migration, so the
-- two surfaces cannot drift apart again — and lib/passport-validity.ts derives
-- the answer once for both.
--
-- ── DROP and recreate, NOT `create or replace` ──────────────────────────────
--
-- Postgres refuses to change the return type of an existing function, and
-- widening a RETURNS TABLE is exactly that. 0017 and 0048 both hit this and both
-- documented the trap that comes with it, which is repeated here because it is
-- the whole risk of this file:
--
--   DROPPING A FUNCTION DISCARDS ITS ACL, and a newly created function defaults
--   to EXECUTE for PUBLIC. Without the revokes re-issued at the bottom, `anon`
--   could call these RPCs directly through PostgREST, undoing 0015's and 0033's
--   central protection. The grants below are not belt-and-braces; they are the
--   only thing standing between anon and these functions.
--
-- ── Raw columns out, derivation in TypeScript ───────────────────────────────
--
-- These functions return `expires_at` and the rotation deadline as stored, and
-- do NOT compute "expired" in SQL. Deriving it here would put the rule in three
-- places — the gateway's gate order, the SQL, and the readers — and the two
-- public surfaces would once again be free to disagree. One rule lives in
-- lib/passport-validity.ts and both readers call it.
--
-- ── verify_passport now matches the RETIRED key column too ──────────────────
--
-- and therefore has to cope with one id matching TWO agents: the two columns are
-- unique only within themselves, so an id can be tenant A's current key and
-- tenant V's retired one. findAuthenticatablePassport refuses that rather than
-- guessing an identity — "a valid signature attributed to the wrong tenant" is
-- what boundary #1 exists to prevent — and the public surface must refuse it
-- too, since resolving it would publish on a page anyone can read exactly the
-- claim the gateway declines to make. The refusal lives in
-- lib/verify/passport.ts, where it is testable, exactly as the gateway's lives
-- in TypeScript rather than in SQL.
--
-- `matched_rows` is how the caller sees the collision, and it is deliberately a
-- COUNT rather than the agent ids: the reader needs to know that two identities
-- answer to this key, never which. An internal uuid on an unauthenticated RPC
-- would be a new disclosure bought for nothing — and the two column-pinning
-- tests exist to make exactly that trade a conscious one.
--
-- It is a scalar subquery over `agents` alone, NOT `count(*) over ()`, so the
-- owner LEFT JOIN cannot inflate it into a false ambiguity refusal.
--
-- So the only new columns on this surface are the two deadlines, the matched-
-- column flag, and that count. Still no user_id, no agent id, no name, no
-- scopes, no budgets, no traffic.
-- ============================================================================

-- Apply via scripts/migrate.sh, which ledgers each file in
-- public.schema_migrations and will not run this twice.

-- ── verify_passport v4 ──────────────────────────────────────────────────────

drop function if exists public.verify_passport(text);

create function public.verify_passport(p_passport_id text)
returns table (
  passport_pubkey      text,
  status               text,
  created_at           timestamptz,
  expires_at           timestamptz,
  previous_valid_until timestamptz,
  matched_current      boolean,
  matched_rows         bigint,
  owner_kind           text,
  owner_subject        text,
  owner_tier           text,
  owner_verified_at    timestamptz,
  owner_company_id     text,
  owner_company_source text,
  owner_company_name   text,
  owner_company_active boolean,
  owner_company_at     timestamptz
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
    a.expires_at,
    a.previous_valid_until,
    (a.passport_pubkey = p_passport_id) as matched_current,
    -- How many agents answer to this key at all. The reader refuses when it is
    -- more than one; it never learns which agents, because it has no business
    -- knowing and this RPC is unauthenticated.
    (
      select count(*)
      from public.agents b
      where b.passport_pubkey = p_passport_id
         or b.previous_passport_pubkey = p_passport_id
    ) as matched_rows,
    o.kind,
    o.subject,
    o.tier,
    o.verified_at,
    o.company_id,
    o.company_source,
    o.company_name,
    o.company_active,
    o.company_checked_at
  from public.agents a
  -- `and o.published` stays part of the JOIN, not a WHERE: an unpublished owner
  -- must yield NULL owner columns, not suppress the passport row entirely.
  left join public.agent_owners o
    on o.user_id = a.user_id and o.published
  where a.passport_pubkey = p_passport_id
     or a.previous_passport_pubkey = p_passport_id
  -- The CURRENT-key match first, so a single row describes the live key when one
  -- agent's own rotation is mid-flight. `matched_rows` above, not the row count
  -- here, is what tells the caller a collision exists — so this stays at one row
  -- and no second tenant's lifecycle state is ever returned.
  order by matched_current desc
  limit 1
$$;

comment on function public.verify_passport(text) is
  'Public passport verification (PAVP). Returns the lifecycle state of one '
  'passport by its public key — matching either the current key or a key still '
  'inside its rotation grace window — plus the expiry and rotation deadlines a '
  'caller needs to judge validity, a published owner assertion with its tier, '
  'and an asserted company register line. matched_current says which column was '
  'matched; matched_rows says how many agents answer to this key, so the caller '
  'can refuse a cross-tenant collision rather than guess an identity — it is a '
  'count, never the identities. Never returns user_id, agent id, name, scopes, '
  'budgets, traffic, or a postal address. SECURITY DEFINER, service_role '
  'execute only.';

revoke all on function public.verify_passport(text) from public, anon, authenticated;
grant execute on function public.verify_passport(text) to service_role;

-- ── public_operator_agents v2 ───────────────────────────────────────────────
--
-- Same widening, smaller: this listing has no rotation concept — it publishes
-- current keys only — so it gains the expiry deadline and nothing else. The
-- WHERE clause is byte-identical to 0033's, including both opt-ins and both
-- not-null guards, and is repeated rather than altered because a recreate that
-- quietly relaxed one of those conditions would publish rows nobody chose to.

drop function if exists public.public_operator_agents(text, integer);

create function public.public_operator_agents(p_handle text, p_limit integer)
returns table (
  passport_pubkey text,
  label           text,
  status          text,
  created_at      timestamptz,
  expires_at      timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    a.passport_pubkey,
    a.public_label,
    a.status::text,
    a.created_at,
    a.expires_at
  from public.agents a
  join public.users u on u.id = a.user_id
  -- Both opt-ins, every time. An agent published under a profile that is later
  -- made private disappears with the profile.
  where u.username = lower(p_handle)
    and u.profile_public
    and a.published
    -- A Direct Agent Key agent has no passport (0023 dropped the NOT NULL), and
    -- the whole value of this list is that each row is independently checkable
    -- at /verify/<pubkey>. A row nobody can verify does not belong on it.
    and a.passport_pubkey is not null
    -- Belt and braces with agents_published_needs_label: never emit a blank row,
    -- and never be tempted to coalesce to a.name to avoid one.
    and a.public_label is not null
  order by a.created_at desc
  limit least(coalesce(p_limit, 24), 100)
$$;

comment on function public.public_operator_agents(text, integer) is
  'Published agents for one public operator profile, with the expiry deadline '
  'the caller needs to avoid listing an aged-out passport as active. Requires '
  'both opt-ins (users.profile_public and agents.published) and a passport and '
  'a public label. Never returns agents.name. SECURITY DEFINER, service_role '
  'execute only.';

revoke all on function public.public_operator_agents(text, integer) from public, anon, authenticated;
grant execute on function public.public_operator_agents(text, integer) to service_role;
