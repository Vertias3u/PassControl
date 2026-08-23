-- ============================================================================
-- PassControl — public operator profile invariants (trust boundary #5, public edge).
--
-- rls_invariants.sql asserts the GRANTS on the profile surface, and
-- tests/profile-migration.test.ts asserts the migration's text. Neither can show
-- that the functions actually behave. This does: it creates a real operator with
-- a real agent and drives the opt-ins, because the property being protected here
-- is behavioural rather than structural.
--
-- The invariants:
--   1. A profile that has not opted in is invisible.
--   2. Publishing the PROFILE publishes no AGENT. The two opt-ins are
--      independent, which is the single most important property of this feature
--      and the one a careless join would quietly destroy.
--   3. A published agent is listed under its `public_label`, never under
--      `agents.name`. Internal agent names are customer-identifying — 0015
--      refuses `name` on the public passport surface for exactly this reason,
--      and `acme-prod-billing` published under a vendor's handle is a customer
--      list.
--   4. Handle lookup is case-folded, so /@TestOp and /@testop are one operator
--      and not a near-miss impersonation pair.
--   5. Un-publishing the profile takes the agent list with it.
--
-- Everything runs inside a transaction and is ROLLED BACK, so the test leaves no
-- data. Identities are real auth.users rows because public.users FKs to them.
--
-- Run (exit 0 = pass, non-zero = a violated invariant):
--   psql -v ON_ERROR_STOP=1 -f db/tests/public_profile_invariants.sql "$DATABASE_URL"
-- ============================================================================

begin;

do $$
declare
  v_u uuid := gen_random_uuid();
  v_other uuid := gen_random_uuid();
  n int;
  v_label text;
  v_locked boolean;
  v_status text;
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
  values (v_u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'profile-invariants@example.test', '', now(), now()),
         (v_other, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'profile-invariants-b@example.test', '', now(), now());

  insert into public.users (id, email, username, display_name, plan, profile_public)
  values (v_u, 'profile-invariants@example.test', 'testop', 'Test Operator', 'free', false),
         (v_other, 'profile-invariants-b@example.test', 'otherop', 'Other Operator', 'free', true);

  -- A deliberately customer-identifying internal name, so invariant 3 is a real
  -- test rather than a tautology.
  insert into public.agents (user_id, name, passport_pubkey, public_label, published)
  values (v_u, 'acme-prod-billing', repeat('A', 43), 'Research Agent', false);

  -- (1) A profile that has not opted in does not exist publicly.
  select count(*) into n from public.public_operator_profile('testop');
  if n <> 0 then raise exception 'a private profile was publicly visible'; end if;

  -- (2) Publishing the profile must NOT publish the agent.
  update public.users set profile_public = true where id = v_u;

  select count(*) into n from public.public_operator_profile('testop');
  if n <> 1 then raise exception 'a published profile was not visible'; end if;

  select count(*) into n from public.public_operator_agents('testop', 24);
  if n <> 0 then
    raise exception 'publishing the profile also published an agent: the two opt-ins are not independent';
  end if;

  -- The count on the profile must agree with the list, or the page advertises
  -- agents it will not show.
  select published_agent_count into n from public.public_operator_profile('testop');
  if n <> 0 then raise exception 'published_agent_count counted an unpublished agent'; end if;

  -- (3) Publish the agent. It appears, under its label only.
  update public.agents set published = true where user_id = v_u;

  select count(*) into n from public.public_operator_agents('testop', 24);
  if n <> 1 then raise exception 'a published agent was not listed'; end if;

  select label into v_label from public.public_operator_agents('testop', 24) limit 1;
  if v_label = 'acme-prod-billing' then
    raise exception 'the internal agent name reached the public list (customer-identifying)';
  end if;
  if v_label <> 'Research Agent' then
    raise exception 'the public list did not use public_label, got: %', v_label;
  end if;

  select published_agent_count into n from public.public_operator_profile('testop');
  if n <> 1 then raise exception 'published_agent_count disagrees with the published list'; end if;

  -- (4) Handle lookup is case-folded in the database, not only in TypeScript.
  select count(*) into n from public.public_operator_profile('TESTOP');
  if n <> 1 then raise exception 'handle lookup is not case-folded'; end if;

  -- An agent with no passport cannot be verified, so it must not be listed —
  -- 0023 made passport_pubkey nullable for Direct Agent Key agents.
  insert into public.agents (user_id, name, passport_pubkey, public_label, published)
  values (v_u, 'direct-key-agent', null, 'Direct Agent', true);
  select count(*) into n from public.public_operator_agents('testop', 24);
  if n <> 1 then raise exception 'an unverifiable (passport-less) agent was listed publicly'; end if;

  -- One tenant's published agents must never appear under another's handle.
  select count(*) into n from public.public_operator_agents('otherop', 24);
  if n <> 0 then raise exception 'tenant leak: agents surfaced under a different operator''s handle'; end if;

  -- (5) Un-publishing the profile withdraws the whole surface, agents included.
  update public.users set profile_public = false where id = v_u;
  select count(*) into n from public.public_operator_agents('testop', 24);
  if n <> 0 then raise exception 'agents were still listed under a profile that is no longer public'; end if;
  select count(*) into n from public.public_operator_profile('testop');
  if n <> 0 then raise exception 'the profile was still visible after being un-published'; end if;

  -- An avatar KEY with no avatar PATH must not be published.
  --
  -- That pairing is reachable by ordinary use: setProfilePublic(false) rotates
  -- the key to revoke shared URLs, and it did so even for an operator who never
  -- uploaded anything. Publishing again then handed the page a key that
  -- avatar_object_path() refuses (it filters on avatar_path is not null), so a
  -- stranger got a broken-image icon. The dashboard can guard this because it
  -- reads both columns; the public page cannot, because avatar_path is private
  -- by design — so the guard has to live in the RPC.
  -- The exact state the bug produced: a rotated key, and nothing stored.
  update public.users
     set profile_public = true, avatar_path = null, avatar_key = 'rotatedkeynopath'
   where id = v_u;
  select count(*) into n
    from public.public_operator_profile('testop') p
   where p.avatar_key is not null;
  if n <> 0 then
    raise exception 'avatar_key was published for a profile with no stored avatar (renders as a broken image)';
  end if;

  -- And the normal case still works, or the guard has broken avatars entirely.
  update public.users set avatar_path = 'someuser/avatar', avatar_key = 'abc123' where id = v_u;
  select count(*) into n
    from public.public_operator_profile('testop') p
   where p.avatar_key = 'abc123';
  if n <> 1 then raise exception 'a real avatar was not published'; end if;

  update public.users set profile_public = false where id = v_u;

  -- Publishing with no label must be unrepresentable. The state renders as a
  -- blank row to a stranger, and the obvious fix for a blank row is to fall back
  -- to agents.name — which is the one thing that must never happen here.
  begin
    insert into public.agents (user_id, name, passport_pubkey, public_label, published)
    values (v_u, 'unlabelled', repeat('C', 43), null, true);
    raise exception 'an agent was published with no public_label (renders blank, invites a name fallback)';
  exception when check_violation then
    null;
  end;

  -- A retired handle must never be re-registrable: an old /@handle link resolving
  -- to a different operator is an impersonation vector, not a tidiness question.
  -- The table's primary key is not the enforcement — this is.
  update public.users set username = null where id = v_u;
  insert into public.retired_usernames (username) values ('testop');

  begin
    update public.users set username = 'testop' where id = v_u;
    raise exception 'a retired handle was reclaimed by its original owner';
  exception when unique_violation then
    null;
  end;

  begin
    update public.users set username = 'testop' where id = v_other;
    raise exception 'a retired handle was reclaimed by a DIFFERENT operator (impersonation)';
  exception when unique_violation then
    null;
  end;

  -- The trigger must not block an unrelated update to the same row, or every
  -- profile edit after a handle retirement would fail.
  update public.users set display_name = 'Renamed' where id = v_other;

  -- A published handle stops moving, and the DATABASE says so too (0034).
  --
  -- LAST on purpose: this locks v_other, and the retirement assertions above
  -- still need that row's handle to be movable.
  --
  -- The application refuses this first and with better wording; this is the
  -- backstop, so that the rule survives a caller that forgets to check. Same
  -- "a mistake has to be made twice" discipline as the retirement trigger.
  -- NOTE the flag rather than a `raise` inside the block, and it is not style.
  -- 0034's trigger raises with the DEFAULT errcode, which IS `raise_exception`
  -- (P0001) — so a `raise exception 'it was changed'` written inside a block
  -- that catches `raise_exception` would be caught by its own handler and this
  -- assertion could never fail. It was written that way first, and dropping the
  -- trigger did not turn it red. The retirement checks above are safe from this
  -- because they catch `unique_violation`, which their own raise is not.
  update public.users set handle_locked_at = now() where id = v_other;
  v_locked := true;
  begin
    update public.users set username = 'otherop_renamed' where id = v_other;
    v_locked := false; -- reached only if the trigger did NOT fire
  exception when raise_exception then
    null;
  end;
  if not v_locked then
    raise exception 'a locked handle was changed (it has been public; links to it exist)';
  end if;

  -- The lock must not freeze the rest of the profile. An operator whose handle
  -- is permanent still edits their bio.
  update public.users set display_name = 'Still Editable' where id = v_other;

  -- And an unlocked handle still moves freely, or the lock has swallowed every
  -- handle rather than only published ones. v_u has never been published, and
  -- neither of these names has been retired above.
  update public.users set username = 'freshname_one' where id = v_u;
  update public.users set username = 'freshname_two' where id = v_u;

  -- ── change_handle() is ATOMIC (0034) ──────────────────────────────────────
  --
  -- The property the function exists for: a REFUSED change must leave no trace.
  -- The two-statement version retired the old handle first and then failed the
  -- rename, so an operator who typo'd a taken name silently lost the ability to
  -- ever return to the name they still held. Both writes now share one
  -- subtransaction, so the retirement rolls back with the update.
  -- Clear the locks in a statement of their OWN. 0034's trigger reads
  -- old.handle_locked_at, so clearing the lock and renaming in one UPDATE is
  -- still refused — the row it inspects is the pre-update one.
  update public.users set handle_locked_at = null where id in (v_u, v_other);
  update public.users set username = 'atomic_a' where id = v_u;
  update public.users set username = 'atomic_b' where id = v_other;

  select status into v_status from public.change_handle(v_u, 'atomic_b');
  if v_status <> 'taken' then
    raise exception 'change_handle did not report a held name as taken, got: %', v_status;
  end if;

  -- THE ASSERTION. A failed change must not have retired anything.
  select count(*) into n from public.retired_usernames where username = 'atomic_a';
  if n <> 0 then
    raise exception 'a REFUSED handle change still retired the handle the operator kept';
  end if;
  select count(*) into n from public.users where id = v_u and username = 'atomic_a';
  if n <> 1 then raise exception 'a refused handle change moved the handle anyway'; end if;

  -- A successful change does retire, in the same one call.
  select status into v_status from public.change_handle(v_u, 'atomic_c');
  if v_status <> 'ok' then raise exception 'a valid handle change was refused: %', v_status; end if;
  select count(*) into n from public.retired_usernames where username = 'atomic_a';
  if n <> 1 then raise exception 'a successful handle change did not retire the old handle'; end if;

  -- A locked handle is refused by the function, and a no-op resubmit is not a
  -- change so it stays allowed — otherwise re-saving a profile would start
  -- failing the moment the handle became permanent.
  update public.users set handle_locked_at = now() where id = v_u;
  select status into v_status from public.change_handle(v_u, 'atomic_d');
  if v_status <> 'locked' then raise exception 'a locked handle was allowed to move: %', v_status; end if;
  select status into v_status from public.change_handle(v_u, 'atomic_c');
  if v_status <> 'ok' then raise exception 'a no-op resubmit of a locked handle was refused'; end if;

  -- And nothing was retired by either of those.
  select count(*) into n from public.retired_usernames where username = 'atomic_c';
  if n <> 0 then raise exception 'a locked-handle attempt retired the current handle'; end if;

  raise notice 'Public profile invariants: PASS';
end $$;

rollback;
