-- ============================================================================
-- PassControl — provider-key mutation moves behind the server, like every other
-- credential operation.
--
-- ── What was wrong ──────────────────────────────────────────────────────────
--
-- 0028 and 0029 closed the two ways an aal1 session could reach credential
-- authority: minting rows directly, and deleting the second factor so the gate
-- had nothing left to enforce. This closes the last one in the same class.
--
-- `store_provider_key`, `rotate_provider_key`, `set_active_provider_key` and
-- `delete_provider_key` all held `execute` for `authenticated`. Every one of them
-- is careful in the way that matters for tenancy — the actor comes from
-- `auth.uid()`, never from an argument, and each write is constrained with
-- `and user_id = v_uid` — so none of them ever crossed a tenant boundary, and
-- that is exactly why this is the lowest-severity of the three findings.
--
-- What they could not do is notice assurance. The dashboard gates all four on
-- `requireCredentialMfa`, but a Server Action is addressable over HTTP by its id
-- and PostgREST exposes `/rest/v1/rpc/<name>` to any logged-in caller, so an
-- attacker holding an aal1 session for an MFA-enrolled account could call them
-- directly and:
--
--   store  — add a provider key of their own to the tenant,
--   rotate — overwrite the secret behind a credential they cannot read,
--   set_active — redirect every subsequent gateway call, and the spend behind
--                it, onto a different upstream account,
--   delete — destroy a credential row and its Vault secret outright.
--
-- No key is stolen and no other tenant is reachable, which is why this was not
-- bundled with 0028. It is still sabotage and billing redirection performed
-- without the step-up the product demands for exactly these operations.
--
-- ── The shape of the fix ────────────────────────────────────────────────────
--
-- `auth.uid()` is the reason these had to be callable by `authenticated` at all:
-- a service-role call carries no user JWT, so `auth.uid()` is null and the old
-- bodies would raise 'not authenticated'. Re-granting them to service_role would
-- therefore have produced four functions that are reachable and permanently
-- broken. They are replaced instead by *_for_user variants that take the tenant
-- as an explicit first argument, and the originals are DROPPED rather than left
-- revoked — a superseded function that raises 'not authenticated' for its only
-- remaining caller is a trap for whoever finds it next.
--
-- The explicit argument is the part to be careful about, and it is the same
-- discipline the service-role client already runs under everywhere else in this
-- codebase: RLS is bypassed, so the tenant boundary moves out of the database
-- and into the caller. `p_user_id` MUST come from `requireUser()`/`getUser()` —
-- server-verified, in the same request — and never from client input. Every
-- body below still re-derives the credential with `and user_id = p_user_id`, so
-- a wrong id fails closed with 'credential not found' rather than mutating
-- someone else's row. `app/dashboard/actions.ts` additionally pre-checks
-- ownership through the RLS-scoped read (`ownedCredentialProvider`) before it
-- calls, so a cross-tenant id is refused at the action boundary too.
--
-- ── Deployment ordering (this one bites) ────────────────────────────────────
--
-- This migration is NOT backward compatible with the currently deployed code,
-- in either direction: apply it before deploying and the old code calls RPCs
-- that no longer exist; deploy before applying and the new code calls RPCs that
-- do not exist yet. Apply the migration and deploy together, migration first.
-- The gap affects provider-key MANAGEMENT only — adding, rotating, switching,
-- deleting from the Control Tower. The gateway itself is untouched: it injects
-- keys through `get_provider_key`, which has been service-role-only since 0001
-- and is not modified here. Agents keep working throughout.
-- ============================================================================

