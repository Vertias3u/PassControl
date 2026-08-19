-- ============================================================================
-- PassControl — RLS invariant test (trust boundary #5: tenant isolation).
--
-- Verifies, against a database with the migrations applied, that:
--   0. RLS is ENABLED on every sensitive table (catches a migration that forgets
--      it — the failure mode that silently exposes all tenants);
--   1. an authenticated tenant sees ONLY its own rows, never another tenant's
--      (agents / agent_logs / admin_audit);
--   2. the same holds with identities swapped;
--   3. the service_role (the gateway) bypasses RLS by design.
--
-- Identities are simulated the way the gateway's PostgREST requests are: by
-- SET ROLE + the `request.jwt.claim.sub` GUC that auth.uid() reads. No real auth
-- users/login required. Everything runs inside a transaction and is ROLLED BACK,
-- so the test is read-only in effect and leaves no data.
--
-- Run (exit 0 = pass, non-zero = a violated invariant):
--   psql -v ON_ERROR_STOP=1 -f db/tests/rls_invariants.sql "$DATABASE_URL"
-- ============================================================================

begin;

do $$
declare
  v_a uuid := gen_random_uuid();
  v_b uuid := gen_random_uuid();
  v_agent_a uuid;
  v_key_a uuid;
  n int;
  bad text;
begin
  -- (0) RLS enabled on every sensitive table.
  select string_agg(relname, ', ') into bad from pg_class
   where relnamespace = 'public'::regnamespace and relkind = 'r'
     and relname in ('users','agents','agent_logs','provider_credentials','admin_audit','agent_spend_checkpoint','api_keys','mfa_recovery_codes','agent_access_keys')
     and relrowsecurity = false;
  if bad is not null then raise exception 'RLS disabled on: %', bad; end if;

  -- A dashboard session may edit its own agent's metadata, but it must not be
  -- able to reactivate a terminally revoked passport by PATCHing `status`
  -- directly through PostgREST. Status transitions run only server-side with
  -- an explicit tenant filter.
  if has_column_privilege('authenticated', 'public.agents', 'status', 'UPDATE') then
    raise exception 'authenticated must not have UPDATE on agents.status';
  end if;
  if not has_column_privilege('authenticated', 'public.agents', 'name', 'UPDATE') then
    raise exception 'authenticated must retain UPDATE on editable agent metadata';
  end if;

  -- api_keys: an owner may revoke their own key (UPDATE revoked_at), but must not
  -- be able to escalate an existing key's `scope` (read->write) or tamper
  -- `key_hash` via a direct PostgREST PATCH. Privileged columns are server-only.
  if has_column_privilege('authenticated', 'public.api_keys', 'scope', 'UPDATE') then
    raise exception 'authenticated must not have UPDATE on api_keys.scope';
  end if;
  if has_column_privilege('authenticated', 'public.api_keys', 'key_hash', 'UPDATE') then
    raise exception 'authenticated must not have UPDATE on api_keys.key_hash';
  end if;
  if not has_column_privilege('authenticated', 'public.api_keys', 'revoked_at', 'UPDATE') then
    raise exception 'authenticated must retain UPDATE on api_keys.revoked_at (revoke path)';
  end if;

  -- Direct Agent Keys: the dashboard may read display metadata, never hashes,
  -- and has no direct table write path. Guarded server actions call service-only
  -- lifecycle RPCs instead.
  if has_column_privilege('authenticated', 'public.agent_access_keys', 'key_hash', 'SELECT') then
    raise exception 'authenticated must not read agent_access_keys.key_hash';
  end if;
  if not has_column_privilege('authenticated', 'public.agent_access_keys', 'key_suffix', 'SELECT') then
    raise exception 'authenticated must read agent_access_keys display metadata';
  end if;
  if has_table_privilege('authenticated', 'public.agent_access_keys', 'INSERT')
     or has_table_privilege('authenticated', 'public.agent_access_keys', 'UPDATE')
     or has_table_privilege('authenticated', 'public.agent_access_keys', 'DELETE') then
    raise exception 'authenticated must have no direct agent_access_keys write path';
  end if;

  -- Credential CREATION is server-only, and this is the invariant 0011/0012 did
  -- NOT establish. Those migrations locked privileged COLUMNS against a PATCH,
  -- reasoning that "an owner can already mint a write-scoped key at will" — true
  -- while owner authority was the whole gate. Once `requireCredentialMfa` made
  -- minting conditional on AAL2, an INSERT that PostgREST accepts from any aal1
  -- session became a way around it: a self-chosen `key_hash` is a working `pc_`
  -- control-plane key, and a self-chosen `passport_pubkey` on an `active` agent
  -- mints visas against the tenant's provider key. Both are authority CREATION,
  -- which no emergency-stop argument covers, so both move server-side.
  if has_table_privilege('authenticated', 'public.api_keys', 'INSERT') then
    raise exception 'authenticated must not INSERT api_keys; credential minting is MFA/server-only';
  end if;
  if has_table_privilege('authenticated', 'public.agents', 'INSERT') then
    raise exception 'authenticated must not INSERT agents; passport registration is MFA/server-only';
  end if;

  -- Deletion of either row destroys the record a revocation is supposed to leave
  -- behind (api_keys.revoked_at, and the agent an immutable log row points at).
  -- Neither has a dashboard path; account erasure runs through the service-only
  -- delete_account_data (0024), whose FK cascade is unaffected by these grants.
  if has_table_privilege('authenticated', 'public.api_keys', 'DELETE') then
    raise exception 'authenticated must not DELETE api_keys; revocation is a soft delete';
  end if;
  if has_table_privilege('authenticated', 'public.agents', 'DELETE') then
    raise exception 'authenticated must not DELETE agents; erasure is service-only (0024)';
  end if;

  -- provider_credentials is the sharpest of the three and is NOT MFA-specific.
  -- The row holds `vault_secret_id`, and get_provider_key (0027) joins
  -- `vault.decrypted_secrets` on it while deriving ownership only from
  -- agent->user->credential. It never checks that the SECRET belongs to the
  -- tenant. So a writable vault_secret_id lets any authenticated user — at aal2
  -- as much as aal1 — point their own credential row at another tenant's secret
  -- and have the gateway decrypt and inject it. Unguessable UUIDs were the only
  -- thing standing in the way, which is obscurity, not authorization. Every
  -- legitimate write already runs through a SECURITY DEFINER RPC.
  if has_table_privilege('authenticated', 'public.provider_credentials', 'INSERT')
     or has_table_privilege('authenticated', 'public.provider_credentials', 'UPDATE')
     or has_table_privilege('authenticated', 'public.provider_credentials', 'DELETE') then
    raise exception 'authenticated must have no direct provider_credentials write path (vault_secret_id is forgeable)';
  end if;

  -- mfa_recovery_codes is credential material, and it defeats everything above if
  -- it is writable. A recovery code is redeemed at /login/verify as an EMERGENCY
  -- RESET: consume one, unenroll the TOTP factor, land in at aal1 — a recovery
  -- code cannot raise Supabase's assurance level, so resetting is all it can do.
  -- lib/mfa.ts then passes any session for an account with no
  -- verified factor -- correctly, since there is no longer a step-up to clear.
  -- So an aal1 attacker who can INSERT a self-chosen code_hash redeems it, drops
  -- the factor, and walks through the strict gate by the front door, minting
  -- credentials through the very service-role path 0028 just built. The UPDATE
  -- matters for the same reason: `used_at` is what makes a code single-use, so a
  -- writable one is an infinitely reusable one.
  if has_table_privilege('authenticated', 'public.mfa_recovery_codes', 'INSERT')
     or has_table_privilege('authenticated', 'public.mfa_recovery_codes', 'UPDATE')
     or has_table_privilege('authenticated', 'public.mfa_recovery_codes', 'DELETE') then
    raise exception 'authenticated must have no direct mfa_recovery_codes write path';
  end if;
  -- getMfaStatus counts the codes still unused, so the read stays.
  if not has_table_privilege('authenticated', 'public.mfa_recovery_codes', 'SELECT') then
    raise exception 'authenticated must retain SELECT on mfa_recovery_codes (status panel)';
  end if;

  -- Provider-key mutation is service-role-only (0030). The four originals derived
  -- the actor from auth.uid() and constrained every write with `and user_id =
  -- v_uid`, so they never crossed a tenant — but `authenticated` could execute
  -- them, which meant an aal1 session could add a key, overwrite the secret
  -- behind one it cannot read, switch which upstream account gets billed, or
  -- destroy a credential, all without the step-up the dashboard demands. They are
  -- replaced by *_for_user variants that take the tenant as an explicit argument
  -- supplied by trusted server code, never by the caller.
  --
  -- to_regprocedure, not has_function_privilege: the latter raises when the
  -- function is absent, which is precisely the state being asserted.
  if to_regprocedure('public.store_provider_key(text,text,text)') is not null
     or to_regprocedure('public.rotate_provider_key(uuid,text)') is not null
     or to_regprocedure('public.set_active_provider_key(uuid)') is not null
     or to_regprocedure('public.delete_provider_key(uuid)') is not null then
    raise exception 'auth.uid()-derived provider-key RPCs must be replaced by the *_for_user variants (0030)';
  end if;

  if has_function_privilege('authenticated', 'public.store_provider_key_for_user(uuid,text,text,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.rotate_provider_key_for_user(uuid,uuid,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.set_active_provider_key_for_user(uuid,uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.delete_provider_key_for_user(uuid,uuid)', 'EXECUTE') then
    raise exception 'authenticated must not execute provider-key mutations directly';
  end if;

  -- ...and the server must still be able to, or the dashboard is bricked.
  if not has_function_privilege('service_role', 'public.store_provider_key_for_user(uuid,text,text,text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.rotate_provider_key_for_user(uuid,uuid,text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.set_active_provider_key_for_user(uuid,uuid)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.delete_provider_key_for_user(uuid,uuid)', 'EXECUTE') then
    raise exception 'service_role must retain EXECUTE on the provider-key mutations';
  end if;

  -- The reads the dashboard genuinely needs must survive all of the above.
  if not has_table_privilege('authenticated', 'public.api_keys', 'SELECT')
     or not has_table_privilege('authenticated', 'public.agents', 'SELECT')
     or not has_table_privilege('authenticated', 'public.provider_credentials', 'SELECT') then
    raise exception 'authenticated must retain SELECT on its own credential metadata';
  end if;

  -- Seed two tenants (service/owner role bypasses RLS for setup).
  insert into auth.users (id) values (v_a), (v_b);
  insert into public.users (id, email) values (v_a, 'a@example.test'), (v_b, 'b@example.test');
  insert into public.agents (user_id, name, passport_pubkey, status)
    values (v_a, '__rls_A__', 'pkA_'||v_a, 'active'), (v_b, '__rls_B__', 'pkB_'||v_b, 'active');
  insert into public.agent_logs (agent_id, user_id, passport_id, jti, status)
    select id, user_id, 'pk', 'j', 'ok' from public.agents where user_id in (v_a, v_b);
  insert into public.admin_audit (user_id, action) values (v_a, 'agent.create'), (v_b, 'agent.create');
  insert into public.api_keys (user_id, name, key_prefix, key_hash, scope)
    values (v_a, 'A', 'pc_aaaa', 'hash_a_'||v_a, 'read'), (v_b, 'B', 'pc_bbbb', 'hash_b_'||v_b, 'read');
  insert into public.mfa_recovery_codes (user_id, code_hash)
    values (v_a, 'rc_a_'||v_a), (v_b, 'rc_b_'||v_b);
  insert into public.agent_access_keys (user_id, agent_id, name, key_hash, key_suffix)
    select
      a.user_id,
      a.id,
      'rls-installation',
      case when a.user_id = v_a then repeat('A', 43) else repeat('B', 43) end,
      case when a.user_id = v_a then 'AAAAAAA1' else 'BBBBBBB2' end
    from public.agents as a
    where a.user_id in (v_a, v_b);
  select id into v_agent_a from public.agents where user_id = v_a;
  select id into v_key_a from public.agent_access_keys where user_id = v_a;

  -- (1) Authenticated tenant A: sees own rows, never tenant B's.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_a::text, true);
  select count(*) into n from public.agents where user_id = v_b;
  if n <> 0 then raise exception 'tenant leak: A saw % of B''s agents', n; end if;
  select count(*) into n from public.agents;
  if n <> 1 then raise exception 'A should see exactly its 1 own agent, saw %', n; end if;
  select count(*) into n from public.agent_logs where user_id = v_b;
  if n <> 0 then raise exception 'tenant leak: A saw B''s agent_logs'; end if;
  select count(*) into n from public.admin_audit where user_id = v_b;
  if n <> 0 then raise exception 'tenant leak: A saw B''s admin_audit'; end if;
  select count(*) into n from public.api_keys where user_id = v_b;
  if n <> 0 then raise exception 'tenant leak: A saw B''s api_keys'; end if;
  select count(*) into n from public.mfa_recovery_codes where user_id = v_b;
  if n <> 0 then raise exception 'tenant leak: A saw B''s mfa_recovery_codes'; end if;
  select count(id) into n from public.agent_access_keys where user_id = v_b;
  if n <> 0 then raise exception 'tenant leak: A saw B''s agent_access_keys'; end if;
  select count(id) into n from public.agent_access_keys;
  if n <> 1 then raise exception 'A should see exactly its 1 own agent_access_key, saw %', n; end if;

  -- (2) Swap identity to B — symmetric isolation.
  perform set_config('request.jwt.claim.sub', v_b::text, true);
  select count(*) into n from public.agents where user_id = v_a;
  if n <> 0 then raise exception 'tenant leak: B saw A''s agents'; end if;
  select count(*) into n from public.agents;
  if n <> 1 then raise exception 'B should see exactly its 1 own agent, saw %', n; end if;
  select count(id) into n from public.agent_access_keys where user_id = v_a;
  if n <> 0 then raise exception 'tenant leak: B saw A''s agent_access_keys'; end if;

  -- (3) service_role (gateway) bypasses RLS — sees both tenants.
  reset role;
  set local role service_role;
  select count(*) into n from public.agents where user_id in (v_a, v_b);
  if n <> 2 then raise exception 'service_role should see both tenants, saw %', n; end if;
  select count(*) into n from public.agent_access_keys where user_id in (v_a, v_b);
  if n <> 2 then raise exception 'service_role should see both tenants'' agent_access_keys, saw %', n; end if;

  -- Revocation determinism for the lower-assurance credential: the exact RPC
  -- used by the gateway authenticates the key, the lifecycle RPC revokes it,
  -- and the very next uncached authentication sees no principal. This is kept
  -- in the fresh-database CI invariant rather than the production canary,
  -- which deliberately has no permission to mutate invited tenant state.
  select count(*) into n
    from public.authenticate_direct_agent_key(repeat('A', 43));
  if n <> 1 then raise exception 'active Direct Agent Key should authenticate once, got % rows', n; end if;

  select count(*) into n
    from public.revoke_agent_access_key(v_a, v_agent_a, v_key_a);
  if n <> 1 then raise exception 'Direct Agent Key revoke transition should affect one key, got % rows', n; end if;

  select count(*) into n
    from public.authenticate_direct_agent_key(repeat('A', 43));
  if n <> 0 then raise exception 'revoked Direct Agent Key authenticated on the next lookup'; end if;

  reset role;
  raise notice 'RLS invariants: PASS';
end $$;

rollback;
