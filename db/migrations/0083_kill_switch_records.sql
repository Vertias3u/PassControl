-- 0083 — The kill switches get a durable record.
--
-- A tenant's master kill, its per-service kills and its per-session stops lived in
-- Redis only. Losing Redis (a volume lost, an Upstash database lost, a self-host
-- stack that ran without persistence before bd9d62a) silently lifted every one of
-- them: proved live on 2026-10-10, an armed kill went from 403 to admitted when its
-- key disappeared, and nothing told the owner.
--
-- This table is now the record; Redis stays the copy the gateway reads per call.
-- One row per ARMED stop (disarming deletes it). When a tenant's Redis copy is
-- missing, the gateway rebuilds it from here before deciding the call
-- (lib/state/killswitch.ts). The rebuild only ever ADDS stops, so a stop armed
-- before this migration, which has no row, is never removed by it.
--
-- Not recorded, on purpose: the public demo's self-expiring kill (its TTL is the
-- point) and the arm that guards an account erasure (the account and this row go
-- together). The ops-only platform kill and denylist have no code path that sets
-- them and stay as they were.
--
-- Locked like every tenant table: RLS on, a tenant reads only its own rows, and no
-- write path but the service role. The dashboard and the control API write through
-- the service role after checking the owner in code.
--
-- APPLY BEFORE DEPLOYING the code that reads it. A deployment with
-- KILL_SWITCH_FAIL_CLOSED=true (hosted Cloud) refuses every call it cannot rebuild
-- a tenant's stops for, and a missing table is exactly that.

create table if not exists public.kill_switch_records (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users(id) on delete cascade,
  kind       text not null check (kind in ('tenant', 'service', 'session')),
  service    text,
  agent_id   uuid references public.agents(id) on delete cascade,
  session_id text,
  armed_at   timestamptz not null default now(),
  -- Each kind carries exactly its own fields. The patterns match what the code
  -- already accepts (lib/services/catalog.ts ids, lib/state/redis.ts
  -- DECLARED_SESSION), so a row can always be turned back into its Redis key.
  -- `is not null` beside each pattern: a NULL fails a regex as UNKNOWN, and a
  -- check constraint lets UNKNOWN through, so the pattern alone admits a service
  -- stop that names no service.
  constraint kill_switch_records_shape check (
    (kind = 'tenant' and service is null and agent_id is null and session_id is null)
    or (kind = 'service' and service is not null and service ~ '^[a-z][a-z0-9_-]{0,31}$' and agent_id is null and session_id is null)
    or (kind = 'session' and service is null and agent_id is not null
        and session_id is not null and session_id ~ '^[A-Za-z0-9._:-]{1,128}$')
  )
);

comment on table public.kill_switch_records is
  'Armed kill switches and session stops, one row each; the durable record behind the Redis copy the gateway reads.';

-- One row per stop. Arming twice is a unique violation, which the code reads as
-- "already armed". Expressions rather than NULLS NOT DISTINCT, for older Postgres.
create unique index if not exists kill_switch_records_one_per_stop
  on public.kill_switch_records (
    user_id,
    kind,
    coalesce(service, ''),
    coalesce(agent_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(session_id, '')
  );

-- The agent foreign key's own index: the unique index above leads with user_id, so
-- without this, deleting an agent scans the table for session stops to cascade
-- (Supabase's unindexed_foreign_keys advisor).
create index if not exists kill_switch_records_agent_id on public.kill_switch_records (agent_id);

alter table public.kill_switch_records enable row level security;

-- service_role too: Supabase's defaults grant it everything, and nothing here
-- ever updates a row (a stop is armed by inserting and disarmed by deleting).
revoke all on table public.kill_switch_records from public, anon, authenticated, service_role;
grant select on table public.kill_switch_records to authenticated;
grant select, insert, delete on table public.kill_switch_records to service_role;

drop policy if exists kill_switch_records_select_own on public.kill_switch_records;
create policy kill_switch_records_select_own on public.kill_switch_records
  for select to authenticated
  using (user_id = (select auth.uid()));
