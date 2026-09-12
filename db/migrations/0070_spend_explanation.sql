-- PassControl — read-only explanation of the durable spend ledger.
--
-- The hot agent counters answer what budget admission has charged. This
-- function answers which durable gateway rows and operator reconstructions can
-- currently explain that total, using the exact same view and adjustment
-- precedence as rebuild_agent_spend. It performs no reconciliation and no
-- writes; a difference is evidence to show, not a number to hide.

create or replace function public.explain_workspace_spend(p_user_id uuid)
returns table (
  log_tokens bigint,
  log_microcents bigint,
  adjustment_tokens bigint,
  adjustment_microcents bigint,
  attributable_tokens bigint,
  attributable_microcents bigint,
  contributing_logs bigint,
  contributing_adjustments bigint,
  last_reconciled_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  with tenant_agents as (
    select a.id
      from public.agents a
     where a.user_id = p_user_id
  ),
  logs as (
    select coalesce(sum(l.spend_tokens), 0)::bigint as tokens,
           coalesce(sum(l.spend_microcents), 0)::bigint as microcents,
           count(*)::bigint as rows
      from public.agent_log_spend_rows l
      join tenant_agents a on a.id = l.agent_id
  ),
  adjustments as (
    select coalesce(sum(x.tokens), 0)::bigint as tokens,
           coalesce(sum(x.microcents), 0)::bigint as microcents,
           count(*)::bigint as rows
      from public.agent_spend_adjustments x
      join tenant_agents a on a.id = x.agent_id
     where not exists (
       select 1
         from public.agent_log_spend_rows r
        where r.attempt_id = x.attempt_id
     )
  ),
  checkpoint as (
    select max(c.reconciled_at) as at
      from public.agent_spend_checkpoint c
      join tenant_agents a on a.id = c.agent_id
  )
  select l.tokens,
         l.microcents,
         x.tokens,
         x.microcents,
         l.tokens + x.tokens,
         l.microcents + x.microcents,
         l.rows,
         x.rows,
         c.at
    from logs l cross join adjustments x cross join checkpoint c;
$$;

comment on function public.explain_workspace_spend(uuid) is
  'Read-only tenant spend explanation. Uses the same log view and adjustment precedence as rebuild_agent_spend; service-role callers compare it with live counters rather than changing either.';

revoke all on function public.explain_workspace_spend(uuid) from public, anon, authenticated;
grant execute on function public.explain_workspace_spend(uuid) to service_role;
