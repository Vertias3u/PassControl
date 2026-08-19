-- ============================================================================
-- PassControl — a tenant's provider credential is CHOSEN, not accidental.
--
-- ── The defect ──────────────────────────────────────────────────────────────
--
-- 0001's get_provider_key ends:
--
--     order by pc.created_at asc
--     limit 1;
--
-- The OLDEST credential for a (user, provider) pair wins. provider_credentials
-- is `unique (user_id, provider, label)` and store_provider_key only ever
-- INSERTs, so a second key for the same provider under a DIFFERENT label creates
-- a row the gateway can never reach.
--
-- The label is what makes it reachable, and it is worth being exact about that
-- rather than blaming NULLs. The table constraint does treat NULL labels as
-- distinct, but a duplicate cannot actually arrive that way: the Vault secret
-- name is `provider_key:<uid>:<provider>:<coalesce(label,'default')>` and
-- `vault.secrets` carries `unique (name) where name is not null`, so two
-- unlabelled credentials collide there. A repeated label collides on the table
-- constraint. Only genuinely different labels get through — which is the normal,
-- supported thing to do, and exactly what an operator does when replacing a key.
--
-- Found in production on 2026-08-17. The owner's Anthropic key was issued with a
-- 24-hour expiry. It expired; every upstream call started returning 401 (visible
-- on the receipts as `res.http`, once something finally surfaced it). A
-- replacement key was stored through the dashboard, and the gateway went on
-- injecting the expired one. This is not a cache window that clears in 60
-- seconds — it is permanent, and there was no UI to rotate, switch or delete, so
-- the only exit was SQL against the live database.
--
-- ── What this migration deliberately does NOT do ────────────────────────────
--
-- It does not switch anyone to their newest key. `is_active` is backfilled onto
-- the row that is being injected TODAY — `distinct on (user_id, provider) ...
-- order by created_at asc`, the exact pick 0001 makes — so applying this changes
-- no tenant's traffic and bills no unexpected upstream account. `pfrpf…` is live
-- and has tenants whose credential sets nobody has audited; a newest-wins
-- backfill would move which account gets charged for all of them silently.
-- Switching is an explicit operator action, taken afterwards, through
-- set_active_provider_key and the settings UI.
--
-- The same reasoning sets the tiebreak. When nothing is marked active,
-- get_provider_key falls back to `created_at asc` — the legacy pick — rather
-- than to newest or to an unordered `limit 1`. An unordered limit would make
-- which key gets billed depend on the query plan.
--
-- ── Deleting ────────────────────────────────────────────────────────────────
--
-- delete_provider_key REFUSES to remove the active credential rather than
-- promoting a replacement. Silent promotion would let a delete change which
-- upstream account gets billed with no explicit decision recorded anywhere.
-- Switch first, then delete; both are audited by the caller.
--
-- ── What these RPCs are, and are NOT ────────────────────────────────────────
--
-- 0001's policy on this table is `for all to authenticated using (user_id =
-- auth.uid())`, so a tenant can already INSERT, UPDATE and DELETE its own
-- provider_credentials rows straight through PostgREST. These functions are the
-- SUPPORTED path — audited, MFA-gated at the Server Action, and cache-purging —
-- not a boundary that stops a tenant from touching its own rows. The refusal
-- above is a guard rail for the dashboard, not an access control.
--
-- What IS enforced structurally, and survives a client writing directly:
--   * the partial unique index — two active credentials for one (user, provider)
--     are impossible however the write arrives;
--   * get_provider_key staying service_role-only, so no client path decrypts;
--   * the ownership re-derivation inside every function, which never trusts a
--     caller-supplied user id.
-- Deliberately not tightened to per-command policies here: narrowing the write
-- surface on a live table is a separate change with its own blast radius, and
-- overstating this migration's reach would be worse than the gap itself.
-- ============================================================================

-- ── The flag ────────────────────────────────────────────────────────────────
alter table public.provider_credentials
  add column if not exists is_active boolean not null default false;

comment on column public.provider_credentials.is_active is
  'The credential get_provider_key injects for this (user, provider). At most one '
  'per pair, enforced by a partial unique index. Chosen via set_active_provider_key.';

-- ── Backfill: preserve today's pick exactly ────────────────────────────────
-- distinct on + the same ordering 0001 uses, so every tenant keeps the key the
-- gateway is already injecting. Idempotent: re-running marks the same rows.
with current_pick as (
  select distinct on (user_id, provider) id
    from public.provider_credentials
   order by user_id, provider, created_at asc
)
update public.provider_credentials pc
   set is_active = true
  from current_pick
 where pc.id = current_pick.id
   and pc.is_active is distinct from true;

-- ── One active per provider, enforced by the database ───────────────────────
-- Partial, so any number of inactive credentials may sit beside it. This is also
-- what makes set_active_provider_key's clear-then-set ordering mandatory rather
-- than stylistic, and what stops two concurrent first-key inserts from both
-- activating.
create unique index if not exists provider_credentials_one_active_idx
  on public.provider_credentials (user_id, provider)
  where is_active;

-- ── The decrypt path, now reading the choice ────────────────────────────────
-- Unchanged in every other respect: still SECURITY DEFINER, still pinned
-- search_path, still service_role-only, and still re-deriving ownership from the
-- agent->user->credential join rather than trusting a caller-supplied user.
create or replace function public.get_provider_key(p_agent_id uuid, p_provider text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text;
begin
  select ds.decrypted_secret
    into v_key
  from public.agents a
  join public.provider_credentials pc
    on pc.user_id = a.user_id and pc.provider = p_provider
  join vault.decrypted_secrets ds
    on ds.id = pc.vault_secret_id
  where a.id = p_agent_id
    and a.status = 'active'
  -- The chosen credential, else the legacy oldest-first pick. Never unordered:
  -- which key gets billed must not depend on the plan.
  order by pc.is_active desc, pc.created_at asc
  limit 1;

  return v_key;
end;
$$;

revoke all on function public.get_provider_key(uuid, text) from public, anon, authenticated;
grant execute on function public.get_provider_key(uuid, text) to service_role;

-- ── Storing: the first credential for a provider is the active one ──────────
-- Without this a new tenant inserts is_active=false, nothing is active, and the
-- fallback above is doing work it should never need to do. Computed before the
-- insert; the partial unique index is the backstop if two inserts race.
create or replace function public.store_provider_key(
  p_provider text,
  p_label text,
  p_plaintext text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid       uuid := auth.uid();
  v_secret_id uuid;
  v_cred_id   uuid;
  v_first     boolean;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  -- Ensure a profile row exists for the FK.
  insert into public.users (id, email)
  values (v_uid, (select email from auth.users where id = v_uid))
  on conflict (id) do nothing;

  v_first := not exists (
    select 1
      from public.provider_credentials
     where user_id = v_uid
       and provider = p_provider
       and is_active
  );

  v_secret_id := vault.create_secret(
    p_plaintext,
    'provider_key:' || v_uid::text || ':' || p_provider || ':' || coalesce(p_label, 'default'),
    'PassControl provider key'
  );

  insert into public.provider_credentials (user_id, provider, label, vault_secret_id, is_active)
  values (v_uid, p_provider, p_label, v_secret_id, v_first)
  returning id into v_cred_id;

  return v_cred_id;
end;
$$;

revoke all on function public.store_provider_key(text, text, text) from public, anon;
grant execute on function public.store_provider_key(text, text, text) to authenticated, service_role;

-- ── Switching ───────────────────────────────────────────────────────────────
create or replace function public.set_active_provider_key(p_credential_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := auth.uid();
  v_provider text;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  select provider into v_provider
    from public.provider_credentials
   where id = p_credential_id and user_id = v_uid;

  if v_provider is null then
    raise exception 'credential not found';
  end if;

  -- Clear the sibling BEFORE setting this one. The partial unique index permits
  -- exactly one active row per (user, provider), so the reverse order trips the
  -- constraint on the tenant's own data.
  update public.provider_credentials
     set is_active = false
   where user_id = v_uid
     and provider = v_provider
     and is_active
     and id <> p_credential_id;

  update public.provider_credentials
     set is_active = true
   where id = p_credential_id and user_id = v_uid;
end;
$$;

revoke all on function public.set_active_provider_key(uuid) from public, anon;
grant execute on function public.set_active_provider_key(uuid) to authenticated, service_role;

comment on function public.set_active_provider_key(uuid) is
  'Choose which stored credential the gateway injects for a provider. Owner-derived '
  'from auth.uid(). Takes effect after at most one provider-key cache window.';

-- ── Deleting ────────────────────────────────────────────────────────────────
create or replace function public.delete_provider_key(p_credential_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := auth.uid();
  v_secret uuid;
  v_active boolean;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  select vault_secret_id, is_active
    into v_secret, v_active
    from public.provider_credentials
   where id = p_credential_id and user_id = v_uid;

  if v_secret is null then
    raise exception 'credential not found';
  end if;

  -- Refused, not silently reassigned. Promoting another row here would change
  -- which upstream account gets billed as a side effect of a delete.
  if v_active then
    raise exception 'active_credential';
  end if;

  delete from public.provider_credentials
   where id = p_credential_id and user_id = v_uid;

  -- The row holds only a reference; the encrypted secret outlives it otherwise.
  -- Same point 0024 makes for account erasure.
  delete from vault.secrets where id = v_secret;
end;
$$;

revoke all on function public.delete_provider_key(uuid) from public, anon;
grant execute on function public.delete_provider_key(uuid) to authenticated, service_role;

comment on function public.delete_provider_key(uuid) is
  'Remove a stored provider credential and its Vault secret. Owner-derived from '
  'auth.uid(). Refuses the active credential — switch first, deliberately.';
