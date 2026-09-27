-- First-run activation proof (0072) — database invariants.
-- Run only after every migration has been applied to a disposable/local DB.
-- Everything is rolled back; no fixture survives.
--
-- The rule: an allowed inference and a LATER deliberate scope refusal from the
-- same worker, after the operator started the guide's refusal test. Each block
-- below is one way to forge that proof, and each must fail.

begin;

do $$
declare
  v_u1 uuid := gen_random_uuid();
  v_u2 uuid := gen_random_uuid();
  v_a1 uuid := gen_random_uuid();      -- the worker under test
  v_a2 uuid := gen_random_uuid();      -- another worker, same tenant
  v_other uuid := gen_random_uuid();   -- another tenant's worker
  v_revoked uuid := gen_random_uuid();
  v_k1 uuid := gen_random_uuid();
  v_k2 uuid := gen_random_uuid();
  v_started timestamptz;
  v_ok boolean;
begin
  -- ── Fixtures ───────────────────────────────────────────────────────────────
  insert into auth.users (id, email) values
    (v_u1, 'refusal-proof-1@example.invalid'),
    (v_u2, 'refusal-proof-2@example.invalid');
  insert into public.users (id, email) values
    (v_u1, 'refusal-proof-1@example.invalid'),
    (v_u2, 'refusal-proof-2@example.invalid');
  insert into public.agents (id, user_id, name, status) values
    (v_a1, v_u1, 'worker-a', 'active'),
    (v_a2, v_u1, 'worker-b', 'active'),
    (v_revoked, v_u1, 'worker-gone', 'revoked'),
    (v_other, v_u2, 'someone-else', 'active');
  insert into public.provider_credentials (user_id, provider, vault_secret_id)
  values (v_u1, 'openai', gen_random_uuid());
  -- Random hashes, not repeat('a', 43): the hash is unique across the table, and
  -- a fixed literal collided with an unrelated key in a populated database
  -- (Session 08's upgrade lane and a seeded local stack both hit it).
  insert into public.agent_access_keys (id, user_id, agent_id, name, key_hash, key_suffix) values
    (v_k1, v_u1, v_a1, 'laptop', substr(md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text), 1, 43), 'aaaaaaaa'),
    (v_k2, v_u1, v_a1, 'server', substr(md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text), 1, 43), 'bbbbbbbb');

  -- Act as tenant 1 for every RPC below. auth.uid() reads these claims.
  perform set_config('request.jwt.claims', json_build_object('sub', v_u1)::text, true);

  -- ── Grants ─────────────────────────────────────────────────────────────────
  if has_function_privilege('anon', 'public.start_onboarding_refusal_test(uuid)', 'execute') then
    raise exception 'anon can start a refusal test';
  end if;
  if not has_function_privilege('authenticated', 'public.start_onboarding_refusal_test(uuid)', 'execute') then
    raise exception 'authenticated cannot start a refusal test';
  end if;
  if has_table_privilege('authenticated', 'public.onboarding_state', 'UPDATE')
     or has_table_privilege('authenticated', 'public.onboarding_state', 'INSERT') then
    raise exception 'onboarding_state is directly writable, so completion is forgeable';
  end if;

  -- ── Nothing started: an ordered call + refusal does not complete ──────────
  insert into public.agent_logs (agent_id, user_id, passport_id, jti, provider, model, status, created_at)
  values (v_a1, v_u1, 'pp1', 'j-ok', 'openai', 'gpt-5-mini', 'ok', now() - interval '10 minutes'),
         (v_a1, v_u1, 'pp1', 'j-old-refusal', 'openai', 'gpt-5', 'blocked_scope', now() - interval '5 minutes');
  if public.complete_onboarding() then
    raise exception 'completed without a started refusal test';
  end if;

  -- ── Starting a test on something the caller must not use ─────────────────
  if public.start_onboarding_refusal_test(v_other) is not null then
    raise exception 'started a refusal test on another tenant''s agent';
  end if;
  if public.start_onboarding_refusal_test(v_revoked) is not null then
    raise exception 'started a refusal test on a revoked agent';
  end if;

  v_started := public.start_onboarding_refusal_test(v_a1);
  if v_started is null then
    raise exception 'could not start a refusal test on an owned active agent';
  end if;

  -- ── A refusal older than the demonstration does not count ────────────────
  -- (the blocked_scope row above predates v_started)
  if public.complete_onboarding() then
    raise exception 'a historical refusal from before the test completed onboarding';
  end if;

  -- ── Another worker's refusal does not count ───────────────────────────────
  insert into public.agent_logs (agent_id, user_id, passport_id, jti, provider, model, status, created_at)
  values (v_a2, v_u1, 'pp2', 'j-other-worker', 'openai', 'gpt-5', 'blocked_scope', now() + interval '1 second');
  if public.complete_onboarding() then
    raise exception 'another worker''s refusal completed onboarding';
  end if;

  -- ── A stop control is not a refusal ───────────────────────────────────────
  insert into public.admin_audit (user_id, action, metadata, created_at)
  values (v_u1, 'killswitch.master', '{"on": true}'::jsonb, now() + interval '2 seconds'),
         (v_u1, 'agent.suspend', '{"suspended": true}'::jsonb, now() + interval '3 seconds');
  if public.complete_onboarding() then
    raise exception 'a kill-switch or suspend event completed onboarding';
  end if;

  -- ── A different refusal reason is not the scope demonstration ─────────────
  insert into public.agent_logs (agent_id, user_id, passport_id, jti, provider, model, status, created_at)
  values (v_a1, v_u1, 'pp1', 'j-killed', 'openai', 'gpt-5', 'blocked_killed', now() + interval '4 seconds');
  if public.complete_onboarding() then
    raise exception 'a kill-switch refusal completed onboarding';
  end if;

  -- ── A refusal with no earlier allowed call on that worker ─────────────────
  -- worker-b has a post-start refusal (above) but never an allowed call.
  perform public.start_onboarding_refusal_test(v_a2);
  if public.complete_onboarding() then
    raise exception 'a refusal with no earlier allowed call completed onboarding';
  end if;

  -- ── The real thing: same worker, ordered, after the start ─────────────────
  -- Restarting on worker-a moves the start forward; its earlier passport `ok`
  -- row carries no key id, so it pairs with this refusal by agent alone. The
  -- key rule is asserted on its own below, with keyed rows only.
  perform public.start_onboarding_refusal_test(v_a1);
  insert into public.agent_logs (agent_id, user_id, auth_method, agent_access_key_id, credential_use_id, provider, model, status, created_at)
  values (v_a1, v_u1, 'direct_key', v_k2, gen_random_uuid(), 'openai', 'gpt-5', 'blocked_scope', now() + interval '11 seconds');

  v_ok := public.complete_onboarding();
  if not v_ok then
    raise exception 'a genuine same-worker refusal after the start did not complete onboarding';
  end if;
  if (select completed_at from public.onboarding_state where user_id = v_u1) is null then
    raise exception 'completion returned true but stored nothing';
  end if;
