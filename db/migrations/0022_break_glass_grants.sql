-- ============================================================================
-- PassControl — break-glass elevation.
--
-- This is a deliberate hole in the capability model, and it ships last for that
-- reason: a hole nobody can review afterwards is worse than no hole.
--
-- The problem it solves is real. An agent's scope is minted into its visa, so
-- widening `allowed_scopes` for a one-off incident means editing the stored
-- capability — and then remembering to put it back. What actually happens is
-- that nobody puts it back, and six months later the agent is permanently
-- allowed something it needed once, with the row asserting it was always so.
--
-- ── Mechanism: a time-boxed grant read at mint time ─────────────────────────
--
-- The visa's scope snapshot becomes `agents.allowed_scopes` UNION any live
-- grant. Three properties fall out rather than being engineered:
--
--   * IT EXPIRES ITSELF. A visa lives minutes, so a lapsed grant simply stops
--     being minted. The hole closes with no cron, no scheduled revert, and
--     nothing that can fail.
--   * THE STORED CAPABILITY NEVER LIES. allowed_scopes still says what this
--     agent is normally permitted. Widening the row and scheduling a revert has
--     the opposite property: a failed revert leaves the agent permanently
--     elevated AND the row claiming that was always correct.
--   * THE HOT PATH DOES NOT CHANGE. The proxy keeps gating on claims.scope
--     exactly as before. It does not learn that break-glass exists.
--
-- ── What this does NOT widen ───────────────────────────────────────────────
--
-- Scope, and nothing else. The kill switch, per-agent suspend, policy deny
-- rules and budgets all still apply, because every one of them is checked after
-- scope on a path this feature never touches. An operator who needs to get past
-- a deny rule should change the deny rule — that is a reviewable act with an
-- audit row, which is the entire point. tests/break-glass.test.ts pins this,
-- because the obvious next request is to make break-glass override policy too.
--
-- ── reason is NOT NULL, at the schema level ────────────────────────────────
--
-- An elevation with no stated reason is an elevation nobody can review, and the
-- audit trail is the whole justification for having this feature at all. A
-- default would let a caller omit it; a check constraint stops it being blank.
--
-- ── No client insert path, at all ──────────────────────────────────────────
--
-- Following 0017: select-your-own and nothing else. A client that could write
-- its own grant would make the mechanism decorative — it would be a way for a
-- tenant to give themselves any scope they liked, which is precisely what
-- `allowed_scopes` exists to prevent.
-- ============================================================================

create table if not exists public.break_glass_grants (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users(id) on delete cascade,
  agent_id    uuid not null references public.agents(id) on delete cascade,
  scopes      jsonb not null,
  reason      text not null check (length(btrim(reason)) between 1 and 500),
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz
);

-- ── At most one unrevoked grant per agent ──────────────────────────────────
--
-- The predicate is `revoked_at is null` and NOT "…and expires_at > now()",
-- which is what this wants to say. Postgres refuses a STABLE function in an
-- index predicate ("functions in index predicate must be marked IMMUTABLE"), and
-- now() is STABLE — verified against this exact database rather than assumed.
--
-- So expiry alone does not free the slot. Two things close that gap, in the
-- order that matters:
--
--   1. THE CODE decides whether a grant is live: revoked_at is null AND
--      expires_at > now(). That is what the mint reads and what the grant path
--      checks. It is correct whether or not anything else ever runs.
--   2. THE RECONCILE SWEEP stamps revoked_at on lapsed grants, which frees the
--      slot for the next incident. Housekeeping, exactly as in 0021: a cron
--      that has not run must never be the reason an elevation persists, and it
--      is not — a lapsed grant stops being minted the moment it lapses.
create unique index if not exists break_glass_one_live_per_agent
  on public.break_glass_grants (agent_id)
  where revoked_at is null;

-- The mint-time read: this agent's live grant. Tenant-scoped because every
-- query in this product is, even where agent_id alone would be unique.
create index if not exists break_glass_live_idx
  on public.break_glass_grants (user_id, agent_id, expires_at desc)
  where revoked_at is null;

comment on table public.break_glass_grants is
  'Time-boxed scope elevation. The visa mint unions a live grant into the scope '
  'snapshot; nothing else in the request path knows this table exists. Widens '
  'scope ONLY — kill switch, suspend, policy and budget all still apply.';

comment on column public.break_glass_grants.reason is
  'Why this elevation was taken. Mandatory: an elevation nobody can review is '
  'the failure mode this table exists to prevent.';

comment on column public.break_glass_grants.expires_at is
  'When the elevation stops being minted into new visas. An ALREADY-MINTED visa '
  'keeps the elevation until it expires — at most VISA_TTL_SECONDS. The same is '
  'true of revoked_at, and both the API and the UI say so.';

alter table public.break_glass_grants enable row level security;

-- Read-your-own only. There is deliberately no insert/update/delete policy: the
-- grant path is a validated server action on the service-role client, which is
-- also where the TTL cap, the scope validation and the one-live-grant rule are
-- enforced. See 0011 for why a column allowlist rather than RLS alone is what
-- makes that stick, and 0017 for the same posture on agent_owners.
create policy break_glass_select_own on public.break_glass_grants
  for select to authenticated using (user_id = (select auth.uid()));

grant select on public.break_glass_grants to authenticated;
revoke insert, update, delete on public.break_glass_grants from authenticated, anon;
