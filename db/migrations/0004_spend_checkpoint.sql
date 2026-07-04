-- ============================================================================
-- PassControl — incremental spend reconciliation (replaces the full agent_logs
-- scan per agent in the reconcile cron).
--
-- agent_logs is append-only, so the authoritative spend is a running sum. Rather
-- than re-summing all history every run (O(all rows) per agent), we keep a
-- cron-owned checkpoint per agent and fold in only rows that have SETTLED since
-- the last run (O(new rows)). The checkpoint total stays exactly equal to the
-- full sum because no row is ever lost or double-counted:
--   * watermark advances to a CUTOFF = now() - p_lag_seconds;
--   * we sum rows with created_at in (reconciled_at, cutoff];
--   * the lag guarantees a row whose created_at precedes the cutoff but whose
--     commit lands after the reconcile snapshot is still picked up next run
--     (it can't fall on the wrong side of a future cutoff).
-- The hot-path budget counter is maintained live by the proxy; this correction
-- layer may safely lag by p_lag_seconds.
-- ============================================================================

create table if not exists public.agent_spend_checkpoint (
  agent_id      uuid primary key references public.agents(id) on delete cascade,
  spent_tokens  bigint not null default 0,           -- running authoritative sum (ok rows)
  reconciled_at timestamptz not null default 'epoch', -- watermark: rows up to here are folded in
  updated_at    timestamptz not null default now()
);

-- Service-role only: clients have no read/write path. RLS enabled with NO policy
-- denies authenticated/anon entirely; the service-role cron RPC bypasses RLS.
alter table public.agent_spend_checkpoint enable row level security;

-- ── reconcile_agent_spend: incremental, authoritative spend per budgeted agent ─
create or replace function public.reconcile_agent_spend(p_lag_seconds int default 60)
returns table (agent_id uuid, spent_tokens bigint)
language plpgsql
security definer
set search_path = ''
as $$
-- RETURNS TABLE declares agent_id/spent_tokens as variables that would otherwise
-- shadow the table columns; resolve unqualified names to columns.
#variable_conflict use_column
declare
  v_cutoff timestamptz := now() - make_interval(secs => greatest(p_lag_seconds, 0));
begin
  -- Ensure a checkpoint row exists for every budgeted agent. A fresh row starts
  -- at the epoch watermark, so its first reconcile folds in full history once.
  insert into public.agent_spend_checkpoint (agent_id)
  select a.id from public.agents a where a.budget_tokens is not null
  on conflict (agent_id) do nothing;

  -- Fold newly-settled ok-row tokens into each budgeted agent's running total,
  -- advance its watermark to the cutoff, and return the new totals.
  return query
  with delta as (
    select c.agent_id as aid,
           coalesce(sum(coalesce(l.input_tokens, 0) + coalesce(l.output_tokens, 0)), 0)::bigint as d
    from public.agent_spend_checkpoint c
    join public.agents a on a.id = c.agent_id and a.budget_tokens is not null
    left join public.agent_logs l
      on l.agent_id = c.agent_id
     and l.status = 'ok'
     and l.created_at > c.reconciled_at
     and l.created_at <= v_cutoff
    group by c.agent_id
  )
  update public.agent_spend_checkpoint c
     set spent_tokens = c.spent_tokens + delta.d,
         reconciled_at = v_cutoff,
         updated_at = now()
    from delta
   where delta.aid = c.agent_id
  returning c.agent_id, c.spent_tokens;
end;
$$;

revoke all on function public.reconcile_agent_spend(int) from public, anon, authenticated;
grant execute on function public.reconcile_agent_spend(int) to service_role;
