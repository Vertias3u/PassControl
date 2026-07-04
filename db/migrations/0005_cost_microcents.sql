-- ============================================================================
-- PassControl — track cost in MICRO-CENTS instead of integer cents.
--
-- Per-call LLM costs are routinely a few thousandths of a cent. Stored as integer
-- cents (with Math.round in the app), every sub-cent call rounded to 0, so spend
-- tracking silently under-counted to nothing. Switch the two ACCUMULATING cost
-- columns to micro-cents (1 cent = 1_000_000 µ¢; 1 USD = 100_000_000 µ¢) as
-- bigint. Per-token prices are exact integers in µ¢, so totals never drift.
--
-- budget_cents is left in cents: it is user-configured cap granularity and is not
-- enforced on the hot path (the proxy caps on tokens). Only the accumulating
-- columns needed the finer unit.
-- ============================================================================

-- agent_logs.cost_cents -> cost_microcents (bigint), scaling existing values.
alter table public.agent_logs rename column cost_cents to cost_microcents;
alter table public.agent_logs alter column cost_microcents type bigint;
update public.agent_logs set cost_microcents = cost_microcents * 1000000
 where cost_microcents is not null;

-- agents.spent_cents -> spent_microcents (bigint, not null default 0).
alter table public.agents rename column spent_cents to spent_microcents;
alter table public.agents alter column spent_microcents type bigint;
update public.agents set spent_microcents = spent_microcents * 1000000;

-- Replace the spend-mirror RPC: p_cents (integer) -> p_microcents (bigint).
drop function if exists public.increment_agent_spend(uuid, bigint, integer);
create or replace function public.increment_agent_spend(
  p_agent_id uuid,
  p_tokens bigint,
  p_microcents bigint
)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.agents
     set spent_tokens     = spent_tokens     + coalesce(p_tokens, 0),
         spent_microcents = spent_microcents + coalesce(p_microcents, 0)
   where id = p_agent_id;
$$;

revoke all on function public.increment_agent_spend(uuid, bigint, bigint) from public, anon, authenticated;
grant execute on function public.increment_agent_spend(uuid, bigint, bigint) to service_role;
