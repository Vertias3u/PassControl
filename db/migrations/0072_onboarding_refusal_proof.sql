-- The first-run guide ends on a deliberate refusal from the same worker, not on
-- any stop control anywhere in the workspace.
--
-- ── What 0037 accepted, and why it is not the proof ────────────────────────
--
-- 0037's complete_onboarding() completed on one admitted inference plus ANY
-- later `killswitch.master` or `agent.suspend` audit row in the tenant. That
-- proves an operator touched a switch. It does not prove the product refused
-- something this worker asked for: arming and immediately disarming the kill
-- switch satisfied it, so did suspending a different agent, so did a kill
-- switch that was already armed before the worker ever called.
--
-- v1 playbook Contract D sets the bar instead: an allowed, model-bearing
-- inference and a LATER intentional scope refusal from the SAME selected
-- worker, tied to a restriction the guide demonstrated. A model listing, an
-- unrelated agent's refusal, a kill-switch toggle, or a historical refusal that
-- predates the demonstration must not satisfy it.
--
-- ── What this stores ──────────────────────────────────────────────────────
--
-- Two columns on the existing row: which agent the guide's refusal test is for
-- and when the operator started it. That is the "agent-scoped, timestamped
-- guide step" — the minimum needed to tell a deliberate demonstration from a
-- refusal that merely happened. No step results are stored; every stage is
-- still derived from agents and agent_logs.
--
-- start_onboarding_refusal_test() is the only writer. It accepts an agent id,
-- binds the row to auth.uid(), and refuses an agent the caller does not own or
-- that is revoked. Restarting moves the timestamp forward, which only ever
-- makes the proof stricter.
--
-- ── Completion ─────────────────────────────────────────────────────────────
--
-- complete_onboarding() now requires, for the started agent:
--   * an `ok` row with a model (an inference, not a listing), and
--   * a `blocked_scope` row with a model, at or after the test started and
--     after that `ok` row,
--   * from the same installation key when both rows carry one. A Passport row
--     has no key id, and old rows may lack one; the agent binding still holds.
-- The agent must not be revoked and a provider credential must be stored, as
-- before. Nothing else completes it.
--
-- ── Existing accounts ──────────────────────────────────────────────────────
--
-- completed_at and dismissed_at are preserved exactly: the upsert still
-- coalesces, and nothing here clears either. An account 0037 completed stays
-- completed — which is NOT a claim that it was re-verified under this rule.
--
-- ── Deploy order: after the code, with 0071, in one migrate run ──────────────
--
-- scripts/migrate.sh applies every pending file in numeric order, so 0072
-- cannot go ahead of 0071 — and 0071 must follow the gateway code that reads
-- `agent_status`. Both therefore follow the code, which is safe for 0072 too:
-- the new dashboard reads its two columns in a query of their own and shows
-- the refusal step as unavailable until they exist, and the old dashboard
-- under this migration can only complete FEWER accounts, never more.

alter table public.onboarding_state
  add column if not exists refusal_test_agent_id uuid
    references public.agents(id) on delete set null,
  add column if not exists refusal_test_started_at timestamptz;

create or replace function public.start_onboarding_refusal_test(p_agent_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_started timestamptz := now();
begin
  if v_user_id is null or p_agent_id is null then return null; end if;

  if not exists (
    select 1
      from public.agents as a
     where a.id = p_agent_id
       and a.user_id = v_user_id
       and a.status <> 'revoked'
  ) then
    return null;
  end if;

  insert into public.onboarding_state (user_id, refusal_test_agent_id, refusal_test_started_at)
  values (v_user_id, p_agent_id, v_started)
  on conflict (user_id) do update
    set refusal_test_agent_id = excluded.refusal_test_agent_id,
        refusal_test_started_at = excluded.refusal_test_started_at;

  return v_started;
end;
$$;

create or replace function public.complete_onboarding()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_agent_id uuid;
  v_started timestamptz;
begin
  if v_user_id is null then return false; end if;

  select s.refusal_test_agent_id, s.refusal_test_started_at
    into v_agent_id, v_started
    from public.onboarding_state as s
   where s.user_id = v_user_id;

  if v_agent_id is null or v_started is null then return false; end if;

  if not exists (
    select 1
      from public.agent_logs as allowed
      join public.agents as a
        on a.id = allowed.agent_id
       and a.user_id = v_user_id
       and a.status <> 'revoked'
      join public.agent_logs as refused
        on refused.agent_id = allowed.agent_id
       and refused.user_id = v_user_id
     where allowed.user_id = v_user_id
       and allowed.agent_id = v_agent_id
       and allowed.status = 'ok'
       and allowed.model is not null
       and btrim(allowed.model) <> ''
       and refused.status = 'blocked_scope'
       and refused.model is not null
       and btrim(refused.model) <> ''
       and refused.created_at >= v_started
       and refused.created_at > allowed.created_at
       and (
         allowed.agent_access_key_id is null
         or refused.agent_access_key_id is null
         or allowed.agent_access_key_id = refused.agent_access_key_id
       )
       and exists (
         select 1
           from public.provider_credentials as pc
          where pc.user_id = v_user_id
       )
  ) then
    return false;
  end if;

  insert into public.onboarding_state (user_id, completed_at)
  values (v_user_id, now())
  on conflict (user_id) do update
    set completed_at = coalesce(public.onboarding_state.completed_at, excluded.completed_at);

  return true;
end;
$$;

revoke all on function public.start_onboarding_refusal_test(uuid) from public, anon;
grant execute on function public.start_onboarding_refusal_test(uuid) to authenticated;

revoke all on function public.complete_onboarding() from public, anon;
grant execute on function public.complete_onboarding() to authenticated;
