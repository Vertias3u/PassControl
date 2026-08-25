-- Durable first-run progression. Individual guide steps remain derived from
-- provider credentials, agents, agent_logs, and admin_audit. This table stores
-- only a dismissal preference or the whole-flow completion milestone.
create table if not exists public.onboarding_state (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  dismissed_at timestamptz,
  completed_at timestamptz
);

alter table public.onboarding_state enable row level security;

drop policy if exists onboarding_state_select on public.onboarding_state;
create policy onboarding_state_select on public.onboarding_state
  for select to authenticated
  using (user_id = (select auth.uid()));

-- Preserve completion for operators who already proved the whole sequence
-- before this durable row existed. A model-bearing successful row is the same
-- inference/housekeeping distinction used by lib/call-class.ts, and the stop
-- event must follow the admitted call. Setup-like agent.update is intentionally
-- excluded: only these two audit actions prove a stop control was exercised.
insert into public.onboarding_state (user_id, completed_at)
select l.user_id, min(aa.created_at)
  from public.agent_logs as l
  join public.admin_audit as aa
    on aa.user_id = l.user_id
   and aa.action in ('killswitch.master', 'agent.suspend')
   and aa.created_at >= l.created_at
 where l.status = 'ok'
   and l.model is not null
   and btrim(l.model) <> ''
 group by l.user_id
on conflict (user_id) do update
  set completed_at = coalesce(public.onboarding_state.completed_at, excluded.completed_at);

-- Dismissal is a preference and therefore needs no claimed system evidence.
-- The RPC accepts no user id: auth.uid() is the only row it can address.
create or replace function public.dismiss_onboarding()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then return false; end if;

  insert into public.onboarding_state (user_id, dismissed_at)
  values (v_user_id, now())
  on conflict (user_id) do update
    set dismissed_at = coalesce(public.onboarding_state.dismissed_at, excluded.dismissed_at);

  return true;
end;
$$;

-- Completion is not a browser assertion. Recompute the whole milestone under a
-- narrow SECURITY DEFINER RPC so a tenant cannot forge completed_at directly.
-- The live guide uses a bounded display query; this persistence check uses the
-- authoritative history and will simply return false when evidence is absent.
create or replace function public.complete_onboarding()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then return false; end if;

  if not exists (
    select 1
      from public.agent_logs as l
      join public.agents as a
        on a.id = l.agent_id
       and a.user_id = v_user_id
     where l.user_id = v_user_id
       and l.status = 'ok'
       and l.model is not null
       and btrim(l.model) <> ''
       and a.status <> 'revoked'
       and exists (
         select 1
           from public.provider_credentials as pc
          where pc.user_id = v_user_id
       )
       and exists (
         select 1
           from public.admin_audit as aa
          where aa.user_id = v_user_id
            and aa.action in ('killswitch.master', 'agent.suspend')
            and aa.created_at >= l.created_at
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

revoke all on public.onboarding_state from public, anon, authenticated;
grant select on public.onboarding_state to authenticated;
grant all on public.onboarding_state to service_role;

revoke all on function public.dismiss_onboarding() from public, anon;
grant execute on function public.dismiss_onboarding() to authenticated;

revoke all on function public.complete_onboarding() from public, anon;
grant execute on function public.complete_onboarding() to authenticated;
