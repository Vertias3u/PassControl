-- ============================================================================
-- PassControl — create_direct_agent can set a periodic spend limit (F1).
--
-- ── Why ───────────────────────────────────────────────────────────────────
--
-- A new agent made from the dashboard now starts with a $20 a day limit unless
-- its owner removes it (lib/new-agent-spend-limit.ts). The passport paths insert
-- the K1 columns (0073) directly. A Direct Agent Key agent is created only by
-- this RPC, which makes the agent AND its reveal-once key in one transaction and
-- had no period parameters, so the most common on-ramp could not carry the limit.
--
-- Setting the limit with a separate UPDATE after the RPC is not an option: if
-- that write failed, the owner would already hold a key for an agent with no
-- limit. The limit has to be written in the same insert as the agent.
--
-- ── What changes ──────────────────────────────────────────────────────────
--
--   1. The 9-argument signature from 0023 is DROPPED, not overloaded. Two
--      signatures that both accept a 9-argument named call make PostgREST refuse
--      it as ambiguous.
--   2. The new signature adds p_budget_period and p_budget_period_cents, both
--      DEFAULT NULL, so a deploy still running older code (9 named arguments)
--      keeps working against it, creating an agent with no periodic limit as
--      before. The table's own agents_budget_period_pair check refuses a half pair.
--   3. EXECUTE for service_role only, exactly as 0023. A new signature starts
--      with EXECUTE granted to PUBLIC, and this SECURITY DEFINER function inserts
--      an agent for whatever p_user_id it is handed, so the revoke is the point
--      of this migration as much as the parameters are.
--
-- Body otherwise identical to 0023's.
--
-- ORDER AT RELEASE: apply this BEFORE deploying code that passes the new
-- parameters. That code passes them only when there is a limit to set, so before
-- 0082 every Direct Agent Key created from the dashboard with a limit fails.
-- ============================================================================

drop function if exists public.create_direct_agent(uuid, text, jsonb, bigint, integer, text, text, text, timestamptz);

create or replace function public.create_direct_agent(
  p_user_id uuid,
  p_name text,
  p_scopes jsonb,
  p_budget_tokens bigint,
  p_budget_cents integer,
  p_key_name text,
  p_key_hash text,
  p_key_suffix text,
  p_expires_at timestamptz default null,
  p_budget_period text default null,
  p_budget_period_cents integer default null
)
returns table (agent_id uuid, key_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_agent_id uuid;
  v_key_id uuid;
  v_active_keys integer;
begin
  perform pg_advisory_xact_lock(hashtext(p_user_id::text)::bigint);

  select count(*)
    into v_active_keys
    from public.agent_access_keys as k
   where k.user_id = p_user_id
     and k.revoked_at is null
     and (k.expires_at is null or k.expires_at > now());
  if v_active_keys >= 50 then
    raise exception 'active_key_limit' using errcode = 'P0001';
  end if;

  insert into public.agents (
    user_id, name, passport_pubkey, allowed_scopes, budget_tokens, budget_cents,
    budget_period, budget_period_cents
  ) values (
    p_user_id, btrim(p_name), null, p_scopes, p_budget_tokens, p_budget_cents,
    p_budget_period, p_budget_period_cents
  )
  returning id into v_agent_id;

  insert into public.agent_access_keys (
    user_id, agent_id, name, key_hash, key_suffix, expires_at
  ) values (
    p_user_id, v_agent_id, btrim(p_key_name), p_key_hash, p_key_suffix, p_expires_at
  )
  returning id into v_key_id;

  return query select v_agent_id, v_key_id;
end;
$$;

revoke all on function public.create_direct_agent(uuid, text, jsonb, bigint, integer, text, text, text, timestamptz, text, integer)
  from public, anon, authenticated;
grant execute on function public.create_direct_agent(uuid, text, jsonb, bigint, integer, text, text, text, timestamptz, text, integer)
  to service_role;
