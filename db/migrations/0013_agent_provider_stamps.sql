-- ============================================================================
-- PassControl — one grouped aggregate for an agent's lifetime provider stamps.
--
-- The passport page needs, per provider, the first and last successful call and
-- the total count. PostgREST cannot GROUP BY, so the page was issuing two
-- queries per candidate provider — roughly fourteen round trips to render one
-- page. This collapses that into a single call.
--
-- SECURITY INVOKER (the default, stated explicitly here because every other
-- function in this schema is DEFINER and the difference matters): the caller's
-- own privileges apply, so the RLS policy on agent_logs — user_id =
-- (select auth.uid()) — is what scopes the result. p_user_id is a narrowing
-- assertion that mirrors the explicit filter the application already applies;
-- because RLS still runs, passing another tenant's id can only return fewer
-- rows, never more.
-- ============================================================================

create or replace function public.agent_provider_stamps(
  p_agent_id uuid,
  p_user_id  uuid
)
returns table (
  provider       text,
  first_seen_at  timestamptz,
  last_seen_at   timestamptz,
  recorded_calls bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    l.provider,
    min(l.created_at) as first_seen_at,
    max(l.created_at) as last_seen_at,
    count(*)          as recorded_calls
  from public.agent_logs l
  where l.agent_id = p_agent_id
    and l.user_id  = p_user_id
    and l.status   = 'ok'
    and l.provider is not null
  group by l.provider
  order by min(l.created_at), l.provider
$$;

comment on function public.agent_provider_stamps(uuid, uuid) is
  'Lifetime per-provider first/last/count of successful calls for one agent. '
  'SECURITY INVOKER: RLS on agent_logs is the access gate.';

-- Explicit grants: the implicit default-privilege grants do not reproduce on a
-- from-scratch apply (see 0007_grants.sql, which exists because of exactly that).
revoke all on function public.agent_provider_stamps(uuid, uuid) from public, anon;
grant execute on function public.agent_provider_stamps(uuid, uuid) to authenticated, service_role;

-- Supports the agent_id + status filter this function drives, and keeps the
-- aggregate off a full scan of an agent's history as agent_logs grows.
create index if not exists agent_logs_agent_provider_ok_idx
  on public.agent_logs (agent_id, provider, created_at)
  where status = 'ok';
