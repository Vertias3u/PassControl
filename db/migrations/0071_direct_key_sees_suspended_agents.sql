-- A suspended agent's Direct Agent Key is a valid key for a stopped agent.
--
-- ── The hole this closes ────────────────────────────────────────────────────
--
-- 0023's `authenticate_direct_agent_key` joined the key to its agent with
-- `a.status = 'active'`. That made a SUSPENDED agent's key indistinguishable
-- from a key that never existed: the RPC returned no row, the gateway answered
-- 401 `invalid_credential`, and — because no principal was ever established —
-- no `agent_logs` row was written. The proxy's suspend gate, which answers 403
-- `blocked_suspended` and records the refusal, was never reached.
--
-- Found live on 2026-09-21 with an unchanged external workload on a Direct
-- Agent Key: the tenant kill switch produced "Kill switch" audit rows exactly
-- as designed, and suspending the agent produced nothing at all. The call was
-- still refused, so no request leaked — but an operator who suspends an agent
-- during an incident is told nothing about what that agent then tried to do,
-- and the agent's owner sees an authentication failure rather than the reason.
--
-- The passport path never had this: a visa already minted carries the agent id,
-- and the Redis `suspended:<agid>` gate refuses it with a reason.
--
-- ── What this does ─────────────────────────────────────────────────────────
--
-- The lookup admits `active` and `suspended` agents and returns the status as
-- `agent_status`. The gateway treats `suspended` as a refusal in the same gate
-- as the Redis flag, so either record of a suspension denies on its own: Redis
-- is the hot-path copy, `agents.status` the durable one.
--
-- `revoked` stays excluded here, so a revoked agent's key keeps answering the
-- generic 401 — revocation is terminal, and the key is no longer a credential.
-- The list is written positively (`in ('active', 'suspended')`) so that a status
-- added to the enum later is refused until someone decides otherwise.
--
-- The return shape changes, which `create or replace` cannot do, so the function
-- is dropped and recreated (the runner applies each file in one transaction)
-- and its grants restated.
--
-- ── Deploy order: gateway code FIRST, then this migration ───────────────────
--
-- The code reads a missing `agent_status` as active (the only thing the old RPC
-- ever returned), so new code on the old RPC behaves exactly as today.
--
-- The reverse order is NOT safe. With this applied and the OLD code running, the
-- RPC now returns a principal for a suspended agent, and the old code consults
-- only the Redis `suspended:<agid>` flag. If that flag has been lost, the call is
-- ADMITTED — where today it is refused with a 401. Apply this only once the
-- gateway that reads `agent_status` is serving.

drop function if exists public.authenticate_direct_agent_key(text);

create function public.authenticate_direct_agent_key(p_key_hash text)
returns table (
  key_id uuid,
  agent_id uuid,
  user_id uuid,
  allowed_scopes jsonb,
  break_glass_scopes jsonb,
  budget_tokens bigint,
  budget_cents integer,
  spent_tokens bigint,
  spent_microcents bigint,
  agent_status text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    k.id,
    a.id,
    a.user_id,
    a.allowed_scopes,
    grant_row.scopes,
    a.budget_tokens,
    a.budget_cents,
    a.spent_tokens,
    a.spent_microcents,
    a.status::text
  from public.agent_access_keys as k
  join public.agents as a
    on a.id = k.agent_id
   and a.user_id = k.user_id
  left join lateral (
    select g.scopes
      from public.break_glass_grants as g
     where g.user_id = a.user_id
       and g.agent_id = a.id
       and g.revoked_at is null
       and g.expires_at > now()
     order by g.expires_at desc
     limit 1
  ) as grant_row on true
  where k.key_hash = p_key_hash
    and k.revoked_at is null
    and (k.expires_at is null or k.expires_at > now())
    and a.status in ('active', 'suspended')
  limit 1;
$$;

revoke all on function public.authenticate_direct_agent_key(text) from public, anon, authenticated;
grant execute on function public.authenticate_direct_agent_key(text) to service_role;
