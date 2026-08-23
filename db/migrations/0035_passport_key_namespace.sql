-- ============================================================================
-- PassControl — one transactional namespace for every passport key state.
--
-- `agents.passport_pubkey` and `agents.previous_passport_pubkey` each had a
-- unique constraint, but PostgreSQL did not make those constraints talk to one
-- another. A tenant could therefore register a public key as its current
-- passport while another tenant still held it as a retired passport. The auth
-- lookup correctly failed that ambiguity closed, but a copied public key could
-- still deny its owner during the grace window.
--
-- The namespace below is the write-side counterpart: a key has one reservation
-- for as long as it appears in EITHER agents column. An AFTER trigger owns the
-- reservation inside the agent row's transaction, so it covers direct service
-- inserts (normal creation and workspace restore), the attach RPC, rotation,
-- reconcile cleanup, seeds, and any future writer without trusting each caller
-- to remember a preflight query.
--
-- Rollout safety: this migration MUST NOT collapse an old cross-column
-- collision. It stops with an actionable error before creating the namespace;
-- the existing read-side ambiguity refusal remains in place until an operator
-- resolves that legacy data and reapplies the migration.
--
-- This file must run inside one transaction. Both repository migrators use
-- `psql -1` for every migration and its ledger row. SHARE ROW EXCLUSIVE is the
-- narrow table lock that conflicts with every INSERT/UPDATE/DELETE's ROW
-- EXCLUSIVE lock while allowing ordinary reads. Held through backfill and
-- CREATE TRIGGER, it prevents a writer from committing a passport state in the
-- otherwise-open interval after the namespace snapshot but before the trigger
-- is installed.
-- ============================================================================

lock table public.agents in share row exclusive mode;

do $$
declare
  v_conflicting_key text;
begin
  select claim.passport_pubkey
    into v_conflicting_key
    from (
      select a.id as agent_id, a.passport_pubkey
        from public.agents as a
       where a.passport_pubkey is not null
      union all
      select a.id as agent_id, a.previous_passport_pubkey
        from public.agents as a
       where a.previous_passport_pubkey is not null
    ) as claim
   group by claim.passport_pubkey
  having count(distinct claim.agent_id) > 1
   order by claim.passport_pubkey
   limit 1;

  if v_conflicting_key is not null then
    raise exception 'passport_key_namespace_backfill_conflict: key % is claimed by multiple agents', v_conflicting_key
      using errcode = 'P0001',
            hint = 'Resolve the current-versus-retired key collision while the existing auth lookup remains fail-closed, then reapply migration 0035.';
  end if;
end;
$$;

create table public.passport_key_namespace (
  passport_pubkey text primary key,
  created_at      timestamptz not null default now()
);

alter table public.passport_key_namespace enable row level security;
revoke all on table public.passport_key_namespace from public, anon, authenticated, service_role;

-- Keep the two statements separate. The preflight above rejects a key claimed
-- by different agents; the second predicate only avoids inserting the SAME
-- agent's current key twice if legacy data already repeats it in the retired
-- column. There is deliberately no UNION/ON CONFLICT that could hide a
-- cross-agent collision during rollout.
insert into public.passport_key_namespace (passport_pubkey)
select a.passport_pubkey
  from public.agents as a
 where a.passport_pubkey is not null;

insert into public.passport_key_namespace (passport_pubkey)
select a.previous_passport_pubkey
  from public.agents as a
 where a.previous_passport_pubkey is not null
   and a.previous_passport_pubkey is distinct from a.passport_pubkey;

create or replace function public.sync_passport_key_namespace()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_expected integer;
  v_inserted integer;
