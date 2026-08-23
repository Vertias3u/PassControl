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
     and relname in ('users','agents','agent_logs','provider_credentials','admin_audit','agent_spend_checkpoint','api_keys','mfa_recovery_codes','agent_access_keys','agent_owners','retired_usernames')
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

  -- Positive guards, because the failure mode here is a DROPPED grant, not an
  -- added one. 0011 granted four columns; 0018 appended `fallbacks` to that list.
  -- Anyone who "tidies" this by re-issuing a table-level revoke plus a fresh
  -- grant list silently removes whichever column they forget, and the negative
  -- assertions above would all still pass. 0033 therefore adds its columns
  -- without touching the agents grants at all.
  if not has_column_privilege('authenticated', 'public.agents', 'fallbacks', 'UPDATE') then
    raise exception 'authenticated lost UPDATE on agents.fallbacks (a re-granted column list dropped it)';
  end if;
  if not has_column_privilege('authenticated', 'public.agents', 'allowed_scopes', 'UPDATE') then
    raise exception 'authenticated lost UPDATE on agents.allowed_scopes';
  end if;

  -- Publishing an agent is a disclosure act: it puts a label and a passport
  -- fingerprint on a page a stranger reads. It runs server-side behind
  -- mfaAuthorizedUser, because RLS can prove who owns the row but not that the
  -- session cleared a second factor -- the same argument 0017 makes for `tier`.
  if has_column_privilege('authenticated', 'public.agents', 'published', 'UPDATE') then
    raise exception 'authenticated must not publish an agent directly through PostgREST';
  end if;
  if has_column_privilege('authenticated', 'public.agents', 'public_label', 'UPDATE') then
    raise exception 'authenticated must not set a public agent label directly through PostgREST';
  end if;

  -- Policy is the agent's leash: deny rules, UTC windows and the hourly cap.
  -- It is not in 0011's grant list and must never be added to it. The reason is
  -- sharper than "server-side is tidier": lib/scope.ts parses a NULL policy as
  -- an EMPTY one -- no denies, no windows, no cap -- so a browser role able to
  -- write this column could remove every restriction on its own agent by
  -- sending one null, and the fleet table would still show a configured agent.
  -- The workspace import writes these columns under service_role with an
  -- explicit user_id filter for exactly this reason.
  if has_column_privilege('authenticated', 'public.agents', 'policy', 'UPDATE') then
    raise exception 'authenticated must not write agents.policy (a null policy is an empty policy)';
  end if;
  if has_column_privilege('authenticated', 'public.agents', 'policy_shadow', 'UPDATE') then
    raise exception 'authenticated must not write agents.policy_shadow';
  end if;

  -- 0035 turns the two passport columns into one global reservation namespace.
  -- The table itself is intentionally unreachable, including to service_role:
  -- trusted code writes `agents`, and the SECURITY DEFINER trigger maintains
  -- reservations in that SAME transaction. The only server-facing read is a
  -- boolean availability RPC used by workspace-import previews; browser roles
  -- cannot call either function or inspect the table as an identity oracle.
  if to_regclass('public.passport_key_namespace') is null then
    raise exception 'passport_key_namespace is missing';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.passport_key_namespace'::regclass) then
    raise exception 'passport_key_namespace must have RLS enabled';
  end if;
  if has_table_privilege('anon', 'public.passport_key_namespace', 'SELECT')
     or has_table_privilege('authenticated', 'public.passport_key_namespace', 'SELECT')
     or has_table_privilege('service_role', 'public.passport_key_namespace', 'SELECT')
     or has_table_privilege('authenticated', 'public.passport_key_namespace', 'INSERT')
     or has_table_privilege('authenticated', 'public.passport_key_namespace', 'UPDATE')
     or has_table_privilege('authenticated', 'public.passport_key_namespace', 'DELETE') then
    raise exception 'passport_key_namespace must be trigger-private';
  end if;
  if to_regprocedure('public.sync_passport_key_namespace()') is null
     or to_regprocedure('public.passport_key_availability(text[])') is null
     or not exists (
       select 1 from pg_trigger
        where tgrelid = 'public.agents'::regclass
          and tgname = 'agents_passport_key_namespace_sync'
          and not tgisinternal
     ) then
    raise exception 'passport namespace trigger or availability RPC is missing';
  end if;
  if has_function_privilege('anon', 'public.sync_passport_key_namespace()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.sync_passport_key_namespace()', 'EXECUTE')
     or has_function_privilege('service_role', 'public.sync_passport_key_namespace()', 'EXECUTE')
     or has_function_privilege('anon', 'public.passport_key_availability(text[])', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.passport_key_availability(text[])', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.passport_key_availability(text[])', 'EXECUTE') then
    raise exception 'passport namespace functions have the wrong execution grants';
  end if;

  -- The public profile RPCs. 0015's central protection is that "public" happens
  -- in the web tier, not in the database: a server component calls these with
  -- the service client, and the browser roles cannot reach them at all. A newly
  -- created function defaults to EXECUTE for PUBLIC, so this is the assertion
  -- that catches a `create or replace` that forgot to re-issue its revoke --
  -- exactly the trap 0017's header records.
  if to_regprocedure('public.public_operator_profile(text)') is null
     or to_regprocedure('public.public_operator_agents(text,integer)') is null
     or to_regprocedure('public.avatar_object_path(text)') is null then
    raise exception 'the public operator-profile RPCs are missing';
  end if;
  if has_function_privilege('anon', 'public.public_operator_profile(text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.public_operator_agents(text,integer)', 'EXECUTE')
     or has_function_privilege('anon', 'public.avatar_object_path(text)', 'EXECUTE') then
    raise exception 'anon must not execute the public profile RPCs directly';
  end if;
  if has_function_privilege('authenticated', 'public.public_operator_profile(text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.public_operator_agents(text,integer)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.avatar_object_path(text)', 'EXECUTE') then
    raise exception 'authenticated must not execute the public profile RPCs directly';
  end if;

  -- retired_usernames follows the migration ledger in 0019: RLS on, no policy at
  -- all, so neither PostgREST role sees a row even holding a stray grant.
  if has_table_privilege('authenticated', 'public.retired_usernames', 'SELECT')
     or has_table_privilege('anon', 'public.retired_usernames', 'SELECT') then
    raise exception 'retired_usernames must not be readable by a browser role';
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

  -- public.users is the account row, and 0002 tried and failed to keep `plan` off
  -- the client. It issued `revoke update (plan)` with no accompanying GRANT, which
  -- cannot narrow a table-level privilege — 0011 and 0012 both say so in their own
  -- headers and both fix it by replacing the table grant. 0002 never did, and
  -- 0007_grants.sql then re-issued `grant all on public.users` afterwards anyway.
  -- The result, confirmed against the live dump before 0032: any logged-in session
  -- could run `update public.users set plan = … where id = auth.uid()`.
  --
  -- 0032 follows agent_owners (0017) rather than the column allowlist of 0011/0012:
  -- revoke the writes outright and run every mutation through the service role.
  -- That is why this asserts NO write privilege at all rather than checking a list
  -- of editable columns — there is no list to keep in sync, so a profile column
  -- added later cannot arrive writable by accident.
  if has_table_privilege('authenticated', 'public.users', 'INSERT')
     or has_table_privilege('authenticated', 'public.users', 'UPDATE')
     or has_table_privilege('authenticated', 'public.users', 'DELETE') then
    raise exception 'authenticated must have no direct public.users write path (plan is forgeable)';
  end if;
  -- Named explicitly as well as covered by the table check above, because `plan`
  -- is the column 0002 was actually aiming at and a future column re-grant would
  -- most plausibly reintroduce it.
  if has_column_privilege('authenticated', 'public.users', 'plan', 'UPDATE') then
    raise exception 'authenticated must not be able to choose its own plan';
  end if;
  -- ...but the read must survive. users_self already confines a SELECT to the
  -- caller's own row, and the dashboard depends on it; a blanket revoke here would
  -- look like a tightening and would actually be a regression.
  if not has_table_privilege('authenticated', 'public.users', 'SELECT') then
    raise exception 'authenticated must keep SELECT on public.users (users_self scopes it)';
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
  -- ...and it must not be READABLE either, which 0029 got wrong (0031 fixes it).
  -- 0029 kept SELECT because `getMfaStatus` renders a count of unused codes, and a
  -- count of one's own codes really does leak nothing. But the application's
  -- projection is not the database's capability: PostgREST lets the caller choose
  -- its own columns, so `?select=code_hash` returns the verifiers themselves to any
  -- aal1 session for the tenant. A recovery code is ~49.5 bits (10 chars of a
  -- 31-glyph alphabet) stored as a bare SHA-256, so possession of the hashes is an
  -- OFFLINE search no online control can rate-limit — and one recovered code
  -- legitimately resets the factor via the path above. The count now comes from a
  -- trusted server action instead.
  if has_table_privilege('authenticated', 'public.mfa_recovery_codes', 'SELECT') then
    raise exception 'authenticated must not SELECT mfa_recovery_codes; recovery verifier material is server-only';
  end if;
  -- Asserted at column granularity too: a future column-level grant would leave the
  -- table-level check above passing while handing back the one column that matters.
  if has_column_privilege('authenticated', 'public.mfa_recovery_codes', 'code_hash', 'SELECT') then
    raise exception 'authenticated must never read MFA recovery-code hashes';
  end if;
  if has_table_privilege('anon', 'public.mfa_recovery_codes', 'SELECT')
     or has_column_privilege('anon', 'public.mfa_recovery_codes', 'code_hash', 'SELECT') then
    raise exception 'anon must not SELECT mfa_recovery_codes';
  end if;
  -- ...while the server must still be able to issue, count and consume them.
  if not has_table_privilege('service_role', 'public.mfa_recovery_codes', 'SELECT')
     or not has_table_privilege('service_role', 'public.mfa_recovery_codes', 'INSERT')
     or not has_table_privilege('service_role', 'public.mfa_recovery_codes', 'UPDATE')
     or not has_table_privilege('service_role', 'public.mfa_recovery_codes', 'DELETE') then
    raise exception 'service_role must retain lifecycle access to mfa_recovery_codes';
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
  -- Recovery codes are no longer tenant-scoped-by-RLS, they are unreachable: the
  -- grant is gone (0031), so there is no "own rows" read left to leak. Asserted
  -- behaviourally rather than by privilege introspection alone, because this is
  -- the exact call the attack made. Dynamic SQL so the failure is raised at
  -- execution rather than at plan time, and ONLY insufficient_privilege is
  -- caught — catching `others` would swallow the raise below and make the
  -- assertion unfailable.
  begin
    execute 'select code_hash from public.mfa_recovery_codes limit 1';
    raise exception 'authenticated could still read mfa_recovery_codes.code_hash';
  exception
    when insufficient_privilege then null;
  end;
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

  -- Namespace mutation tests inspect the trigger-private table directly, so
  -- return to the migration owner. The service-role negative table-grant is
  -- asserted above and the service-only availability call is exercised below.
  reset role;

  -- A key held as one tenant's CURRENT key must not be written into another
  -- tenant's RETIRED column. 0021's separate unique constraints allowed this
  -- cross-column case; 0035's trigger raises inside the UPDATE transaction.
  begin
    update public.agents
       set previous_passport_pubkey = 'pkA_' || v_a
     where user_id = v_b;
    raise exception 'a current passport could be registered as another agent''s retired key';
  exception
    when sqlstate 'P0001' then
      if position('passport_key_in_use' in sqlerrm) = 0 then
        raise;
      end if;
  end;

  -- Rotate A, then prove its old key remains reserved until only A clears it.
  -- Once that cleanup commits, B can claim it as a current key; the trigger did
  -- not delete another row's reservation while clearing A's stale state.
  update public.agents
     set passport_pubkey = 'pkA_rotated_' || v_a,
         previous_passport_pubkey = 'pkA_' || v_a,
         previous_valid_until = now() - interval '1 second'
   where user_id = v_a;
  begin
    update public.agents
       set passport_pubkey = 'pkA_' || v_a
     where user_id = v_b;
    raise exception 'a still-reserved passport could be claimed by another agent';
  exception
    when sqlstate 'P0001' then
      if position('passport_key_in_use' in sqlerrm) = 0 then
        raise;
      end if;
  end;
  update public.agents
     set previous_passport_pubkey = null,
         previous_valid_until = null
   where user_id = v_a;
  update public.agents
     set passport_pubkey = 'pkA_' || v_a
   where user_id = v_b;
  if not exists (
    select 1 from public.passport_key_namespace
     where passport_pubkey = 'pkA_' || v_a
  ) then
    raise exception 'the surviving agent lost its passport reservation during stale-key cleanup';
  end if;

  -- Service-role callers can ask only whether a public key is free. The table
  -- remains unreadable even to that role; the SECURITY DEFINER function is the
  -- narrow availability mechanism the import dry run uses.
  reset role;
  set local role service_role;
  select count(*) into n
    from public.passport_key_availability(array['pkA_' || v_a, 'free_' || v_a]) as availability
   where (availability.passport_pubkey = 'pkA_' || v_a and availability.available = false)
      or (availability.passport_pubkey = 'free_' || v_a and availability.available = true);
  if n <> 2 then
    raise exception 'passport key availability did not report only the reserved/free state';
  end if;

  reset role;

  -- Migration-rollout proof: only the database owner in this disposable test
  -- may suppress the trigger long enough to construct the legacy shape 0035
  -- faces on an already-running deployment. The exact preflight grouping in
  -- 0035 finds the current-vs-retired collision instead of a UNION silently
  -- choosing one claimant. Browser and service roles cannot disable a trigger
  -- or write the private namespace (asserted above).
  alter table public.agents disable trigger agents_passport_key_namespace_sync;
  update public.agents
     set previous_passport_pubkey = 'pkA_rotated_' || v_a
   where user_id = v_b;
  select count(*) into n
    from (
      select claim.passport_pubkey
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
    ) as legacy_conflict
   where legacy_conflict.passport_pubkey = 'pkA_rotated_' || v_a;
  if n <> 1 then
    raise exception '0035 preflight would not detect a legacy current-versus-retired collision';
  end if;
  alter table public.agents enable trigger agents_passport_key_namespace_sync;

  raise notice 'RLS invariants: PASS';
end $$;

rollback;
