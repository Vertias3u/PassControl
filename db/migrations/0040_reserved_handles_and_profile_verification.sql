-- PassControl — protected public identities and manually issued profile checks.
--
-- Two trust problems share one rule: neither decision belongs to the account.
-- A user cannot decide that `openai` is theirs, and cannot decide that their
-- own profile deserves a blue check. Both registries are therefore server-only
-- and RLS-protected, with no authenticated policy and no dashboard issuance UI.
--
-- Reserved handles may be assigned to one existing account by an operator.
-- This is how an official Vertias identity can hold a protected name without
-- turning the reservation off for everyone. A deleted account releases the
-- assignment but NOT the reservation, so the name never falls open by cascade.

create table if not exists public.reserved_usernames (
  username         text primary key,
  assigned_user_id uuid references public.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  constraint reserved_usernames_shape check (
    username ~ '^[a-z0-9][a-z0-9_]{1,28}[a-z0-9]$'
  )
);

comment on table public.reserved_usernames is
  'Public handles unavailable by default. assigned_user_id is the sole manual '
  'exception for an official account; browser roles cannot read or write it.';

alter table public.reserved_usernames enable row level security;
revoke all on public.reserved_usernames from public, authenticated, anon;
grant select, insert, update, delete on public.reserved_usernames to service_role;

-- Keep this seed in parity with lib/profile/handle.ts. The test scans every
-- migration, so later additions go in a NEW migration without editing this
-- applied file and still have to reach both layers.
insert into public.reserved_usernames (username) values
  ('actions'), ('api'), ('auth'), ('avatar'), ('avatars'), ('beta'),
  ('dashboard'), ('legal'), ('login'), ('logout'), ('signin'), ('signout'),
  ('signup'), ('settings'), ('account'), ('billing'), ('verify'), ('receipt'),
  ('receipts'), ('user'), ('users'), ('static'), ('assets'), ('public'),
  ('well_known'), ('robots'), ('sitemap'), ('favicon'),
  ('passcontrol'), ('passport'), ('passports'), ('vertias'), ('admin'),
  ('administrator'), ('root'), ('system'), ('official'), ('staff'), ('team'),
  ('support'), ('security'), ('abuse'), ('help'), ('status'), ('info'),
  ('contact'), ('mail'), ('postmaster'), ('webmaster'), ('www'), ('docs'),
  ('blog'), ('about'), ('pricing'), ('terms'), ('privacy'), ('null'),
  ('undefined'), ('anthropic'), ('claude'), ('openai'), ('chatgpt'), ('google'),
  ('gemini'), ('microsoft'), ('copilot'), ('github'), ('gitlab'), ('apple'),
  ('meta'), ('facebook'), ('instagram'), ('whatsapp'), ('twitter'), ('xai'),
  ('grok'), ('amazon'), ('aws'), ('azure'), ('nvidia'), ('huggingface'),
  ('perplexity'), ('mistral'), ('deepseek'), ('groq'), ('together'),
  ('walmart'), ('tesla'), ('spacex'), ('paypal'), ('stripe'), ('visa'),
  ('mastercard'), ('coinbase'), ('binance'), ('revolut'), ('government'),
  ('police'), ('interpol'), ('verified'), ('moderator'), ('moderation')
on conflict (username) do nothing;

-- Database backstop for every write path, including a future service action
-- that forgets lib/profile/handle.ts. The assigned account is the one explicit
-- exception and assignment itself remains a server-only operation.
create or replace function public.reject_reserved_username()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.username is not null
     and (tg_op = 'INSERT' or new.username is distinct from old.username)
     and exists (
       select 1
         from public.reserved_usernames r
        where r.username = new.username
          and r.assigned_user_id is distinct from new.id
     ) then
    raise exception 'handle is reserved' using errcode = 'unique_violation';
  end if;
  return new;
end
$$;

revoke all on function public.reject_reserved_username() from public, anon, authenticated;

drop trigger if exists users_reject_reserved_username on public.users;
create trigger users_reject_reserved_username
  before insert or update of username on public.users
  for each row execute function public.reject_reserved_username();

