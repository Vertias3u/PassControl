-- ============================================================================
-- PassControl — Direct Agent Keys, expansion phase only.
--
-- This migration MUST land before the dual-mode gateway. It deliberately does
-- not add the final discriminated identity CHECK or set auth_method NOT NULL:
-- those constraints belong in a later migration after the new writer has run
-- in production. The old writer remains valid throughout this migration.
-- ============================================================================

-- A direct-key call has no passport id and no visa jti. Relax these two columns
-- before any code can attempt to write such a row.
alter table public.agent_logs
  alter column passport_id drop not null,
  alter column jti drop not null;

-- Nullable during expansion. The default makes every row written by the old
-- passport-only application self-identify without requiring that application
-- to know the new column exists.
alter table public.agent_logs
  add column if not exists auth_method text default 'passport',
  add column if not exists agent_access_key_id uuid,
  add column if not exists credential_use_id uuid;

update public.agent_logs
   set auth_method = 'passport'
 where auth_method is null;

-- A direct-first agent has no passport yet. The existing UNIQUE constraint is
-- retained; PostgreSQL permits multiple NULLs, while every actual passport id
-- stays globally unique within the column.
alter table public.agents
  alter column passport_pubkey drop not null;

create table if not exists public.agent_access_keys (
  id          uuid primary key default gen_random_uuid(),
  -- SET NULL is intentional. Deleting an agent invalidates every key because
  -- authentication inner-joins the agent, while preserving the key identity
  -- referenced by immutable historical logs.
  user_id     uuid references public.users(id) on delete set null,
  agent_id    uuid references public.agents(id) on delete set null,
  name        text not null check (length(btrim(name)) between 1 and 80),
  key_hash    text not null unique check (key_hash ~ '^[A-Za-z0-9_-]{43}$'),
  key_suffix  text not null check (key_suffix ~ '^[A-Za-z0-9_-]{8}$'),
  expires_at  timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now()
);

alter table public.agent_logs
  add constraint agent_logs_access_key_fk
  foreign key (agent_access_key_id)
  references public.agent_access_keys(id)
  on delete restrict
  not valid;

create index if not exists agent_access_keys_agent_created_idx
  on public.agent_access_keys (user_id, agent_id, created_at desc);
create index if not exists agent_access_keys_active_idx
  on public.agent_access_keys (user_id, agent_id)
  where revoked_at is null;
create index if not exists agent_logs_access_key_created_idx
  on public.agent_logs (agent_access_key_id, created_at desc)
  where agent_access_key_id is not null;

alter table public.agent_access_keys enable row level security;

create policy agent_access_keys_select_own on public.agent_access_keys
  for select to authenticated
  using (user_id = (select auth.uid()));

-- No browser write path. The raw key is created and returned once by a guarded
-- server action; only its hash reaches this table.
revoke all on public.agent_access_keys from anon, authenticated;
grant all on public.agent_access_keys to service_role;
grant select (id, user_id, agent_id, name, key_suffix, expires_at, revoked_at, created_at)
  on public.agent_access_keys to authenticated;

comment on table public.agent_access_keys is
  'Lower-assurance bearer credentials for one agent. Raw keys are reveal-once; '
  'only SHA-256 hashes are stored. Not passports and never accepted by the '
  'control plane.';

comment on column public.agent_access_keys.expires_at is
  'Optional. NULL means no scheduled expiry; revocation remains explicit.';

