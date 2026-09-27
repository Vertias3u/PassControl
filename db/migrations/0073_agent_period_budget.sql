-- ============================================================================
-- PassControl — a periodic spend limit per agent (K1).
--
-- ── What this adds ────────────────────────────────────────────────────────
--
-- One optional limit per agent: at most `budget_period_cents` of spend in each
-- calendar UTC `budget_period` ('day' or 'month'). It sits beside the existing
-- cumulative caps (budget_tokens / budget_cents), which are unchanged and are
-- still checked first.
--
-- NO SECOND ACCOUNTING SYSTEM. The gateway derives period usage from the one
-- cumulative spend counter it already keeps in Redis, minus a snapshot of that
-- counter taken at the start of the period (lib/state/holds.ts, `pbase:`). The
-- ledger needs no new column: a call counts toward the period in which it
-- SETTLES, which is when its agent_logs row is written, so `created_at` already
-- attributes it.
--
-- ── Contents ──────────────────────────────────────────────────────────────
--
--   1. Two nullable columns, checked in the database (PostgREST can write them
--      directly, so a form is not the boundary), set together or not at all.
--   2. The same column UPDATE grant `authenticated` has on the cumulative caps
--      (0011), for the same reason: they are the tenant's own limits.
--   3. reconcile_agent_spend — SAME SIGNATURE, same body as 0056 except that a
--      period-only agent is now "budgeted" for the checkpoint and the floor, as
--      the gateway treats it.
--   4. agent_period_spend — what the ledger says an agent spent since a moment.
--      The gateway reads it once to seed a period snapshot it does not have, and
--      the operator rebuild reads it so a rebuild never hands back a period.
--
-- Additive. Old code ignores the columns; nothing is backfilled.
-- ============================================================================

-- ── 1. The limit ────────────────────────────────────────────────────────────

alter table public.agents
  add column if not exists budget_period text,
  add column if not exists budget_period_cents integer;

alter table public.agents
  drop constraint if exists agents_budget_period_kind,
  add constraint agents_budget_period_kind
    check (budget_period is null or budget_period in ('day', 'month')),
  drop constraint if exists agents_budget_period_cents_nonneg,
  add constraint agents_budget_period_cents_nonneg
    check (budget_period_cents is null or budget_period_cents >= 0),
  -- A period with no amount, or an amount with no period, is not a limit anyone
  -- set on purpose. Refusing the half-written pair keeps the gateway from
  -- having to guess which half was meant.
  drop constraint if exists agents_budget_period_pair,
  add constraint agents_budget_period_pair
    check ((budget_period is null) = (budget_period_cents is null));

comment on column public.agents.budget_period is
  'Calendar UTC period of the periodic spend limit: day or month. NULL = no periodic limit. Set together with budget_period_cents.';
comment on column public.agents.budget_period_cents is
  'Most this agent may spend per budget_period, in cents. A call counts toward the period in which it settles. Enforced atomically with the cumulative caps (lib/state/holds.ts).';

-- ── 2. The tenant may edit its own limit ────────────────────────────────────

grant update (budget_period, budget_period_cents) on public.agents to authenticated;

-- ── 3. Period-only agents are budgeted ──────────────────────────────────────
--
-- Identical to 0056 but for the two `or a.budget_period_cents is not null`
-- lines. Without them an agent limited only per period would get no checkpoint
-- and no reconcile floor, while the gateway fences and counts it like any other
-- budgeted agent.
create or replace function public.reconcile_agent_spend(p_lag_seconds int default 60)
returns table (agent_id uuid, spent_tokens bigint, spent_microcents bigint)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_cutoff timestamptz := now() - make_interval(secs => greatest(p_lag_seconds, 0));
begin
  insert into public.agent_spend_checkpoint (agent_id)
  select a.id
    from public.agents a
   where a.budget_tokens is not null
      or a.budget_cents is not null
      or a.budget_period_cents is not null
  on conflict (agent_id) do nothing;

  return query
  with delta as (
    select c.agent_id as aid,
           coalesce(sum(greatest(l.spend_tokens - coalesce((
             select x.tokens from public.agent_spend_adjustments x
              where x.attempt_id = l.attempt_id
           ), 0), 0)), 0)::bigint as token_delta,
           coalesce(sum(greatest(l.spend_microcents - coalesce((
             select x.microcents from public.agent_spend_adjustments x
              where x.attempt_id = l.attempt_id
           ), 0), 0)), 0)::bigint as cost_delta
      from public.agent_spend_checkpoint c
      join public.agents a
        on a.id = c.agent_id
       and (a.budget_tokens is not null
            or a.budget_cents is not null
            or a.budget_period_cents is not null)
      left join public.agent_log_spend_rows l
        on l.agent_id = c.agent_id
       and l.created_at > c.reconciled_at
       and l.created_at <= v_cutoff
     group by c.agent_id
  )
  update public.agent_spend_checkpoint c
     set spent_tokens = c.spent_tokens + delta.token_delta,
         spent_microcents = c.spent_microcents + delta.cost_delta,
         reconciled_at = v_cutoff,
         updated_at = now()
    from delta
   where delta.aid = c.agent_id
  returning c.agent_id, c.spent_tokens, c.spent_microcents;
end;
$$;

revoke all on function public.reconcile_agent_spend(int) from public, anon, authenticated;
grant execute on function public.reconcile_agent_spend(int) to service_role;

-- ── 4. What the ledger says was spent since a moment ────────────────────────
--
-- The same two sums rebuild_agent_spend takes (0056), windowed: every ledger
-- row since `p_since`, plus any operator adjustment since then for an attempt
-- the ledger has no row for. Observation wins over reconstruction, exactly as
-- in the rebuild, so the two can never disagree about one attempt.
--
-- Backed by agent_logs_agent_created_idx (0001): a day or a month of one agent.
create or replace function public.agent_period_spend(p_agent_id uuid, p_since timestamptz)
returns table (spent_tokens bigint, spent_microcents bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tokens bigint;
  v_microcents bigint;
  v_adj_tokens bigint;
  v_adj_microcents bigint;
begin
  select coalesce(sum(l.spend_tokens), 0)::bigint,
         coalesce(sum(l.spend_microcents), 0)::bigint
    into v_tokens, v_microcents
    from public.agent_log_spend_rows l
   where l.agent_id = p_agent_id
     and l.created_at >= p_since;

  select coalesce(sum(x.tokens), 0)::bigint,
         coalesce(sum(x.microcents), 0)::bigint
    into v_adj_tokens, v_adj_microcents
    from public.agent_spend_adjustments x
   where x.agent_id = p_agent_id
     and x.created_at >= p_since
     and not exists (
       select 1 from public.agent_log_spend_rows r
        where r.attempt_id = x.attempt_id
     );

  return query select v_tokens + v_adj_tokens, v_microcents + v_adj_microcents;
end;
$$;

comment on function public.agent_period_spend(uuid, timestamptz) is
  'Ledger spend for one agent since a moment: agent_log_spend_rows plus operator adjustments the ledger has no row for. Seeds and rebuilds the periodic-limit snapshot (lib/state/holds.ts). Service role only.';

revoke all on function public.agent_period_spend(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.agent_period_spend(uuid, timestamptz) to service_role;