begin
  if tg_op = 'DELETE' then
    -- A reservation is released only once NO agents row claims it. That last
    -- predicate makes cleanup safe even for a historical cross-row collision
    -- that was repaired after a failed 0035 rollout; deleting one owner never
    -- frees the other owner's key.
    delete from public.passport_key_namespace as n
     where (n.passport_pubkey = old.passport_pubkey
         or n.passport_pubkey = old.previous_passport_pubkey)
       and not exists (
         select 1
           from public.agents as a
          where a.passport_pubkey = n.passport_pubkey
             or a.previous_passport_pubkey = n.passport_pubkey
       );
    return old;
  end if;

  -- An agent can never use the exact same key as both current and retired.
  -- Product writers already avoid this; enforcing it at the shared boundary
  -- prevents a future direct service write from creating a nonsensical grace
  -- state that a one-key namespace would otherwise mask.
  if new.passport_pubkey is not null
     and new.passport_pubkey = new.previous_passport_pubkey then
    raise exception 'passport_key_in_use'
      using errcode = 'P0001';
  end if;

  if tg_op = 'INSERT' then
    select count(*) into v_expected
      from (
        select distinct candidate.passport_pubkey
          from (values (new.passport_pubkey), (new.previous_passport_pubkey))
            as candidate(passport_pubkey)
         where candidate.passport_pubkey is not null
      ) as requested;

    insert into public.passport_key_namespace (passport_pubkey)
    select candidate.passport_pubkey
      from (
        select distinct candidate.passport_pubkey
          from (values (new.passport_pubkey), (new.previous_passport_pubkey))
            as candidate(passport_pubkey)
         where candidate.passport_pubkey is not null
      ) as candidate
    on conflict do nothing;
    get diagnostics v_inserted = row_count;

    if v_inserted <> v_expected then
      raise exception 'passport_key_in_use'
        using errcode = 'P0001';
    end if;
    return new;
  end if;

  -- Only a key absent from this row's OLD state is a new claim. Existing keys
  -- are the agent's own current key becoming retired during rotation, or a
  -- current key left unchanged while reconcile clears its retired neighbour.
  -- INSERT is the arbitration point: ON CONFLICT waits for a competing
  -- transaction, and a row count short of the exact requested set fails this
  -- entire agents mutation rather than granting two identities the same key.
  select count(*) into v_expected
    from (
      select distinct candidate.passport_pubkey
        from (values (new.passport_pubkey), (new.previous_passport_pubkey))
          as candidate(passport_pubkey)
       where candidate.passport_pubkey is not null
         and candidate.passport_pubkey is distinct from old.passport_pubkey
         and candidate.passport_pubkey is distinct from old.previous_passport_pubkey
    ) as requested;

  insert into public.passport_key_namespace (passport_pubkey)
  select candidate.passport_pubkey
    from (
      select distinct candidate.passport_pubkey
        from (values (new.passport_pubkey), (new.previous_passport_pubkey))
          as candidate(passport_pubkey)
       where candidate.passport_pubkey is not null
         and candidate.passport_pubkey is distinct from old.passport_pubkey
         and candidate.passport_pubkey is distinct from old.previous_passport_pubkey
    ) as candidate
  on conflict do nothing;
  get diagnostics v_inserted = row_count;

  if v_inserted <> v_expected then
    raise exception 'passport_key_in_use'
      using errcode = 'P0001';
  end if;

  -- A retired-key cleanup removes only the old key(s) no remaining row claims.
  -- The namespace primary key supplies the row lock that serializes this delete
  -- with a concurrent attempt to reserve the same key.
  delete from public.passport_key_namespace as n
   where (n.passport_pubkey = old.passport_pubkey
       or n.passport_pubkey = old.previous_passport_pubkey)
     and n.passport_pubkey is distinct from new.passport_pubkey
     and n.passport_pubkey is distinct from new.previous_passport_pubkey
     and not exists (
       select 1
         from public.agents as a
        where a.passport_pubkey = n.passport_pubkey
           or a.previous_passport_pubkey = n.passport_pubkey
     );
  return new;
end;
$$;

revoke all on function public.sync_passport_key_namespace() from public, anon, authenticated, service_role;

create trigger agents_passport_key_namespace_sync
after insert or update of passport_pubkey, previous_passport_pubkey or delete
on public.agents
for each row execute function public.sync_passport_key_namespace();

-- The import route needs to make a truthful dry-run without doing an unscoped
-- service-role read of agents. This is intentionally a tiny existence oracle:
-- it returns only each submitted public key and whether the global namespace is
-- free; it never reveals an agent id, tenant, current/retired state, or row.
create function public.passport_key_availability(p_passport_pubkeys text[])
returns table (passport_pubkey text, available boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select
    requested.passport_pubkey,
    requested.passport_pubkey is not null
      and not exists (
        select 1
          from public.passport_key_namespace as n
         where n.passport_pubkey = requested.passport_pubkey
      ) as available
    from unnest(p_passport_pubkeys) as requested(passport_pubkey);
$$;

revoke all on function public.passport_key_availability(text[]) from public, anon, authenticated;
grant execute on function public.passport_key_availability(text[]) to service_role;

comment on table public.passport_key_namespace is
  'Private global reservation for every current and retired passport public key. Maintained only by the agents trigger.';

comment on function public.passport_key_availability(text[]) is
  'Service-role-only boolean availability for workspace-import previews; does not disclose key ownership or state.';
