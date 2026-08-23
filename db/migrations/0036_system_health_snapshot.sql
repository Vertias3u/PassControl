-- Internal-only evidence for the authenticated system-health surface. This is
-- intentionally a single read-only snapshot: no Vault decrypt, provider call,
-- JWKS fetch, dynamic SQL, or state write is permitted on this path.
create function public.system_health_snapshot()
returns jsonb
language sql
security definer
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'ledger', coalesce((
      select jsonb_agg(jsonb_build_object('version', m.version, 'checksum', m.checksum) order by m.version)
      from public.schema_migrations as m
    ), '[]'::jsonb),
    'vault', jsonb_build_object(
      'extension', exists (select 1 from pg_extension where extname = 'supabase_vault'),
      'secrets_relation', to_regclass('vault.secrets') is not null,
      'decrypt_rpc', to_regprocedure('public.get_provider_key(uuid,text)') is not null,
      'service_role_execute', coalesce((select has_function_privilege('service_role', p.oid, 'execute') from pg_proc as p where p.oid = to_regprocedure('public.get_provider_key(uuid,text)')), false),
      'public_execute', coalesce((select exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) as acl where acl.grantee = 0 and acl.privilege_type = 'EXECUTE') from pg_proc as p where p.oid = to_regprocedure('public.get_provider_key(uuid,text)')), false),
      'anon_execute', coalesce((select has_function_privilege('anon', p.oid, 'execute') from pg_proc as p where p.oid = to_regprocedure('public.get_provider_key(uuid,text)')), false),
      'authenticated_execute', coalesce((select has_function_privilege('authenticated', p.oid, 'execute') from pg_proc as p where p.oid = to_regprocedure('public.get_provider_key(uuid,text)')), false),
      'no_dangling_references', not exists (
        select 1 from public.provider_credentials as pc
        left join vault.secrets as s on s.id = pc.vault_secret_id
        where s.id is null
      )
    )
  );
$$;

revoke all on function public.system_health_snapshot() from public, anon, authenticated;
grant execute on function public.system_health_snapshot() to service_role;
