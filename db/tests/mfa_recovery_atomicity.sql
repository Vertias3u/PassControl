-- ============================================================================
-- PassControl — `replace_mfa_recovery_codes_for_user` is all-or-nothing (0031).
--
-- Recovery-code replacement used to be DELETE then INSERT as two PostgREST round
-- trips, which cannot be atomic in either direction:
--
--   DELETE ok + INSERT fails → the user has NO backup codes, right after a screen
--     that told them their new ones were ready.
--   DELETE fails + INSERT ok → the OLD codes are still redeemable while the
--     operator believes they were revoked. Fresh hashes are random, so nothing
--     ever collides the old set away — it just quietly stays valid.
--
-- Source inspection cannot prove a rollback happened, so this drives the real
-- function against a real database and forces the INSERT half to fail. The lever
-- is `unique (user_id, code_hash)` from 0009: a p_hashes array containing the
-- same hash twice violates it deterministically, part-way through the insert,
-- after the delete has already run inside the function's transaction.
--
-- Run (exit 0 = pass):
--   psql -v ON_ERROR_STOP=1 -f db/tests/mfa_recovery_atomicity.sql "$DATABASE_URL"
-- ============================================================================

begin;

do $$
declare
  v_u    uuid := gen_random_uuid();
  h_old1 text := repeat('1', 64);
  h_old2 text := repeat('2', 64);
  h_new1 text := repeat('a', 64);
  h_new2 text := repeat('b', 64);
  v_created timestamptz;
  n      int;
  raised boolean;
