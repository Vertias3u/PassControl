-- 0081: signed delegation (Bet D; plans/delegation-design.md §9 and §13).
--
-- An agent signs a narrower slice of its own authority over to a worker's key, offline.
-- The gateway first learns of a delegation when a worker exchanges it for a visa. This
-- migration holds the three durable facts that needs:
--
--   1. delegation_exchanges: one row per link jti the gateway has accepted, written by
--      the FIRST exchange. Only an insert that created the row may create that link's
--      spend ledger in Redis; after that a missing ledger refuses (it was lost, and
--      recreating it at zero would hand the worker its whole cap again). It is also the
--      list an owner revokes from.
--   2. delegation_revocations: a seen jti the owner killed. Append-only: a revocation is
--      never withdrawn, as on the public revocation list.
--   3. agents.delegations_valid_after: the watermark. Every delegation issued before it
--      is dead, including ones never seen. It only moves forward.
--
-- And it lets agent_logs say a call was made BY a worker: two auth_method values (the
-- column records what was enforced, and a worker can be on a bearer visa or a per-request
-- proof like any passport agent) and four columns naming the delegation.
--
-- ASSUMES 0080. Must be applied on a database BEFORE any deploy whose gateway writes the
-- delegation columns.

-- ── 3. The watermark ─────────────────────────────────────────────────────────
alter table public.agents
  add column if not exists delegations_valid_after timestamptz;

comment on column public.agents.delegations_valid_after is
  'Every delegation this agent signed with iat before this instant is refused. NULL = none. Only moves forward (agents_delegation_watermark_forward).';

create or replace function public.agents_delegation_watermark_forward()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.delegations_valid_after is not null
     and (new.delegations_valid_after is null
          or new.delegations_valid_after < old.delegations_valid_after) then
    raise exception 'delegations_valid_after only moves forward'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists agents_delegation_watermark_forward on public.agents;
create trigger agents_delegation_watermark_forward
  before update of delegations_valid_after on public.agents
  for each row execute function public.agents_delegation_watermark_forward();

-- ── 1. First exchange of each link ─────────────────────────────────────────
create table if not exists public.delegation_exchanges (
  user_id            uuid not null references public.users(id) on delete cascade,
  agent_id           uuid not null references public.agents(id) on delete cascade,
  jti                text not null check (jti ~ '^[A-Za-z0-9_-]{16,64}$'),
  depth              smallint not null check (depth between 1 and 2),
  -- The link above this one; NULL at depth 1, whose parent is the passport itself.
  parent_jti         text check (parent_jti is null or parent_jti ~ '^[A-Za-z0-9_-]{16,64}$'),
  worker_key         text not null check (worker_key ~ '^[A-Za-z0-9_-]{43}$'),
  cap_microcents     bigint not null check (cap_microcents >= 0),
  scope              jsonb not null,
  issued_at          timestamptz not null,
  expires_at         timestamptz not null check (expires_at > issued_at),
  first_exchanged_at timestamptz not null default now(),
  primary key (agent_id, jti),
  check ((depth = 1) = (parent_jti is null))
);

comment on table public.delegation_exchanges is
  'One row per delegation link the gateway has accepted, written by its first exchange. Creating the row is what licenses creating the link''s spend ledger.';

create index if not exists delegation_exchanges_owner_idx
  on public.delegation_exchanges (user_id, agent_id, first_exchanged_at desc);

alter table public.delegation_exchanges enable row level security;
drop policy if exists delegation_exchanges_select on public.delegation_exchanges;
create policy delegation_exchanges_select on public.delegation_exchanges
  for select to authenticated
  using (user_id = (select auth.uid()));
grant select on public.delegation_exchanges to authenticated;
revoke insert, update, delete, truncate on public.delegation_exchanges from authenticated, anon;

-- ── 2. Revoked delegations, append-only ───────────────────────────────────
create table if not exists public.delegation_revocations (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users(id) on delete cascade,
  -- SET NULL, as on agent_logs: deleting an agent must not erase that a credential
  -- derived from it was killed.
  agent_id   uuid references public.agents(id) on delete set null,
  jti        text not null check (jti ~ '^[A-Za-z0-9_-]{16,64}$'),
  revoked_at timestamptz not null default now(),
  unique (agent_id, jti)
);

comment on table public.delegation_revocations is
  'Delegations the owner revoked, by link jti. Append-only: a revocation is never withdrawn.';

