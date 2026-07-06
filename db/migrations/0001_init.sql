-- ============================================================================
-- PassControl — Phase 1: Schema, Vault wiring, RLS, and locked-down RPCs.
-- Target: Supabase / Postgres. Run with the project owner (postgres) role.
-- ============================================================================

-- Vault ships with Supabase; ensure it is enabled.
create extension if not exists supabase_vault cascade;
create extension if not exists pgcrypto;

-- ── Enums ────────────────────────────────────────────────────────────────────
do $$ begin
  create type public.agent_status as enum ('active', 'suspended', 'revoked');
exception when duplicate_object then null; end $$;

-- ── users: thin profile keyed to auth.users ──────────────────────────────────
create table if not exists public.users (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  plan       text not null default 'free',
  created_at timestamptz not null default now()
);

-- ── agents: the passport registry ────────────────────────────────────────────
create table if not exists public.agents (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.users(id) on delete cascade,
  name            text not null,
  -- passport_id == base64url(raw 32-byte Ed25519 public key). Unique.
  passport_pubkey text not null unique,
  status          public.agent_status not null default 'active',
  budget_tokens   bigint,                       -- null = unlimited
  budget_cents    integer,                      -- null = no cost cap
  spent_tokens    bigint not null default 0,    -- reconciled mirror (source of truth = agent_logs)
  spent_cents     integer not null default 0,
  allowed_scopes  jsonb not null default '[]',  -- [{"provider":"anthropic","models":["claude-*"]}]
  created_at      timestamptz not null default now(),
  last_seen_at    timestamptz
);
create index if not exists agents_user_status_idx on public.agents (user_id, status);

-- ── provider_credentials: reference rows only; secret lives in Vault ─────────
create table if not exists public.provider_credentials (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.users(id) on delete cascade,
  provider        text not null,                -- 'openai' | 'anthropic' | ...
  label           text,
  vault_secret_id uuid not null,                -- references vault.secrets(id)
  created_at      timestamptz not null default now(),
  unique (user_id, provider, label)
);
create index if not exists provider_credentials_user_idx on public.provider_credentials (user_id, provider);

-- ── agent_logs: append-only audit ────────────────────────────────────────────
create table if not exists public.agent_logs (
  id            uuid primary key default gen_random_uuid(),
  agent_id      uuid references public.agents(id) on delete set null,
  user_id       uuid references public.users(id) on delete cascade,
  passport_id   text not null,                  -- binds action -> signing passport
  jti           text not null,                  -- visa id (per-token tracing)
  provider      text,
  model         text,
  input_tokens  integer,
  output_tokens integer,
  cost_cents    integer,
  status        text not null,                  -- ok | blocked_budget | blocked_endpoint | blocked_suspended | blocked_scope | upstream_error
  latency_ms    integer,
  created_at    timestamptz not null default now()
);
create index if not exists agent_logs_agent_created_idx on public.agent_logs (agent_id, created_at desc);
create index if not exists agent_logs_passport_idx on public.agent_logs (passport_id);
create index if not exists agent_logs_jti_idx on public.agent_logs (jti);
create index if not exists agent_logs_user_created_idx on public.agent_logs (user_id, created_at desc);

-- ============================================================================
-- Vault helper RPCs. SECURITY DEFINER + pinned search_path + service_role-only.
-- ============================================================================

