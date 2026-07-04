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
  n int;
  bad text;
begin
  -- (0) RLS enabled on every sensitive table.
  select string_agg(relname, ', ') into bad from pg_class
   where relnamespace = 'public'::regnamespace and relkind = 'r'
     and relname in ('users','agents','agent_logs','provider_credentials','admin_audit','agent_spend_checkpoint','api_keys','mfa_recovery_codes')
     and relrowsecurity = false;
  if bad is not null then raise exception 'RLS disabled on: %', bad; end if;

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

  -- (2) Swap identity to B — symmetric isolation.
  perform set_config('request.jwt.claim.sub', v_b::text, true);
  select count(*) into n from public.agents where user_id = v_a;
  if n <> 0 then raise exception 'tenant leak: B saw A''s agents'; end if;
  select count(*) into n from public.agents;
  if n <> 1 then raise exception 'B should see exactly its 1 own agent, saw %', n; end if;

  -- (3) service_role (gateway) bypasses RLS — sees both tenants.
  reset role;
  set local role service_role;
  select count(*) into n from public.agents where user_id in (v_a, v_b);
  if n <> 2 then raise exception 'service_role should see both tenants, saw %', n; end if;

  reset role;
  raise notice 'RLS invariants: PASS';
end $$;

rollback;