begin
  insert into auth.users (id) values (v_u);
  insert into public.users (id, email) values (v_u, 'atomicity@example.test');

  -- ── The old set, as issued ────────────────────────────────────────────────
  insert into public.mfa_recovery_codes (user_id, code_hash)
    values (v_u, h_old1), (v_u, h_old2);
  select created_at into v_created
    from public.mfa_recovery_codes where user_id = v_u and code_hash = h_old1;

  -- ── (1) Forced INSERT failure must roll the DELETE back ───────────────────
  raised := false;
  begin
    -- The same hash twice: passes the format check, trips the unique index.
    perform public.replace_mfa_recovery_codes_for_user(v_u, array[h_new1, h_new1]);
  exception
    -- Only the violation we forced. Catching `others` would swallow a genuine
    -- regression (a dropped function, a renamed column) and pass regardless.
    when unique_violation then raised := true;
  end;
  if not raised then
    raise exception 'replacement with a duplicate hash should have failed';
  end if;

  select count(*) into n from public.mfa_recovery_codes where user_id = v_u;
  if n <> 2 then
    raise exception 'failed replacement left % rows, expected the original 2', n;
  end if;
  select count(*) into n from public.mfa_recovery_codes
   where user_id = v_u and code_hash in (h_old1, h_old2);
  if n <> 2 then
    raise exception 'failed replacement destroyed the previous recovery set';
  end if;
  -- Unchanged, not merely re-created: a same-shaped row with a new created_at
  -- would mean the delete committed and something re-inserted.
  if (select created_at from public.mfa_recovery_codes
       where user_id = v_u and code_hash = h_old1) <> v_created then
    raise exception 'previous recovery set was rewritten, not preserved';
  end if;
  -- ...and no partial new row survived the rollback.
  select count(*) into n from public.mfa_recovery_codes
   where user_id = v_u and code_hash = h_new1;
  if n <> 0 then
    raise exception 'a row from the failed replacement survived';
  end if;

  -- ── (2) Malformed input fails atomically too ──────────────────────────────
  -- 'nothex' is the shape a plaintext code or a truncated digest would have.
  foreach h_new1 in array array[repeat('z', 64), repeat('a', 63), 'A' || repeat('a', 63)]
  loop
    raised := false;
    begin
      perform public.replace_mfa_recovery_codes_for_user(v_u, array[h_new1]);
    exception
      when raise_exception then raised := true;
    end;
    if not raised then
      raise exception 'malformed hash % was accepted', h_new1;
    end if;
  end loop;
  select count(*) into n from public.mfa_recovery_codes
   where user_id = v_u and code_hash in (h_old1, h_old2);
  if n <> 2 then
    raise exception 'a rejected malformed payload still cleared the old set';
  end if;

  -- An empty or null set is a refusal, not a silent wipe: clearing the codes is
  -- what the reset and unenrol paths do with an explicit DELETE, and a caller bug
  -- must not be able to erase someone's backups while looking like an issuance.
  raised := false;
  begin
    perform public.replace_mfa_recovery_codes_for_user(v_u, array[]::text[]);
  exception when raise_exception then raised := true;
  end;
  if not raised then raise exception 'empty replacement set was accepted'; end if;

  raised := false;
  begin
    perform public.replace_mfa_recovery_codes_for_user(null, array[repeat('c', 64)]);
  exception when raise_exception then raised := true;
  end;
  if not raised then raise exception 'null p_user_id was accepted'; end if;

  select count(*) into n from public.mfa_recovery_codes where user_id = v_u;
  if n <> 2 then raise exception 'refused calls still mutated the set'; end if;

  -- ── (3) The happy path really does replace ────────────────────────────────
  -- This case is load-bearing for (1), not just a smoke test. On its own, "the old
  -- rows are still there after a failure" is equally consistent with a function
  -- that never deletes at all. Proving the delete DOES run when the insert
  -- succeeds is what makes its absence after a failure a rollback.
  h_new1 := repeat('a', 64);
  if public.replace_mfa_recovery_codes_for_user(v_u, array[h_new1, h_new2]) <> 2 then
    raise exception 'successful replacement should report 2 stored hashes';
  end if;
  select count(*) into n from public.mfa_recovery_codes
   where user_id = v_u and code_hash in (h_old1, h_old2);
  if n <> 0 then raise exception 'old recovery codes survived a successful replacement'; end if;
  select count(*) into n from public.mfa_recovery_codes where user_id = v_u;
  if n <> 2 then raise exception 'expected exactly the 2 new hashes, found %', n; end if;
  select count(*) into n from public.mfa_recovery_codes
   where user_id = v_u and code_hash in (h_new1, h_new2);
  if n <> 2 then raise exception 'the new hashes are not the ones stored'; end if;

  -- ── (4) Replacement is tenant-scoped ──────────────────────────────────────
  -- p_user_id comes from server-verified session state, but the function must
  -- still only ever touch that tenant's rows.
  declare
    v_other uuid := gen_random_uuid();
  begin
    insert into auth.users (id) values (v_other);
    insert into public.users (id, email) values (v_other, 'atomicity-other@example.test');
    insert into public.mfa_recovery_codes (user_id, code_hash) values (v_other, h_old1);
    perform public.replace_mfa_recovery_codes_for_user(v_u, array[repeat('d', 64)]);
    select count(*) into n from public.mfa_recovery_codes where user_id = v_other;
    if n <> 1 then raise exception 'replacement crossed into another tenant''s codes'; end if;
  end;

  -- ── (5) Only the server may call it ───────────────────────────────────────
  if has_function_privilege('authenticated', 'public.replace_mfa_recovery_codes_for_user(uuid,text[])', 'EXECUTE')
     or has_function_privilege('anon', 'public.replace_mfa_recovery_codes_for_user(uuid,text[])', 'EXECUTE')
     or has_function_privilege('public', 'public.replace_mfa_recovery_codes_for_user(uuid,text[])', 'EXECUTE') then
    raise exception 'replace_mfa_recovery_codes_for_user must be service-role only';
  end if;
  if not has_function_privilege('service_role', 'public.replace_mfa_recovery_codes_for_user(uuid,text[])', 'EXECUTE') then
    raise exception 'service_role must retain EXECUTE on the replacement RPC';
  end if;
  -- SECURITY DEFINER with a pinned search_path, or an unqualified name inside the
  -- body resolves against the caller's path.
  -- Postgres stores the empty setting as `search_path=""`, so match the value
  -- rather than a literal string — an exact-equality check here silently passes
  -- or silently fails depending on how the server chose to quote it.
  if not exists (
    select 1 from pg_proc p
     where p.oid = 'public.replace_mfa_recovery_codes_for_user(uuid,text[])'::regprocedure
       and p.prosecdef
       and exists (
         select 1 from unnest(coalesce(p.proconfig, '{}')) as c
          where c ~ '^search_path=("")?$'
       )
  ) then
    raise exception 'replacement RPC must be SECURITY DEFINER with a pinned empty search_path';
  end if;

  raise notice 'MFA recovery-code atomicity: PASS';
end $$;

rollback;
