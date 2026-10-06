-- 0076: per-account limits on agents, agent keys, provider credentials and
-- control-API keys, enforced in the database.
--
-- WHY HERE. Agents are created by three paths (the dashboard, the control API,
-- workspace import) and keys and credentials by several RPCs. A cap in one
-- server action leaves the others open. A BEFORE INSERT trigger is the one
-- place every path meets, including ones not written yet.
--
-- WHY NOW. Open signup (plans/open-signup-readiness.md). An account is free to
-- make, and with no limit a script could fill the free database tier from one
-- confirmed address.
--
-- NOTHING CHANGES UNTIL AN OPERATOR SETS A NUMBER. The 'default' row starts
-- with every limit NULL, which means unlimited, so a self-hosted install and
-- Cloud both behave exactly as before this migration until someone runs the
-- UPDATE in plans/open-signup-readiness.md.
--
-- TWO BOUNDS PER KIND:
--   live  — objects currently usable (not revoked, not expired). The limit a
--           person notices.
--   daily — creations in the last 24 hours, revoked ones INCLUDED. There is no
--           hard delete for agents or keys, so a live-only cap would let a
--           script create, revoke and repeat forever: unbounded rows. This one
--           bounds that churn.
--
-- NEVER IN THE WAY OF A SECURITY ACTION. Revoking, suspending and rotating are
-- UPDATEs, which these triggers do not see (except the one below). Rotating a
-- provider key updates its row in place (0030). Only creating something new
-- counts.
--
-- Refusals raise `account_limit_reached:<kind>:<live|daily>:<limit>`, which
-- lib/account-limits.ts turns into a sentence.

