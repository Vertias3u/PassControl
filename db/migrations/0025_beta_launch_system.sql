-- PassControl Cloud invite-beta launch system.
--
-- This migration adds beta objects and changes no existing product table or
-- row. It also closes PostgreSQL/Supabase's permissive defaults for functions
-- created later by the migration role. Applying it does not change signup
-- behavior; PASSCONTROL_INVITE_SOURCE controls whether the application accepts
-- the existing deployment-wide code or one-time database invitations.
--
-- The public form and operator console use server actions. Applications,
-- invitations and operator events intentionally have no anon/authenticated
-- policies. Feedback is the only user-facing table and is owner-scoped by RLS.

-- PostgreSQL grants function execution to PUBLIC by default. Make later
-- migrations start closed, then grant only the role each function needs.
-- PUBLIC's built-in function grant is a global default, so a schema-scoped
-- revoke cannot remove it. Supabase also seeds direct anon/authenticated
-- defaults in public; close both layers explicitly.
alter default privileges revoke execute on functions from public;
alter default privileges in schema public
  revoke execute on functions from anon, authenticated;

create table if not exists public.beta_applications (
  id                  uuid primary key default gen_random_uuid(),
  email_normalized    text not null unique,
  integration         text not null,
  provider            text not null,
  monthly_call_bucket text not null,
  use_case             text not null,
  status               text not null default 'applied',
  contact_consent_at   timestamptz not null default now(),
  user_id              uuid unique references public.users(id) on delete cascade,
  retention_due_at     timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint beta_applications_email_shape check (
    email_normalized = lower(btrim(email_normalized)) and
    char_length(email_normalized) between 3 and 320 and
    position('@' in email_normalized) > 1
  ),
  constraint beta_applications_integration check (
    integration in ('hermes', 'openhands', 'open-webui', 'sdk', 'other')
  ),
  constraint beta_applications_provider check (
    provider in ('openai', 'anthropic', 'groq', 'mistral', 'together', 'deepseek', 'undecided')
  ),
  constraint beta_applications_monthly_calls check (
    monthly_call_bucket in ('under-1000', '1000-5000', '5000-10000', 'over-10000', 'unknown')
  ),
  constraint beta_applications_use_case_length check (
    char_length(use_case) between 20 and 1200
  ),
  constraint beta_applications_status check (
    status in ('applied', 'invited', 'accepted', 'declined', 'withdrawn')
  ),
  constraint beta_applications_retention_state check (
    (status in ('declined', 'withdrawn') and retention_due_at is not null) or
    (status not in ('declined', 'withdrawn') and retention_due_at is null)
  )
);

create index if not exists beta_applications_status_created_idx
  on public.beta_applications (status, created_at desc);

create table if not exists public.beta_invites (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.beta_applications(id) on delete cascade,
  token_hash     text not null unique,
  expires_at     timestamptz not null,
  sent_at        timestamptz,
  claimed_at     timestamptz,
  authorized_auth_user_id uuid unique,
  redeemed_at    timestamptz,
  revoked_at     timestamptz,
  user_id        uuid references public.users(id) on delete cascade,
  created_at     timestamptz not null default now(),
  constraint beta_invites_token_hash_shape check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint beta_invites_expiry_after_creation check (expires_at > created_at),
  constraint beta_invites_redeemed_after_claim check (redeemed_at is null or claimed_at is not null),
  constraint beta_invites_authorized_after_claim check (
    authorized_auth_user_id is null or claimed_at is not null
  )
);

create index if not exists beta_invites_application_created_idx
  on public.beta_invites (application_id, created_at desc);
create index if not exists beta_invites_expiry_idx
  on public.beta_invites (expires_at);