end;
$$;

-- ── Key binding, isolated: keyed rows from two different keys never pair ────
do $$
declare
  v_u uuid := gen_random_uuid();
  v_a uuid := gen_random_uuid();
  v_k1 uuid := gen_random_uuid();
  v_k2 uuid := gen_random_uuid();
begin
  insert into auth.users (id, email) values (v_u, 'refusal-proof-keys@example.invalid');
  insert into public.users (id, email) values (v_u, 'refusal-proof-keys@example.invalid');
  insert into public.agents (id, user_id, name, status) values (v_a, v_u, 'keyed-worker', 'active');
  insert into public.provider_credentials (user_id, provider, vault_secret_id) values (v_u, 'openai', gen_random_uuid());
  insert into public.agent_access_keys (id, user_id, agent_id, name, key_hash, key_suffix) values
    (v_k1, v_u, v_a, 'laptop', substr(md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text), 1, 43), 'dddddddd'),
    (v_k2, v_u, v_a, 'server', substr(md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text), 1, 43), 'eeeeeeee');
  perform set_config('request.jwt.claims', json_build_object('sub', v_u)::text, true);
  perform public.start_onboarding_refusal_test(v_a);
  insert into public.agent_logs (agent_id, user_id, auth_method, agent_access_key_id, credential_use_id, provider, model, status, created_at)
  values (v_a, v_u, 'direct_key', v_k1, gen_random_uuid(), 'openai', 'gpt-5-mini', 'ok', now() + interval '1 second'),
         (v_a, v_u, 'direct_key', v_k2, gen_random_uuid(), 'openai', 'gpt-5', 'blocked_scope', now() + interval '2 seconds');
  if public.complete_onboarding() then
    raise exception 'an allowed call on one key and a refusal on another completed onboarding';
  end if;
  insert into public.agent_logs (agent_id, user_id, auth_method, agent_access_key_id, credential_use_id, provider, model, status, created_at)
  values (v_a, v_u, 'direct_key', v_k1, gen_random_uuid(), 'openai', 'gpt-5', 'blocked_scope', now() + interval '3 seconds');
  if not public.complete_onboarding() then
    raise exception 'a same-key refusal after the allowed call did not complete onboarding';
  end if;
end;
$$;

-- ── Existing completion and dismissal survive ────────────────────────────────
do $$
declare
  v_u uuid := gen_random_uuid();
  v_done timestamptz := now() - interval '30 days';
begin
  insert into auth.users (id, email) values (v_u, 'refusal-proof-old@example.invalid');
  insert into public.onboarding_state (user_id, dismissed_at, completed_at) values (v_u, v_done, v_done);
  perform set_config('request.jwt.claims', json_build_object('sub', v_u)::text, true);
  perform public.complete_onboarding();
  if (select completed_at from public.onboarding_state where user_id = v_u) is distinct from v_done
     or (select dismissed_at from public.onboarding_state where user_id = v_u) is distinct from v_done then
    raise exception 'an existing completion or dismissal was changed';
  end if;
end;
$$;

rollback;