create or replace function public.delegation_revocations_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if pg_trigger_depth() > 1 then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;
  raise exception 'delegation_revocations is append-only: % is not permitted', tg_op
    using errcode = 'check_violation';
end;
$$;

create or replace function public.delegation_revocations_block_truncate()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'delegation_revocations is append-only: TRUNCATE is not permitted'
    using errcode = 'check_violation';
end;
$$;

drop trigger if exists delegation_revocations_no_mutate on public.delegation_revocations;
create trigger delegation_revocations_no_mutate
  before update or delete on public.delegation_revocations
  for each row execute function public.delegation_revocations_immutable();

drop trigger if exists delegation_revocations_no_truncate on public.delegation_revocations;
create trigger delegation_revocations_no_truncate
  before truncate on public.delegation_revocations
  for each statement execute function public.delegation_revocations_block_truncate();

alter table public.delegation_revocations enable row level security;
drop policy if exists delegation_revocations_select on public.delegation_revocations;
create policy delegation_revocations_select on public.delegation_revocations
  for select to authenticated
  using (user_id = (select auth.uid()));
grant select on public.delegation_revocations to authenticated;
revoke insert, update, delete, truncate on public.delegation_revocations from authenticated, anon;

-- ── 4. agent_logs: a call made by a worker ─────────────────────────────────
alter table public.agent_logs
  add column if not exists delegation_jti text,
  add column if not exists delegation_actor text,
  add column if not exists delegation_chain_hash text,
  add column if not exists delegation_links text[];

comment on column public.agent_logs.delegation_jti is
  'The leaf delegation the call was made under. NULL = not a delegated call.';
comment on column public.agent_logs.delegation_actor is
  'The worker key that made the call (the visa''s act.sub). passport_id stays the ROOT passport.';
comment on column public.agent_logs.delegation_chain_hash is
  'SHA-256 of the chain (links joined by commas), base64url: what a receipt''s auth.ch commits to.';
comment on column public.agent_logs.delegation_links is
  'Every link''s jti, root first.';

alter table public.agent_logs
  drop constraint if exists agent_logs_auth_method_known;
alter table public.agent_logs
  add constraint agent_logs_auth_method_known
  check (auth_method in (
    'passport', 'passport_proof_per_request', 'direct_key',
    'delegated', 'delegated_proof_per_request'
  ))
  not valid;
alter table public.agent_logs
  validate constraint agent_logs_auth_method_known;

alter table public.agent_logs
  drop constraint if exists agent_logs_identity_discriminated;
alter table public.agent_logs
  add constraint agent_logs_identity_discriminated
  check (
    (
      auth_method in ('passport', 'passport_proof_per_request', 'delegated', 'delegated_proof_per_request')
      and passport_id is not null
      and jti is not null
      and agent_access_key_id is null
      and credential_use_id is null
    )
    or (
      auth_method = 'direct_key'
      and agent_access_key_id is not null
      and credential_use_id is not null
      and passport_id is null
      and jti is null
    )
  )
  not valid;
alter table public.agent_logs
  validate constraint agent_logs_identity_discriminated;

-- A delegated method and the four delegation columns come together or not at all, so
-- no row can name a worker without saying the call was delegated, or the reverse.
alter table public.agent_logs
  drop constraint if exists agent_logs_delegation_shape;
alter table public.agent_logs
  add constraint agent_logs_delegation_shape
  check (
    (auth_method in ('delegated', 'delegated_proof_per_request')) = (delegation_jti is not null)
    and (delegation_jti is null) = (delegation_actor is null)
    and (delegation_jti is null) = (delegation_chain_hash is null)
    and (delegation_jti is null) = (delegation_links is null)
  )
  not valid;
alter table public.agent_logs
  validate constraint agent_logs_delegation_shape;

comment on column public.agent_logs.auth_method is
  'What the gateway actually enforced for this call: passport is a bearer '
  'work-visa; passport_proof_per_request additionally means a fresh Ed25519 '
  'proof bound to the exact visa, method and path was verified and its proof '
  'jti was claimed; direct_key is bearer possession of a Direct Agent Key; '
  'delegated / delegated_proof_per_request are the same two for a WORKER '
  'holding a delegation from the agent (0081), the proof made by the worker''s key. '
  'This records enforcement, never the agent configuration flag.';