create table if not exists public.beta_feedback (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null unique references public.users(id) on delete cascade,
  application_id     uuid not null references public.beta_applications(id) on delete cascade,
  setup_rating       smallint not null check (setup_rating between 1 and 5),
  feedback           text not null check (char_length(feedback) between 10 and 2000),
  contact_permitted  boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table if not exists public.beta_operator_events (
  id             uuid primary key default gen_random_uuid(),
  actor_user_id  uuid not null references public.users(id) on delete cascade,
  application_id uuid references public.beta_applications(id) on delete cascade,
  invite_id      uuid references public.beta_invites(id) on delete cascade,
  action         text not null,
  created_at     timestamptz not null default now(),
  constraint beta_operator_events_action check (
    action in (
      'application.declined',
      'application.withdrawn',
      'invite.sent',
      'invite.send_failed',
      'nudge.pending',
      'nudge.sent',
      'nudge.send_failed',
      'feedback_request.pending',
      'feedback_request.sent',
      'feedback_request.send_failed'
    )
  )
);

create index if not exists beta_operator_events_application_created_idx
  on public.beta_operator_events (application_id, created_at desc);
create unique index if not exists beta_operator_events_one_nudge_idx
  on public.beta_operator_events (application_id)
  where action in ('nudge.pending', 'nudge.sent');
create unique index if not exists beta_operator_events_one_feedback_request_idx
  on public.beta_operator_events (application_id)
  where action in ('feedback_request.pending', 'feedback_request.sent');

alter table public.beta_applications enable row level security;
alter table public.beta_invites enable row level security;
alter table public.beta_feedback enable row level security;
alter table public.beta_operator_events enable row level security;

revoke all on public.beta_applications from public, anon, authenticated;
revoke all on public.beta_invites from public, anon, authenticated;
revoke all on public.beta_operator_events from public, anon, authenticated;
grant select, insert, update, delete on public.beta_applications to service_role;
grant select, insert, update, delete on public.beta_invites to service_role;
grant select, insert, update, delete on public.beta_operator_events to service_role;

revoke all on public.beta_feedback from public, anon;
revoke all on public.beta_feedback from authenticated;
grant select on public.beta_feedback to authenticated;
grant select, insert, update, delete on public.beta_feedback to service_role;

drop policy if exists beta_feedback_select_own on public.beta_feedback;
create policy beta_feedback_select_own on public.beta_feedback
  for select to authenticated
  using (user_id = (select auth.uid()));

-- Atomically consume a one-time invitation before Supabase signup. A failed
-- signup deliberately strands the token: an operator reissues it instead of a
-- public endpoint making a consumed credential reusable.
create or replace function public.claim_beta_invite(
  p_token_hash text,
  p_email text
)
returns table (invite_id uuid, application_id uuid)
language sql
security definer
set search_path = ''
as $$
  update public.beta_invites i
     set claimed_at = now()
    from public.beta_applications a
   where i.application_id = a.id
     and i.token_hash = p_token_hash
     and a.email_normalized = lower(btrim(p_email))
     and a.status = 'invited'
     and i.sent_at is not null
     and i.claimed_at is null
     and i.authorized_auth_user_id is null
     and i.redeemed_at is null
     and i.revoked_at is null
     and i.expires_at > now()
  returning i.id, i.application_id;
$$;

revoke all on function public.claim_beta_invite(text, text) from public, anon, authenticated;
grant execute on function public.claim_beta_invite(text, text) to service_role;

-- Supabase Auth's Before User Created hook is the admission boundary that a
-- direct call to /auth/v1/signup cannot bypass. The browser never receives the
-- invite UUID: the server adds it to the outbound Auth request after atomically
-- claiming the raw-token hash. Configure this function as the project's
-- `before-user-created` Postgres hook before enabling database invitations.
create or replace function public.hook_authorize_beta_signup(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_user_id uuid;
  v_invite_id uuid;
  v_application_id uuid;
begin
  begin
    v_email := lower(btrim(event->'user'->>'email'));
    v_user_id := (event->'user'->>'id')::uuid;
    v_invite_id := (event->'user'->'user_metadata'->>'passcontrol_beta_invite_id')::uuid;
  exception when others then
    return jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 403,
        'message', 'A valid PassControl invitation is required.'
      )
    );
  end;

  if v_email is null or v_email = '' or v_user_id is null or v_invite_id is null then
    return jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 403,
        'message', 'A valid PassControl invitation is required.'
      )
    );
  end if;

  select i.application_id
    into v_application_id
    from public.beta_invites i
    join public.beta_applications a on a.id = i.application_id
   where i.id = v_invite_id
     and a.email_normalized = v_email
     and a.status = 'invited'
     and a.user_id is null
     and i.sent_at is not null
     and i.claimed_at is not null
     and i.authorized_auth_user_id is null
     and i.redeemed_at is null
     and i.revoked_at is null
     and i.expires_at > now()
   for update of i, a;

  if v_application_id is null then
    return jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 403,
        'message', 'A valid PassControl invitation is required.'
      )
    );
  end if;

  update public.beta_invites
     set authorized_auth_user_id = v_user_id
   where id = v_invite_id;

  return '{}'::jsonb;