create table if not exists public.account_object_limits (
  -- 'default', or one account's user id for a per-account override. A NULL
  -- column in an override inherits the default; a NULL default is unlimited.
  scope text primary key
    check (scope = 'default' or scope ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  max_agents integer check (max_agents >= 0),
  max_keys_per_agent integer check (max_keys_per_agent >= 0),
  max_credentials integer check (max_credentials >= 0),
  max_api_keys integer check (max_api_keys >= 0),
  max_creations_per_day integer check (max_creations_per_day >= 0),
  updated_at timestamptz not null default now()
);

comment on table public.account_object_limits is
  'Per-account caps on agents, agent keys, provider credentials and control-API '
  'keys (0076). Row ''default'' applies to everyone; a row keyed by a user id '
  'overrides it column by column. NULL = unlimited (default) or inherit (override). '
  'Service-role only.';

insert into public.account_object_limits (scope) values ('default')
on conflict (scope) do nothing;

-- Operator configuration, never tenant-visible: the same lesson as the
-- migration ledger, where Supabase's default privileges made a new public
-- table world-readable through PostgREST.
alter table public.account_object_limits enable row level security;
revoke all on public.account_object_limits from public, anon, authenticated;
grant select, insert, update, delete on public.account_object_limits to service_role;

/** One limit for one account: its override if set, else the default, else NULL. */
create or replace function public.account_object_limit(p_user_id uuid, p_column text)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_override integer;
  v_default integer;
begin
  if p_column not in ('max_agents', 'max_keys_per_agent', 'max_credentials', 'max_api_keys', 'max_creations_per_day') then
    raise exception 'unknown account limit %', p_column;
  end if;
  execute format('select %I from public.account_object_limits where scope = $1', p_column)
    into v_override using p_user_id::text;
  execute format('select %I from public.account_object_limits where scope = ''default''', p_column)
    into v_default;
  return coalesce(v_override, v_default);
end;
$$;

revoke all on function public.account_object_limit(uuid, text) from public, anon, authenticated;
grant execute on function public.account_object_limit(uuid, text) to service_role;

create or replace function public.enforce_account_object_limits()
returns trigger
language plpgsql
-- DEFINER so the counts below see every row of the account. Under the
-- inserting role's RLS they could undercount; under no RLS at all they would
-- still be scoped by the explicit user_id / agent_id predicates.
security definer
set search_path = ''
as $$
declare
  v_kind text;
  v_user uuid := new.user_id;
  v_live_limit integer;
  v_daily_limit integer := public.account_object_limit(new.user_id, 'max_creations_per_day');
  v_live bigint;
  v_daily bigint;
begin
  if v_user is null then
    return new;
  end if;

  if tg_table_name = 'agents' then
    v_kind := 'agents';
    -- An UPDATE reaches here only when a revoked agent is brought back (see
    -- the trigger's WHEN). App code refuses that today; the database does too,
    -- once that would exceed the live cap.
    v_live_limit := public.account_object_limit(v_user, 'max_agents');
  elsif tg_table_name = 'agent_access_keys' then
    v_kind := 'agent_keys';
    v_live_limit := public.account_object_limit(v_user, 'max_keys_per_agent');
  elsif tg_table_name = 'provider_credentials' then
    v_kind := 'credentials';
    v_live_limit := public.account_object_limit(v_user, 'max_credentials');
  elsif tg_table_name = 'api_keys' then
    v_kind := 'api_keys';
    v_live_limit := public.account_object_limit(v_user, 'max_api_keys');
  else
    raise exception 'enforce_account_object_limits: unexpected table %', tg_table_name;
  end if;

  if v_live_limit is null and (v_daily_limit is null or tg_op <> 'INSERT') then
    return new;
  end if;

  -- One account, one kind, one at a time. Without this, two concurrent inserts
  -- both count N-1 and both commit: N+1. Transaction-scoped, released at commit.
  perform pg_advisory_xact_lock(hashtextextended('account_limit:' || v_kind || ':' || v_user::text, 0));

  if v_live_limit is not null then
    if v_kind = 'agents' then
      select count(*) into v_live from public.agents
       where user_id = v_user and status <> 'revoked';
    elsif v_kind = 'agent_keys' then
      -- Per AGENT: rotating one agent's key must never be blocked by another's.
      select count(*) into v_live from public.agent_access_keys
       where agent_id = new.agent_id and revoked_at is null
         and (expires_at is null or expires_at > now());
    elsif v_kind = 'credentials' then
      select count(*) into v_live from public.provider_credentials
       where user_id = v_user;
    else
      -- Expired keys are dead: every `passcontrol login` mints one with an idle
      -- window, so counting expired ones would lock out a busy operator's CLI.
      select count(*) into v_live from public.api_keys
       where user_id = v_user and revoked_at is null
         and (expires_at is null or expires_at > now());
    end if;

    if v_live >= v_live_limit then
      raise exception 'account_limit_reached:%:live:%', v_kind, v_live_limit
        using errcode = 'P0001',
              hint = 'Revoke one that is no longer used, or ask the operator for a higher limit.';
    end if;
  end if;

  if tg_op = 'INSERT' and v_daily_limit is not null then
    if v_kind = 'agents' then
      select count(*) into v_daily from public.agents
       where user_id = v_user and created_at > now() - interval '1 day';
    elsif v_kind = 'agent_keys' then
      select count(*) into v_daily from public.agent_access_keys
       where user_id = v_user and created_at > now() - interval '1 day';
    elsif v_kind = 'credentials' then
      select count(*) into v_daily from public.provider_credentials
       where user_id = v_user and created_at > now() - interval '1 day';
    else
      select count(*) into v_daily from public.api_keys
       where user_id = v_user and created_at > now() - interval '1 day';
    end if;

    if v_daily >= v_daily_limit then
      raise exception 'account_limit_reached:%:daily:%', v_kind, v_daily_limit
        using errcode = 'P0001',
              hint = 'Too many created in the last 24 hours. Try again later.';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_account_object_limits() from public, anon, authenticated;

comment on function public.enforce_account_object_limits() is
  'BEFORE INSERT guard for agents, agent_access_keys, provider_credentials and '
  'api_keys (0076): refuses past the account''s live cap or 24-hour creation cap '
  'with account_limit_reached:<kind>:<live|daily>:<limit>.';

drop trigger if exists enforce_account_object_limits on public.agents;
create trigger enforce_account_object_limits
  before insert on public.agents
  for each row execute function public.enforce_account_object_limits();

drop trigger if exists enforce_account_object_limits_unrevoke on public.agents;
create trigger enforce_account_object_limits_unrevoke
  before update of status on public.agents
  for each row
  when (old.status = 'revoked' and new.status <> 'revoked')
  execute function public.enforce_account_object_limits();

drop trigger if exists enforce_account_object_limits on public.agent_access_keys;
create trigger enforce_account_object_limits
  before insert on public.agent_access_keys
  for each row execute function public.enforce_account_object_limits();

drop trigger if exists enforce_account_object_limits on public.provider_credentials;
create trigger enforce_account_object_limits
  before insert on public.provider_credentials
  for each row execute function public.enforce_account_object_limits();

drop trigger if exists enforce_account_object_limits on public.api_keys;
create trigger enforce_account_object_limits
  before insert on public.api_keys
  for each row execute function public.enforce_account_object_limits();
