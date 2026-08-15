-- PassControl Cloud invite-beta database invariants.
-- Run only after every migration has been applied to a disposable/local DB.
-- Everything is rolled back; no fixture survives.

begin;

do $$
declare
  v_actor uuid := gen_random_uuid();
  v_user uuid := gen_random_uuid();
  v_application uuid := gen_random_uuid();
  v_withdrawal uuid := gen_random_uuid();
  v_invite uuid := gen_random_uuid();
  v_event uuid;
  v_result jsonb;
  v_ok boolean;
  v_status text;
begin
  if exists (
    select 1 from pg_class
     where relnamespace = 'public'::regnamespace
       and relname in ('beta_applications', 'beta_invites', 'beta_feedback', 'beta_operator_events')
       and relrowsecurity = false
  ) then
    raise exception 'beta launch table without RLS';
  end if;

  if has_table_privilege('anon', 'public.beta_applications', 'SELECT')
     or has_table_privilege('authenticated', 'public.beta_applications', 'SELECT')
     or has_table_privilege('authenticated', 'public.beta_invites', 'SELECT')
     or has_table_privilege('authenticated', 'public.beta_operator_events', 'SELECT') then
    raise exception 'beta operator data is directly readable';
  end if;
  if has_function_privilege('anon', 'public.claim_beta_invite(text,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.redeem_beta_invite(uuid,uuid)', 'EXECUTE') then
    raise exception 'beta invitation RPC exposed outside service_role';
  end if;
  if not has_function_privilege(
    'supabase_auth_admin',
    'public.hook_authorize_beta_signup(jsonb)',
    'EXECUTE'
  ) then
    raise exception 'Supabase Auth cannot execute invitation hook';
  end if;

  -- Future functions created by the migration role must start closed. This
  -- prevents a later migration from accidentally inheriting PostgreSQL's
  -- default PUBLIC EXECUTE grant before it reaches its explicit revokes.
  execute 'create function public.beta_default_privilege_probe() returns integer language sql as ''select 1''';
  if has_function_privilege('anon', 'public.beta_default_privilege_probe()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.beta_default_privilege_probe()', 'EXECUTE')
     or has_function_privilege('supabase_auth_admin', 'public.beta_default_privilege_probe()', 'EXECUTE') then
    raise exception 'future public function inherited PUBLIC execute';
  end if;
  execute 'drop function public.beta_default_privilege_probe()';

  -- A missing user id must be an explicit deny, not a successful hook response
  -- that strands the invitation in an unredeemable NULL-authorized state.
  v_result := public.hook_authorize_beta_signup(jsonb_build_object(
    'user', jsonb_build_object(
      'email', 'invitee@example.test',
      'user_metadata', jsonb_build_object(
        'passcontrol_beta_invite_id', gen_random_uuid()::text
      )
    )
  ));
  if v_result #>> '{error,http_code}' <> '403' then
    raise exception 'hook did not reject a missing user id: %', v_result;
  end if;

  insert into auth.users (id, email) values (v_actor, 'operator@example.test');
  insert into public.users (id, email) values (v_actor, 'operator@example.test');
  insert into public.beta_applications (
    id, email_normalized, integration, provider, monthly_call_bucket, use_case, status
  ) values (
    v_application, 'invitee@example.test', 'hermes', 'openai', 'under-1000',
    'A real external Hermes workspace for the invite beta.', 'invited'
  );
  insert into public.beta_invites (
    id, application_id, token_hash, expires_at, sent_at, claimed_at
  ) values (
    v_invite, v_application, repeat('a', 64), now() + interval '7 days', now(), now()
  );

  v_result := public.hook_authorize_beta_signup(jsonb_build_object(
    'user', jsonb_build_object(
      'id', v_user::text,
      'email', 'invitee@example.test',
      'user_metadata', jsonb_build_object(
        'passcontrol_beta_invite_id', v_invite::text
      )
    )
  ));
  if v_result <> '{}'::jsonb then
    raise exception 'valid invitation hook response was not allow: %', v_result;
  end if;
  if not exists (
    select 1 from public.beta_invites
     where id = v_invite and authorized_auth_user_id = v_user
  ) then
    raise exception 'hook did not bind Auth user id to invite';
  end if;

  insert into auth.users (id, email) values (v_user, 'invitee@example.test');
  update public.beta_invites
     set created_at = now() - interval '2 days',
         expires_at = now() - interval '1 day'
   where id = v_invite;
  select public.redeem_beta_invite(v_invite, v_user) into v_ok;
  if v_ok is distinct from false then
    raise exception 'expired invitation redeemed after Auth authorization';
  end if;
  update public.beta_invites
     set expires_at = now() + interval '7 days'
   where id = v_invite;
  select public.redeem_beta_invite(v_invite, v_user) into v_ok;
  if v_ok is distinct from true then
    raise exception 'bound invitation did not redeem';
  end if;
  if not exists (
    select 1 from public.beta_applications
     where id = v_application and status = 'accepted' and user_id = v_user
  ) then
    raise exception 'redemption did not bind accepted application';
  end if;

  -- A pending reservation serializes the one-shot follow-up. Failure frees a
  -- retry; sent remains terminal. No path records sent before provider success.
  insert into public.beta_operator_events (
    actor_user_id, application_id, action
  ) values (v_actor, v_application, 'nudge.pending')
  returning id into v_event;
  begin
    insert into public.beta_operator_events (
      actor_user_id, application_id, action
    ) values (v_actor, v_application, 'nudge.pending');
    raise exception 'concurrent nudge reservation was accepted';
  exception when unique_violation then null;
  end;
  update public.beta_operator_events
     set action = 'nudge.send_failed'
   where id = v_event;
  insert into public.beta_operator_events (
    actor_user_id, application_id, action
  ) values (v_actor, v_application, 'nudge.pending')
  returning id into v_event;
  update public.beta_operator_events set action = 'nudge.sent' where id = v_event;
  begin
    insert into public.beta_operator_events (
      actor_user_id, application_id, action
    ) values (v_actor, v_application, 'nudge.pending');
    raise exception 'sent nudge allowed a later reservation';
  exception when unique_violation then null;
  end;

  -- An applicant-requested withdrawal is a distinct, attributable state and
  -- receives the retention deadline promised by the privacy notice.
  insert into public.beta_applications (
    id, email_normalized, integration, provider, monthly_call_bucket, use_case
  ) values (
    v_withdrawal, 'withdraw@example.test', 'other', 'undecided', 'unknown',
    'A pending application whose owner requested data withdrawal.'
  );
  select public.withdraw_beta_application(v_withdrawal, v_actor) into v_ok;
  select status into v_status from public.beta_applications where id = v_withdrawal;
  if v_ok is distinct from true or v_status <> 'withdrawn' then
    raise exception 'withdrawal transition failed';
  end if;
  if not exists (
    select 1 from public.beta_operator_events
     where application_id = v_withdrawal
       and actor_user_id = v_actor
       and action = 'application.withdrawn'
  ) then
    raise exception 'withdrawal lacks actor attribution';
  end if;

  raise notice 'Beta launch invariants: PASS';
end $$;

rollback;
