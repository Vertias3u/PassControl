-- ============================================================================
-- PassControl — enforce budget_cents on the hot path.
--
-- The proxy now reserves estimated provider cost in Redis before the upstream
-- call. This migration extends the authoritative checkpoint so reconcile can
-- reseed Redis spent_cost:<agid> after restarts/drift, just like spent:<agid>.
-- budget_cents remains stored in integer cents; hot-path counters use micro-cents.
-- ============================================================================

alter table public.agent_spend_checkpoint
  add column if not exists spent_microcents bigint not null default 0;

-- Existing token-budget checkpoints may already have advanced their watermark.
-- Backfill their cost total up to that watermark so future reconciles add only
-- newly-settled rows and do not lose historical spend across this migration.
update public.agent_spend_checkpoint c
   set spent_microcents = coalesce((
     select sum(coalesce(l.cost_microcents, 0))::bigint
       from public.agent_logs l
      where l.agent_id = c.agent_id
        and l.status = 'ok'
        and l.created_at <= c.reconciled_at
   ), 0)
 where c.reconciled_at > 'epoch'::timestamptz;

drop function if exists public.reconcile_agent_spend(int);
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
  -- Ensure a checkpoint row exists for every budgeted agent. Cost-only budgets
  -- need the same authoritative reseed path as token budgets.
  insert into public.agent_spend_checkpoint (agent_id)
  select a.id
    from public.agents a
   where a.budget_tokens is not null
      or a.budget_cents is not null
  on conflict (agent_id) do nothing;

  return query
  with delta as (
    select c.agent_id as aid,
           coalesce(sum(coalesce(l.input_tokens, 0) + coalesce(l.output_tokens, 0)), 0)::bigint as token_delta,
           coalesce(sum(coalesce(l.cost_microcents, 0)), 0)::bigint as cost_delta
      from public.agent_spend_checkpoint c
      join public.agents a
        on a.id = c.agent_id
       and (a.budget_tokens is not null or a.budget_cents is not null)
      left join public.agent_logs l
        on l.agent_id = c.agent_id
       and l.status = 'ok'
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
