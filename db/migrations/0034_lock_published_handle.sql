-- ============================================================================
-- PassControl — a handle stops moving once it has been public.
--
-- 0033 made handles changeable and retired the old one permanently, so an old
-- /@handle link 404s rather than resolving to a different operator. That closes
-- the impersonation vector, and it is still the property that matters.
--
-- This adds a second, narrower rule on top of it, and the interesting part is
-- WHERE the line sits:
--
--     free to change while the profile is private
--     permanent from the moment it is first published
--
-- Not "permanent from first save". Claiming a handle is the very first thing a
-- new operator does, in a form they have not read carefully, and `vertais_ops`
-- for `vertias_ops` is the obvious mistake. Making that unfixable turns a typo
-- into a support ticket serviced by hand with SQL, once per occurrence, for as
-- long as the product exists — and it buys nothing, because until the profile
-- is published NOTHING outside the account can reference the handle. There is
-- no page, no link, no crawler, no receipt.
--
-- Publishing is the moment that changes. From then on the handle is an address
-- other people may have written down, so it stops moving.
--
-- ── The lock is one-way ─────────────────────────────────────────────────────
--
-- Un-publishing does NOT release it. If it did, the rule would reduce to
-- "change it whenever you like, via two extra clicks", and the links that
-- already exist in the world would not care that the profile was briefly
-- private. `handle_locked_at` is set once and never cleared.
--
-- ── What this does NOT change ───────────────────────────────────────────────
--
-- Nothing cryptographic depends on a handle. A receipt carries
-- agent_owners.subject — the domain or name that was actually verified — and
-- never the handle; lib/owner/current.ts is the only thing that writes an owner
-- claim into a signed artifact. So this is about link stability and identity
-- hygiene, not about signatures, and it should not be described as the latter.
-- ============================================================================

alter table public.users
  add column if not exists handle_locked_at timestamptz;

comment on column public.users.handle_locked_at is
  'When this handle became permanent: stamped the first time the profile is '
  'published, never cleared. Null means the profile has never been public and '
  'the handle is still free to change. One-way on purpose — un-publishing must '
  'not release a name other people may already have linked to.';

-- Backstop, in the same shape and for the same reason as
-- reject_retired_username in 0033: the rule is enforced in
-- lib/profile/manage.ts, and enforcing it here too means a mistake has to be
-- made twice. A separate function rather than an edit to that one, because two
-- triggers with one job each stay readable; a single function that refuses
-- changes for two unrelated reasons does not.
--
-- The default errcode (P0001) is deliberate. The application check runs first
-- and produces the wording an operator can act on, so this path should never be
-- the one a human sees; borrowing unique_violation here would make a locked
-- handle indistinguishable from a taken one, which is a different and much less
-- useful message.
create or replace function public.reject_locked_username()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and old.handle_locked_at is not null
     and new.username is distinct from old.username then
    raise exception 'handle is locked: public since %', old.handle_locked_at;
  end if;
  return new;
end
$$;

revoke all on function public.reject_locked_username() from public, anon, authenticated;

drop trigger if exists users_reject_locked_username on public.users;
create trigger users_reject_locked_username
  before update of username on public.users
  for each row execute function public.reject_locked_username();

-- ── Changing a handle atomically ────────────────────────────────────────────
--
-- The application used to do this in two statements — insert the retirement
-- row, then update the username — because the Supabase client has no
-- transaction. The ORDER was chosen to fail closed: retire first, so a failure
-- in between leaves the operator holding a handle that is also marked retired
-- (harmless) rather than releasing a name a stranger could immediately claim
-- (an impersonation vector).
--
-- Fail-closed is the right trade for two statements, but two statements were
-- never actually necessary. A failed change still retired the handle the
-- operator KEPT, which quietly cost them the ability to return to their own
-- name later — and that is not hypothetical: it happened during testing, on a
-- change that was correctly refused.
--
-- So both writes move into one function and therefore one transaction. The
-- retirement is rolled back with the update it belongs to, the ordering
-- argument above stops being load-bearing, and there is no interleaving left to
-- reason about.
--
-- It returns a STATUS rather than raising, because the two interesting outcomes
-- are not errors — "that name is taken" and "your handle is permanent" are
-- things to tell an operator, and mapping them out of SQLSTATEs would mean
-- inventing error codes and then parsing them back.
--
-- `taken` covers a name somebody holds AND a name that was retired, exactly as
-- 0033 intends: the trigger raises unique_violation for the retired case
-- precisely so the two are indistinguishable and there is no oracle for which
-- handles have ever existed.

create or replace function public.change_handle(p_user_id uuid, p_new_username text)
-- The OUT columns are named `handle` / `locked_at` rather than `username` /
-- `handle_locked_at` deliberately: an OUT parameter shadows a column of the
-- same name inside the body, and `on conflict (username)` below then fails to
-- resolve at RUNTIME with "column reference is ambiguous" — a create-time-clean
-- function that raises the first time it is actually called.
returns table (status text, handle text, locked_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prev   text;
  v_locked timestamptz;
begin
  -- Row lock: two concurrent changes for the same operator must not both read
  -- the pre-change handle and both try to retire it.
  select u.username, u.handle_locked_at
    into v_prev, v_locked
    from public.users u
   where u.id = p_user_id
     for update;

  if not found then
    return query select 'no_profile'::text, null::text, null::timestamptz;
    return;
  end if;

  -- A no-op resubmit is not a change. Checked before the lock, or re-saving a
  -- profile would start failing the moment the handle became permanent.
  if v_prev is not distinct from p_new_username then
    return query select 'ok'::text, v_prev, v_locked;
    return;
  end if;

  if v_locked is not null then
    return query select 'locked'::text, v_prev, v_locked;
    return;
  end if;

  -- Both writes in ONE subtransaction. If the update raises — because the name
  -- is held, or because the trigger refuses a retired one — the retirement
  -- insert above it is rolled back with it, and the operator's current handle
  -- is left exactly as it was.
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
