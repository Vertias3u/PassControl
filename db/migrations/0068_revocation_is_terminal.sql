-- Revocation is terminal.
--
-- ── The hole this closes ────────────────────────────────────────────────────
--
-- 0012 granted `authenticated` UPDATE on `api_keys (revoked_at)` and only that
-- column, on the reasoning that "the only thing a dashboard user legitimately
-- updates is revoked_at (revoke = soft delete)". The grant is right. The
-- reasoning was one word short: a timestamp column grant is BIDIRECTIONAL.
--
-- `update api_keys set revoked_at = null where id = <my own revoked key>` is the
-- same statement the grant exists to permit. The row's RLS policy checks
-- ownership and nothing else — no AAL, no direction of travel — and there was no
-- trigger. So a signed-in session that had never cleared MFA could reverse an
-- emergency stop, and the key came back with its original `write` scope.
--
-- Reproduced on the local stack before this migration existed, as `authenticated`
-- at aal1 with the tenant's own claims: `UPDATE 1`, and the row read back
-- unrevoked. `revokeApiKey`'s `.is("revoked_at", null)` predicate did not stop it
-- and never could — that is a guard on one code path, and PostgREST is another.
-- Every other entry point (self-revoke, reconcile's expiry sweep, 0065's operator
-- revoke, the dashboard action) carries the same predicate, and all of them are
-- equally beside the point: the table had no opinion.
--
-- The consequence is the part that matters on an identity product. Minting a
-- write-scoped control key requires MFA. Restoring one did not. An operator who
-- revokes a leaked key, changes their password and believes the incident closed
-- has not retired that key, and nothing tells them so.
--
-- ── What this does ─────────────────────────────────────────────────────────
--
-- Once `revoked_at` is set, it cannot change again. Not to NULL, and not to a
-- different timestamp either — moving a revocation is the same erasure, slower,
-- and it would let a key be quietly backdated out of an audit window.
--
-- The rule is on the VALUE, not on the row: other columns on a revoked row are
-- still writable, so nothing that legitimately touches a dead key breaks. And it
-- applies to every role including service_role, because no writer in this
-- repository un-revokes anything — checked, all five of them — so there is no
-- legitimate caller to exempt, and an exemption is exactly the shape an attacker
-- looks for. The table owner can still `alter table … disable trigger` for a
-- deliberate, visible, superuser-only recovery. That is the escape hatch, and it
-- is not reachable from a browser.
--
-- ── Why a trigger and not a one-way RPC ────────────────────────────────────
--
-- The alternative was to revoke the column grant and expose an owner-scoped
-- SECURITY DEFINER `revoke_api_key` RPC, the direction 0028 took for minting.
-- Rejected here, on purpose: it moves the guarantee into a function that four
-- call sites must remember to use, and leaves the next writer free to reach the
-- table directly. The trigger states the invariant where the data lives, so it
-- covers PostgREST, the server actions, the operator console, and whatever is
-- written next — including a writer that has not been reviewed yet.
--
-- It also keeps the emergency stop exactly as fast and as available as it is
-- today. Revocation must not acquire a new dependency, a new round trip, or an
-- MFA prompt: it is the thing you reach for when something has already gone
-- wrong. This migration adds nothing to the revoke path and everything to the
-- un-revoke path.

create or replace function public.api_keys_revocation_is_terminal()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception
    'revocation is terminal: api_keys.revoked_at cannot be changed once it is set'
    using errcode = '42501';
end;
$$;

comment on function public.api_keys_revocation_is_terminal() is
  'Refuses any change to api_keys.revoked_at once set. See 0068: the 0012 column '
  'grant is bidirectional, so an aal1 browser session could un-revoke its own key.';

drop trigger if exists api_keys_revocation_is_terminal on public.api_keys;

create trigger api_keys_revocation_is_terminal
  before update on public.api_keys
  for each row
  -- Narrow on purpose. Fires only when a revocation that already exists is being
  -- changed, so a first revocation (null -> now) passes untouched, and so does
  -- any update to another column on an already-revoked row.
  when (old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at)
  execute function public.api_keys_revocation_is_terminal();