-- ── Store ───────────────────────────────────────────────────────────────────
create or replace function public.store_provider_key_for_user(
  p_user_id   uuid,
  p_provider  text,
  p_label     text,
  p_plaintext text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
  v_cred_id   uuid;
  v_first     boolean;
begin
  -- Defensive: a null tenant here would mean trusted server code lost track of
  -- who it was acting for, which must fail rather than write an orphan row.
  if p_user_id is null then
    raise exception 'user required';
  end if;

  -- Ensure a profile row exists for the FK (unchanged from the original).
  insert into public.users (id, email)
  values (p_user_id, (select email from auth.users where id = p_user_id))
  on conflict (id) do nothing;

  -- The first credential for a provider is the active one; 0027 explains why
  -- this is computed before the insert and why the partial unique index backs it.
  v_first := not exists (
    select 1
      from public.provider_credentials
     where user_id = p_user_id
       and provider = p_provider
       and is_active
  );

  v_secret_id := vault.create_secret(
    p_plaintext,
    'provider_key:' || p_user_id::text || ':' || p_provider || ':' || coalesce(p_label, 'default'),
    'PassControl provider key'
  );

  insert into public.provider_credentials (user_id, provider, label, vault_secret_id, is_active)
  values (p_user_id, p_provider, p_label, v_secret_id, v_first)
  returning id into v_cred_id;

  return v_cred_id;
end;
$$;

revoke all on function public.store_provider_key_for_user(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.store_provider_key_for_user(uuid, text, text, text)
  to service_role;

-- ── Rotate ──────────────────────────────────────────────────────────────────
create or replace function public.rotate_provider_key_for_user(
  p_user_id       uuid,
  p_credential_id uuid,
  p_plaintext     text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
begin
  if p_user_id is null then
    raise exception 'user required';
  end if;

  -- The tenant filter is what replaces RLS here. A credential belonging to
  -- someone else is indistinguishable from one that does not exist.
  select vault_secret_id into v_secret_id
    from public.provider_credentials
   where id = p_credential_id and user_id = p_user_id;

  if v_secret_id is null then
    raise exception 'credential not found';
  end if;

  perform vault.update_secret(v_secret_id, p_plaintext);
end;
$$;

revoke all on function public.rotate_provider_key_for_user(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.rotate_provider_key_for_user(uuid, uuid, text)
  to service_role;

-- ── Switch which credential the gateway injects ─────────────────────────────
create or replace function public.set_active_provider_key_for_user(
  p_user_id       uuid,
  p_credential_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_provider text;
begin
  if p_user_id is null then
    raise exception 'user required';
  end if;

  select provider into v_provider
    from public.provider_credentials
   where id = p_credential_id and user_id = p_user_id;

  if v_provider is null then
    raise exception 'credential not found';
  end if;

  -- Clear the sibling BEFORE setting this one. 0027's partial unique index
  -- permits exactly one active row per (user, provider), so the reverse order
  -- trips the constraint on the tenant's own data.
  update public.provider_credentials
     set is_active = false
   where user_id = p_user_id
     and provider = v_provider
     and is_active
     and id <> p_credential_id;

  update public.provider_credentials
     set is_active = true
   where id = p_credential_id and user_id = p_user_id;
end;
$$;

revoke all on function public.set_active_provider_key_for_user(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.set_active_provider_key_for_user(uuid, uuid)
  to service_role;

-- ── Delete ──────────────────────────────────────────────────────────────────
create or replace function public.delete_provider_key_for_user(
  p_user_id       uuid,
  p_credential_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret uuid;
  v_active boolean;
begin
  if p_user_id is null then
    raise exception 'user required';
  end if;

  select vault_secret_id, is_active
    into v_secret, v_active
    from public.provider_credentials
   where id = p_credential_id and user_id = p_user_id;

  if v_secret is null then
    raise exception 'credential not found';
  end if;

  -- Refused, not silently reassigned. Promoting another row here would change
  -- which upstream account gets billed as a side effect of a delete (0027).
  if v_active then
    raise exception 'active_credential';
  end if;

  delete from public.provider_credentials
   where id = p_credential_id and user_id = p_user_id;

  -- The row holds only a reference; the encrypted secret outlives it otherwise.
  delete from vault.secrets where id = v_secret;
end;
$$;

revoke all on function public.delete_provider_key_for_user(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.delete_provider_key_for_user(uuid, uuid)
  to service_role;

-- ── Retire the auth.uid()-derived originals ─────────────────────────────────
-- Dropped, not revoked: see the header. Nothing calls them after this migration.
drop function if exists public.store_provider_key(text, text, text);
drop function if exists public.rotate_provider_key(uuid, text);
drop function if exists public.set_active_provider_key(uuid);
drop function if exists public.delete_provider_key(uuid);

comment on function public.store_provider_key_for_user(uuid, text, text, text) is
  'Store a provider key in Vault for a tenant. Service-role only; p_user_id must '
  'come from server-verified session state, never from client input. See 0030.';
comment on function public.rotate_provider_key_for_user(uuid, uuid, text) is
  'Replace the Vault secret behind an owned credential. Service-role only; '
  'p_user_id must come from server-verified session state. See 0030.';
comment on function public.set_active_provider_key_for_user(uuid, uuid) is
  'Choose which stored credential the gateway injects. Service-role only; '
  'p_user_id must come from server-verified session state. See 0030.';
comment on function public.delete_provider_key_for_user(uuid, uuid) is
  'Remove a stored credential and its Vault secret. Refuses the active one. '
  'Service-role only; p_user_id must come from server-verified session state. See 0030.';
