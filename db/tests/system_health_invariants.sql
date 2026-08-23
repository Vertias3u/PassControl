begin;

do $$
declare
  snapshot jsonb;
  definition record;
begin
  select p.prosecdef, p.provolatile, p.proconfig
    into definition
    from pg_proc as p
   where p.oid = 'public.system_health_snapshot()'::regprocedure;
  if not definition.prosecdef or definition.provolatile <> 's' or coalesce(array_to_string(definition.proconfig, ','), '') not like '%search_path=%' then
    raise exception 'system_health_snapshot must be security definer, stable, and pin search_path';
  end if;
  if exists (
    select 1 from pg_proc as p,
      lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) as acl
     where p.oid = 'public.system_health_snapshot()'::regprocedure
       and acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
  ) then
    raise exception 'PUBLIC must not execute system_health_snapshot';
  end if;
  if has_function_privilege('anon', 'public.system_health_snapshot()', 'execute') then
    raise exception 'anon must not execute system_health_snapshot';
  end if;
  if has_function_privilege('authenticated', 'public.system_health_snapshot()', 'execute') then
    raise exception 'authenticated must not execute system_health_snapshot';
  end if;
  if not has_function_privilege('service_role', 'public.system_health_snapshot()', 'execute') then
    raise exception 'service_role must execute system_health_snapshot';
  end if;
  select public.system_health_snapshot() into snapshot;
  if jsonb_typeof(snapshot->'ledger') <> 'array' or jsonb_typeof(snapshot->'vault') <> 'object'
    or snapshot ? 'error' or snapshot ? 'secret' then
    raise exception 'system_health_snapshot contract is malformed';
  end if;
end;
$$;

rollback;
