-- ============================================================================
-- PassControl — make agent_logs tamper-evident (append-only at the DB level).
--
-- agent_logs is the audit trail. Clients already have no write path (RLS: select
-- only, inserts are service-role). But the service-role client *could* UPDATE or
-- DELETE rows — so history wasn't enforced as immutable against a compromised
-- gateway or a buggy/ malicious server path. These triggers reject any DIRECT
-- mutation, while still permitting the database's own referential-action cascades:
--   * deleting an agent nulls agent_id (FK on delete set null) — the log survives;
--   * deleting a user removes its rows (FK on delete cascade) — data lifecycle.
-- Those run nested inside the system RI trigger (pg_trigger_depth() > 1); a direct
-- UPDATE/DELETE runs at depth 1 and is rejected. INSERT is unaffected. TRUNCATE
-- (which bypasses row triggers) is blocked by a separate statement trigger.
-- ============================================================================

create or replace function public.agent_logs_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Permit only changes driven by a referential cascade (nested trigger depth).
  if pg_trigger_depth() > 1 then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;
  raise exception 'agent_logs is append-only: % is not permitted', tg_op
    using errcode = 'check_violation';
end;
$$;

create or replace function public.agent_logs_block_truncate()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'agent_logs is append-only: TRUNCATE is not permitted'
    using errcode = 'check_violation';
end;
$$;

drop trigger if exists agent_logs_no_mutate on public.agent_logs;
create trigger agent_logs_no_mutate
  before update or delete on public.agent_logs
  for each row execute function public.agent_logs_immutable();

drop trigger if exists agent_logs_no_truncate on public.agent_logs;
create trigger agent_logs_no_truncate
  before truncate on public.agent_logs
  for each statement execute function public.agent_logs_block_truncate();