-- get_provider_key: the only path that returns decrypted secret material.
-- Re-derives ownership from the agent->user->credential join; never trusts a
-- caller-supplied user. Returns null when no active match exists.
create or replace function public.get_provider_key(p_agent_id uuid, p_provider text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text;
begin
  select ds.decrypted_secret
    into v_key
  from public.agents a
  join public.provider_credentials pc
    on pc.user_id = a.user_id and pc.provider = p_provider
  join vault.decrypted_secrets ds
    on ds.id = pc.vault_secret_id
  where a.id = p_agent_id
    and a.status = 'active'
  order by pc.created_at asc
  limit 1;

  return v_key;
end;
$$;

revoke all on function public.get_provider_key(uuid, text) from public, anon, authenticated;
grant execute on function public.get_provider_key(uuid, text) to service_role;

-- store_provider_key: create a Vault secret and its reference row atomically.
-- Owner-derived from auth.uid(); safe to expose to authenticated dashboard users.
create or replace function public.store_provider_key(
  p_provider text,
  p_label text,
  p_plaintext text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid       uuid := auth.uid();
  v_secret_id uuid;
  v_cred_id   uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  -- Ensure a profile row exists for the FK.
  insert into public.users (id, email)
  values (v_uid, (select email from auth.users where id = v_uid))
  on conflict (id) do nothing;

  v_secret_id := vault.create_secret(
    p_plaintext,
    'provider_key:' || v_uid::text || ':' || p_provider || ':' || coalesce(p_label, 'default'),
    'PassControl provider key'
  );

  insert into public.provider_credentials (user_id, provider, label, vault_secret_id)
  values (v_uid, p_provider, p_label, v_secret_id)
  returning id into v_cred_id;

  return v_cred_id;
end;
$$;

revoke all on function public.store_provider_key(text, text, text) from public, anon;
grant execute on function public.store_provider_key(text, text, text) to authenticated, service_role;

-- rotate_provider_key: update the Vault secret behind an owned credential row.
create or replace function public.rotate_provider_key(
  p_credential_id uuid,
  p_plaintext text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid       uuid := auth.uid();
  v_secret_id uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  select vault_secret_id into v_secret_id
  from public.provider_credentials
  where id = p_credential_id and user_id = v_uid;

  if v_secret_id is null then
    raise exception 'credential not found';
  end if;

  perform vault.update_secret(v_secret_id, p_plaintext);
end;
$$;

revoke all on function public.rotate_provider_key(uuid, text) from public, anon;
grant execute on function public.rotate_provider_key(uuid, text) to authenticated, service_role;

-- increment_agent_spend: atomic mirror of cumulative spend onto agents.
-- service_role only (called by the gateway post-stream and the reconcile cron).
create or replace function public.increment_agent_spend(
  p_agent_id uuid,
  p_tokens bigint,
  p_cents integer
)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.agents
     set spent_tokens = spent_tokens + coalesce(p_tokens, 0),
         spent_cents  = spent_cents  + coalesce(p_cents, 0)
   where id = p_agent_id;
$$;

revoke all on function public.increment_agent_spend(uuid, bigint, integer) from public, anon, authenticated;
grant execute on function public.increment_agent_spend(uuid, bigint, integer) to service_role;

-- ============================================================================
-- Row-Level Security
-- ============================================================================
alter table public.users enable row level security;
alter table public.agents enable row level security;
alter table public.provider_credentials enable row level security;
alter table public.agent_logs enable row level security;

-- Policies use `to authenticated` (so anon never even evaluates them) and
-- `(select auth.uid())` (evaluated once per query, not per row — Supabase's
-- recommended form for correctness + performance).

-- users: a user sees/edits only their own profile row.
drop policy if exists users_self on public.users;
create policy users_self on public.users
  for all to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- agents: owner-scoped CRUD.
drop policy if exists agents_select on public.agents;
create policy agents_select on public.agents
  for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists agents_insert on public.agents;
create policy agents_insert on public.agents
  for insert to authenticated with check (user_id = (select auth.uid()));
drop policy if exists agents_update on public.agents;
create policy agents_update on public.agents
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists agents_delete on public.agents;
create policy agents_delete on public.agents
  for delete to authenticated using (user_id = (select auth.uid()));

-- provider_credentials: owner sees ONLY metadata rows. Decrypted secret is never
-- selectable here (it lives in Vault, reachable only via get_provider_key).
drop policy if exists provider_credentials_owner on public.provider_credentials;
create policy provider_credentials_owner on public.provider_credentials
  for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- agent_logs: owner can read; NO client insert (gateway writes via service role,
-- which bypasses RLS).
drop policy if exists agent_logs_select on public.agent_logs;
create policy agent_logs_select on public.agent_logs
  for select to authenticated using (user_id = (select auth.uid()));

-- ============================================================================
-- Realtime: stream agent_logs inserts to the dashboard (RLS-filtered).
-- ============================================================================
do $$ begin
  alter publication supabase_realtime add table public.agent_logs;
exception when duplicate_object then null; end $$;