-- One workspace may have many installations, including more than two keys for
-- one agent. The ceiling protects a zero-funding beta from unlimited credential
-- rows; it is intentionally workspace-wide, never a per-agent product rule.
create or replace function public.create_agent_access_key(
  p_user_id uuid,
  p_agent_id uuid,
  p_name text,
  p_key_hash text,
  p_key_suffix text,
  p_expires_at timestamptz default null
)
returns table (key_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key_id uuid;
  v_active_keys integer;
begin
  -- Serialize the ceiling check per workspace without taking a table lock.
  perform pg_advisory_xact_lock(hashtext(p_user_id::text)::bigint);

  if not exists (
    select 1
      from public.agents as a
     where a.id = p_agent_id
       and a.user_id = p_user_id
       and a.status <> 'revoked'
  ) then
    return;
  end if;

  select count(*)
    into v_active_keys
    from public.agent_access_keys as k
   where k.user_id = p_user_id
     and k.revoked_at is null
     and (k.expires_at is null or k.expires_at > now());
  if v_active_keys >= 50 then
    raise exception 'active_key_limit' using errcode = 'P0001';
  end if;

  insert into public.agent_access_keys (
    user_id, agent_id, name, key_hash, key_suffix, expires_at
  ) values (
    p_user_id, p_agent_id, btrim(p_name), p_key_hash, p_key_suffix, p_expires_at
  )
  returning id into v_key_id;

  return query select v_key_id;
end;
$$;

revoke all on function public.create_agent_access_key(uuid, uuid, text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.create_agent_access_key(uuid, uuid, text, text, text, timestamptz)
  to service_role;

-- Direct-first creation is atomic: a UI can never create a usable-looking agent
-- row and then fail before attaching its only authenticator.
create or replace function public.create_direct_agent(
  p_user_id uuid,
  p_name text,
  p_scopes jsonb,
  p_budget_tokens bigint,
  p_budget_cents integer,
  p_key_name text,
  p_key_hash text,
  p_key_suffix text,
  p_expires_at timestamptz default null
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
    user_id, name, passport_pubkey, allowed_scopes, budget_tokens, budget_cents
  ) values (
    p_user_id, btrim(p_name), null, p_scopes, p_budget_tokens, p_budget_cents
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

revoke all on function public.create_direct_agent(uuid, text, jsonb, bigint, integer, text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.create_direct_agent(uuid, text, jsonb, bigint, integer, text, text, text, timestamptz)
  to service_role;

create or replace function public.revoke_agent_access_key(
  p_user_id uuid,
  p_agent_id uuid,
  p_key_id uuid
)
returns table (key_id uuid, key_suffix text, key_name text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key_id uuid;
  v_key_suffix text;
  v_key_name text;
begin
  update public.agent_access_keys as k
     set revoked_at = now()
   where k.id = p_key_id
     and k.user_id = p_user_id
     and k.agent_id = p_agent_id
     and k.revoked_at is null
  returning k.id, k.key_suffix, k.name
       into v_key_id, v_key_suffix, v_key_name;

  if v_key_id is null then
    return;
  end if;
  return query select v_key_id, v_key_suffix, v_key_name;
end;
$$;

revoke all on function public.revoke_agent_access_key(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.revoke_agent_access_key(uuid, uuid, uuid)
  to service_role;

-- Upgrade a direct-first identity in place. The public key is checked across
-- current keys and still-live rotation keys while holding a key-specific lock;
-- attaching it never replaces the agent row or revokes its direct credentials.
create or replace function public.attach_agent_passport(
  p_user_id uuid,
  p_agent_id uuid,
  p_passport_pubkey text
)
returns table (agent_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_agent_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext(p_passport_pubkey)::bigint);

  if exists (
    select 1
      from public.agents as existing
     where existing.passport_pubkey = p_passport_pubkey
        or (
          existing.previous_passport_pubkey = p_passport_pubkey
          and existing.previous_valid_until > now()
        )
  ) then
    raise exception 'passport_key_in_use' using errcode = 'P0001';
  end if;

  update public.agents as a
     set passport_pubkey = p_passport_pubkey
   where a.id = p_agent_id
     and a.user_id = p_user_id
     and a.passport_pubkey is null
     and a.status <> 'revoked'
  returning a.id into v_agent_id;

  if v_agent_id is null then
    return;
  end if;
  return query select v_agent_id;
end;
$$;

revoke all on function public.attach_agent_passport(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.attach_agent_passport(uuid, uuid, text)
  to service_role;

-- Last use is a fact derived from immutable call records. There is no mutable
-- last_used_at shadow column that can drift when best-effort logging fails.
create or replace function public.agent_access_key_activity(
  p_user_id uuid,
  p_agent_id uuid
)
returns table (key_id uuid, last_used_at timestamptz, recorded_calls bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    k.id,
    max(l.created_at),
    count(l.id)
  from public.agent_access_keys as k
  left join public.agent_logs as l
    on l.agent_access_key_id = k.id
   and l.user_id = p_user_id
   and l.agent_id = p_agent_id
  where k.user_id = p_user_id
    and k.agent_id = p_agent_id
  group by k.id;
$$;

revoke all on function public.agent_access_key_activity(uuid, uuid) from public, anon;
grant execute on function public.agent_access_key_activity(uuid, uuid) to authenticated;

-- One indexed lookup derives the complete principal. It is service-role-only:
-- a caller holding the anon key must not turn this into a key-existence oracle.
create or replace function public.authenticate_direct_agent_key(p_key_hash text)
returns table (
  key_id uuid,
  agent_id uuid,
  user_id uuid,
  allowed_scopes jsonb,
  break_glass_scopes jsonb,
  budget_tokens bigint,
  budget_cents integer,
  spent_tokens bigint,
  spent_microcents bigint
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
    a.spent_microcents
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
    and a.status = 'active'
  limit 1;
$$;

revoke all on function public.authenticate_direct_agent_key(text) from public, anon, authenticated;
grant execute on function public.authenticate_direct_agent_key(text) to service_role;