end;
$$;

revoke all on function public.hook_authorize_beta_signup(jsonb)
  from public, anon, authenticated;
grant usage on schema public to supabase_auth_admin;
grant execute on function public.hook_authorize_beta_signup(jsonb)
  to supabase_auth_admin;

-- Serialize reissue against redemption and other operator actions. A prepared
-- invitation is inert (`sent_at is null`) until its email has been accepted by
-- the provider and activation records actor attribution in the same transaction.
create or replace function public.prepare_beta_invite(
  p_application_id uuid,
  p_token_hash text,
  p_expires_at timestamptz
)
returns table (invite_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invite_id uuid;
begin
  perform 1
    from public.beta_applications a
   where a.id = p_application_id
     and a.status in ('applied', 'invited')
     and a.user_id is null
   for update;
  if not found then return; end if;

  update public.beta_invites
     set revoked_at = now()
   where application_id = p_application_id
     and claimed_at is null
     and authorized_auth_user_id is null
     and redeemed_at is null
     and revoked_at is null;

  insert into public.beta_invites (application_id, token_hash, expires_at)
  values (p_application_id, p_token_hash, p_expires_at)
  returning id into v_invite_id;

  return query select v_invite_id;
end;
$$;

revoke all on function public.prepare_beta_invite(uuid, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.prepare_beta_invite(uuid, text, timestamptz)
  to service_role;

create or replace function public.activate_beta_invite(
  p_invite_id uuid,
  p_actor_user_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_application_id uuid;
begin
  select i.application_id
    into v_application_id
    from public.beta_invites i
    join public.beta_applications a on a.id = i.application_id
   where i.id = p_invite_id
     and i.sent_at is null
     and i.claimed_at is null
     and i.authorized_auth_user_id is null
     and i.redeemed_at is null
     and i.revoked_at is null
     and i.expires_at > now()
     and a.status in ('applied', 'invited')
     and a.user_id is null
   for update of i, a;
  if v_application_id is null then return false; end if;

  update public.beta_invites set sent_at = now() where id = p_invite_id;
  update public.beta_applications
     set status = 'invited', retention_due_at = null, updated_at = now()
   where id = v_application_id;
  insert into public.beta_operator_events (
    actor_user_id, application_id, invite_id, action
  ) values (
    p_actor_user_id, v_application_id, p_invite_id, 'invite.sent'
  );
  return true;
end;
$$;

revoke all on function public.activate_beta_invite(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.activate_beta_invite(uuid, uuid)
  to service_role;

create or replace function public.fail_beta_invite(
  p_invite_id uuid,
  p_actor_user_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_application_id uuid;
begin
  select i.application_id
    into v_application_id
    from public.beta_invites i
   where i.id = p_invite_id
     and i.sent_at is null
     and i.claimed_at is null
     and i.authorized_auth_user_id is null
     and i.redeemed_at is null
     and i.revoked_at is null
   for update;
  if v_application_id is null then return false; end if;

  update public.beta_invites set revoked_at = now() where id = p_invite_id;
  insert into public.beta_operator_events (
    actor_user_id, application_id, invite_id, action
  ) values (
    p_actor_user_id, v_application_id, p_invite_id, 'invite.send_failed'
  );
  return true;
end;
$$;

revoke all on function public.fail_beta_invite(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.fail_beta_invite(uuid, uuid)
  to service_role;

create or replace function public.decline_beta_application(
  p_application_id uuid,
  p_actor_user_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1
    from public.beta_applications a
   where a.id = p_application_id
     and a.status in ('applied', 'invited')
     and a.user_id is null
     and not exists (
       select 1 from public.beta_invites i
        where i.application_id = a.id
          and i.authorized_auth_user_id is not null
     )
   for update;
  if not found then return false; end if;

  update public.beta_invites
     set revoked_at = now()
   where application_id = p_application_id
     and claimed_at is null
     and authorized_auth_user_id is null
     and redeemed_at is null
     and revoked_at is null;
  update public.beta_applications
     set status = 'declined',
         retention_due_at = now() + interval '30 days',
         updated_at = now()
   where id = p_application_id;
  insert into public.beta_operator_events (
    actor_user_id, application_id, action
  ) values (
    p_actor_user_id, p_application_id, 'application.declined'
  );
  return true;
end;
$$;

revoke all on function public.decline_beta_application(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.decline_beta_application(uuid, uuid)
  to service_role;

-- Record an applicant's withdrawal request without fabricating an account.
-- This mirrors decline but preserves the distinct legal/operational reason.
create or replace function public.withdraw_beta_application(
  p_application_id uuid,
  p_actor_user_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1
    from public.beta_applications a
   where a.id = p_application_id
     and a.status in ('applied', 'invited')
     and a.user_id is null
     and not exists (
       select 1 from public.beta_invites i
        where i.application_id = a.id
          and i.authorized_auth_user_id is not null
     )
   for update;
  if not found then return false; end if;

  update public.beta_invites
     set revoked_at = now()
   where application_id = p_application_id
     and claimed_at is null
     and authorized_auth_user_id is null
     and redeemed_at is null
     and revoked_at is null;
  update public.beta_applications
     set status = 'withdrawn',
         retention_due_at = now() + interval '30 days',
         updated_at = now()
   where id = p_application_id;
  insert into public.beta_operator_events (
    actor_user_id, application_id, action
  ) values (
    p_actor_user_id, p_application_id, 'application.withdrawn'
  );
  return true;
end;
$$;

revoke all on function public.withdraw_beta_application(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.withdraw_beta_application(uuid, uuid)
  to service_role;

-- Complete the invitation only for the Auth user whose server-owned email
-- matches the application. This also creates the public profile so every beta
-- record can be removed through the existing account-deletion cascade.
create or replace function public.redeem_beta_invite(
  p_invite_id uuid,
  p_user_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_application_id uuid;
begin
  select lower(btrim(u.email)), i.application_id
    into v_email, v_application_id
    from auth.users u
    join public.beta_invites i on i.id = p_invite_id
    join public.beta_applications a on a.id = i.application_id
   where u.id = p_user_id
     and a.email_normalized = lower(btrim(u.email))
     and a.status = 'invited'
     and i.claimed_at is not null
     and i.authorized_auth_user_id = p_user_id
     and i.redeemed_at is null
     and i.revoked_at is null
     and i.expires_at > now()
   for update of i, a;

  if v_email is null or v_application_id is null then
    return false;
  end if;

  insert into public.users (id, email)
  values (p_user_id, v_email)
  on conflict (id) do update set email = excluded.email;

  update public.beta_invites
     set redeemed_at = now(), user_id = p_user_id
   where id = p_invite_id;

  update public.beta_applications
     set status = 'accepted',
         user_id = p_user_id,
         retention_due_at = null,
         updated_at = now()
   where id = v_application_id;

  return true;
end;
$$;

revoke all on function public.redeem_beta_invite(uuid, uuid) from public, anon, authenticated;
grant execute on function public.redeem_beta_invite(uuid, uuid) to service_role;

-- Daily privacy retention. This never removes active applications or live
-- accounts. Account-linked rows are erased by the public.users cascade.
create or replace function public.purge_beta_launch_data()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_feedback integer := 0;
  v_invites integer := 0;
  v_applications integer := 0;
begin
  delete from public.beta_feedback
   where updated_at < now() - interval '180 days';
  get diagnostics v_feedback = row_count;

  delete from public.beta_invites
   where coalesce(redeemed_at, revoked_at, expires_at) < now() - interval '30 days';
  get diagnostics v_invites = row_count;

  delete from public.beta_applications
   where user_id is null
     and (
       (status in ('declined', 'withdrawn') and retention_due_at <= now()) or
       created_at < now() - interval '180 days'
     );
  get diagnostics v_applications = row_count;

  return jsonb_build_object(
    'feedback', v_feedback,
    'invites', v_invites,
    'applications', v_applications
  );
end;
$$;

revoke all on function public.purge_beta_launch_data() from public, anon, authenticated;
grant execute on function public.purge_beta_launch_data() to service_role;

comment on table public.beta_applications is
  'Minimum-data Cloud beta applications; server/operator access only.';
comment on table public.beta_invites is
  'Hashed, one-time, email-bound Cloud invitations. Raw tokens are never stored.';
comment on table public.beta_feedback is
  'Owner-readable feedback; writes are server-only after a durable successful-call check.';
comment on function public.claim_beta_invite(text, text) is
  'Service-only atomic one-time invitation claim performed immediately before Auth signup.';