-- Re-issue 0034's atomic function with one additional outcome. The no-op and
-- permanent-handle checks stay first: re-saving an already-held reserved handle
-- must work, and a locked handle is not movable regardless of the candidate.
create or replace function public.change_handle(p_user_id uuid, p_new_username text)
returns table (status text, handle text, locked_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prev   text;
  v_locked timestamptz;
begin
  select u.username, u.handle_locked_at
    into v_prev, v_locked
    from public.users u
   where u.id = p_user_id
     for update;

  if not found then
    return query select 'no_profile'::text, null::text, null::timestamptz;
    return;
  end if;

  if v_prev is not distinct from p_new_username then
    return query select 'ok'::text, v_prev, v_locked;
    return;
  end if;

  if v_locked is not null then
    return query select 'locked'::text, v_prev, v_locked;
    return;
  end if;

  if exists (
    select 1
      from public.reserved_usernames r
     where r.username = p_new_username
       and r.assigned_user_id is distinct from p_user_id
  ) then
    return query select 'reserved'::text, v_prev, v_locked;
    return;
  end if;

  begin
    if v_prev is not null then
      insert into public.retired_usernames (username)
      values (v_prev)
      on conflict (username) do nothing;
    end if;

    update public.users
       set username = p_new_username,
           updated_at = now()
     where id = p_user_id;
  exception when unique_violation then
    return query select 'taken'::text, v_prev, v_locked;
    return;
  end;

  return query select 'ok'::text, p_new_username, v_locked;
end
$$;

revoke all on function public.change_handle(uuid, text) from public, anon, authenticated;
grant execute on function public.change_handle(uuid, text) to service_role;

-- A manual, current platform attestation. It is deliberately not a column on
-- public.users: keeping it in a table with no browser privileges makes the
-- write boundary structural, not dependent on every profile patch allowlist.
create table if not exists public.profile_verifications (
  user_id     uuid primary key references public.users(id) on delete cascade,
  verified_at timestamptz not null default now(),
  issuer      text not null default 'PassControl',
  note        text,
  constraint profile_verifications_issuer_length check (char_length(issuer) between 1 and 80),
  constraint profile_verifications_note_length check (note is null or char_length(note) <= 500)
);

comment on table public.profile_verifications is
  'Current manual profile checks. Server-only; presence produces the public '
  'social check and deletion removes it immediately.';

alter table public.profile_verifications enable row level security;
revoke all on public.profile_verifications from public, authenticated, anon;
grant select, insert, update, delete on public.profile_verifications to service_role;

-- Re-issue the public projection with one boolean, not the registry metadata.
-- A stranger needs to know whether the current check exists, not which internal
-- operator issued it or why.
--
-- DROP is required: PostgreSQL cannot CREATE OR REPLACE a table-returning
-- function when its OUT row gains a column. This migration runs in one
-- transaction, so there is no window where the public projection is absent.
drop function if exists public.public_operator_profile(text);

create or replace function public.public_operator_profile(p_handle text)
returns table (
  username              text,
  display_name          text,
  bio                   text,
  website_url           text,
  company               text,
  avatar_key            text,
  member_since          timestamptz,
  owner_subject         text,
  owner_tier            text,
  owner_verified_at     timestamptz,
  is_verified           boolean,
  published_agent_count integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    u.username,
    u.display_name,
    u.bio,
    u.website_url,
    u.company,
    case when u.avatar_path is not null then u.avatar_key end,
    u.created_at,
    o.subject,
    o.tier,
    o.verified_at,
    (v.user_id is not null),
    (select count(*)::integer
       from public.agents a
      where a.user_id = u.id and a.published)
  from public.users u
  left join public.agent_owners o
    on o.user_id = u.id and o.published
  left join public.profile_verifications v
    on v.user_id = u.id
  where u.username = lower(p_handle)
    and u.profile_public
  limit 1
$$;

revoke all on function public.public_operator_profile(text) from public, anon, authenticated;
grant execute on function public.public_operator_profile(text) to service_role;
