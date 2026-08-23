-- ============================================================================
-- PassControl — the recovery-code VERIFIERS follow the writes server-side.
--
-- ── What 0029 got right, and the half it left open ──────────────────────────
--
-- 0029 revoked insert/update/delete on `public.mfa_recovery_codes` from
-- `authenticated` and `anon`, because a client-writable recovery code is a
-- complete MFA bypass: plant a row, redeem it at /login/verify, and the
-- emergency path unenrolls the TOTP factor on the attacker's behalf. That
-- reasoning holds and none of it is reverted here.
--
-- It deliberately kept SELECT, with this justification:
--
--     "SELECT stays: `getMfaStatus` counts the codes still unused to render the
--      Security panel, and a count of one's own remaining codes leaks nothing."
--
-- Both halves of that sentence are true. The conclusion does not follow, and
-- the gap between them is this migration.
--
-- `getMfaStatus` asks for `count`. The GRANT is not "may ask for count" — it is
-- "may SELECT", and PostgREST lets the caller pick the projection. The client
-- is not obliged to send the query the dashboard sends. It can send:
--
--     GET /rest/v1/mfa_recovery_codes?select=code_hash&used_at=is.null
--
-- RLS answers "your own rows", which is exactly what an attacker holding the
-- victim's session has. So the application's read shape was mistaken for the
-- database's capability — the same confusion, one column over, that made the
-- write grant dangerous in the first place.
--
-- ── Why a hash of a recovery code is credential material ────────────────────
--
-- `lib/recoveryCodes.ts` mints 10 characters from a 31-glyph unambiguous
-- alphabet and stores a bare, unsalted, unpeppered SHA-256 of the normalised
-- code. That is log2(31^10) ≈ 49.5 bits per code, and PassControl issues ten at
-- once, so a candidate can be tested against ten targets in one pass (≈46.2
-- bits of multi-target work). No GPU figure is quoted here on purpose: hardware
-- moves and the conclusion does not depend on it. What matters is the shape —
-- a fast deterministic hash over a deliberately human-typeable secret, searched
-- OFFLINE, where PassControl's rate limits, the TOTP attempt counter and every
-- network-side control are simply not in the loop.
--
-- Contrast the control-plane API keys: 32 random bytes. A SHA-256 of 256 bits
-- of entropy is not a meaningful offline target. A SHA-256 of ~49.5 bits is.
-- The two are stored the same way and are not the same risk.
--
-- ── Why it ends in credential authority ─────────────────────────────────────
--
-- Recovering ONE code is enough, and nothing after that step is a bug:
--
--   1. `submitLoginMfa` accepts a non-6-digit entry as an EMERGENCY RESET. It
--      must work at aal1 — a recovery code cannot raise Supabase's assurance
--      level, so resetting the factor is the only thing it can usefully do.
--      That stays.
--   2. The reset consumes the code, unenrolls the TOTP factor and clears the
--      remaining codes.
--   3. `mfaAuthorizedUser` then passes the session, correctly: with no verified
--      factor there is genuinely no step-up left to demand.
--
-- Every link is intentional. The mistake is upstream of all of them — handing
-- the offline verifiers to the very session MFA exists to contain. Recovery-code
-- secrecy IS part of the MFA boundary, so the verifiers move behind the server.
--
-- ── The application half ────────────────────────────────────────────────────
--
-- Two readers used the user-scoped client and both move to the service role
-- with an explicit `user_id` filter (service_role has rolbypassrls, so that
-- filter — not RLS — is now the tenant boundary, and `user.id` comes from
-- `getUser()` in the same request, never from an argument the browser supplies):
--
--   * `getMfaStatus` in app/dashboard/mfa-actions.ts — the Security panel count.
--   * `loadAccountExport` in lib/account-lifecycle.ts — `mfaRecoveryCodeCount`
--     in the GDPR export. Missing this one would have 503'd /api/account/export.
--
-- The browser keeps exactly what it needs and nothing more: an integer.
--
-- ── Second, separate defect: replacement was not atomic ─────────────────────
--
-- `verifyMfaEnrollment` and `regenerateRecoveryCodes` both did DELETE then
-- INSERT as two independent PostgREST round trips. For a credential REPLACEMENT
-- that is the wrong shape in both directions:
--
--   DELETE ok + INSERT fails → the user is left with no backup codes at all,
--     after a screen that just told them their old ones were replaced.
--   DELETE fails + INSERT ok → both sets are live. New hashes are random and do
--     not collide with the old ones, so nothing removes them: the operator
--     believes the old codes were revoked and they still redeem.
--
-- `replace_mfa_recovery_codes_for_user` does both inside one function call, and
-- a function body is one transaction: if the INSERT raises, the DELETE rolls
-- back with it and the previous set survives untouched. All or nothing.
-- ============================================================================

-- ── 1. The verifiers leave the browser's reach ──────────────────────────────
revoke select on public.mfa_recovery_codes from authenticated, anon;

-- The policies are dead weight once the grant is gone, and leaving them behind
-- reads as though a client path still exists. Dropping them makes the model
-- unambiguous: no browser role has ANY privilege on this table, so there is
-- nothing for a policy to narrow. RLS stays ENABLED (asserted by
-- db/tests/rls_invariants.sql) — with the grants revoked and no policies, the
-- table is deny-all for every non-bypass role, which is the intended end state.
-- `service_role` reaches it by rolbypassrls, as it already did.
drop policy if exists mfa_recovery_codes_select on public.mfa_recovery_codes;
drop policy if exists mfa_recovery_codes_insert on public.mfa_recovery_codes;
drop policy if exists mfa_recovery_codes_update on public.mfa_recovery_codes;
drop policy if exists mfa_recovery_codes_delete on public.mfa_recovery_codes;

comment on table public.mfa_recovery_codes is
  'MFA recovery-code verifier material is SERVER-ONLY: no browser role holds any '
  'privilege on this table. Codes are ~49.5 bits stored as bare SHA-256, so the '
  'hashes are an offline attack surface, and redeeming one legitimately unenrolls '
  'the TOTP factor. Browsers receive only an aggregate remaining-count through a '
  'trusted server action. Issued/replaced via replace_mfa_recovery_codes_for_user, '
  'consumed server-side. See 0031 (and 0029 for the write half).';

-- ── 2. Replacement becomes one transaction ──────────────────────────────────
create or replace function public.replace_mfa_recovery_codes_for_user(
  p_user_id uuid,
  p_hashes  text[]
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inserted integer;
begin
  if p_user_id is null then
    raise exception 'p_user_id is required';
  end if;
  -- Not an empty set either: "replace with nothing" is what `unenrollMfa` and the
  -- recovery reset do with an explicit DELETE, and silently accepting it here
  -- would let a caller bug wipe someone's backup codes while looking like an
  -- issuance. A caller that means to clear them says so.
  if p_hashes is null or array_length(p_hashes, 1) is null then
    raise exception 'p_hashes must contain at least one hash';
  end if;
  if array_length(p_hashes, 1) > 32 then
    raise exception 'p_hashes is implausibly large';
  end if;
  -- Shape check against a trusted-code mistake, not against an attacker (only
  -- service_role reaches this). `lib/recoveryCodes.ts` emits lowercase hex
  -- SHA-256; anything else means a plaintext code or a truncated digest is about
  -- to be stored as a verifier, and that must fail loudly rather than persist.
  if exists (select 1 from unnest(p_hashes) as h where h !~ '^[0-9a-f]{64}$') then
    raise exception 'invalid recovery code hash';
  end if;

  -- One statement pair, one transaction. If the INSERT raises — a duplicate
  -- inside p_hashes trips `unique (user_id, code_hash)` from 0009, for instance —
  -- this DELETE rolls back with it and the caller's old set is still valid.
  delete from public.mfa_recovery_codes where user_id = p_user_id;

  insert into public.mfa_recovery_codes (user_id, code_hash)
  select p_user_id, h from unnest(p_hashes) as h;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

-- SECURITY DEFINER runs as the owner, so EXECUTE is the whole authorization
-- story. Functions are granted to PUBLIC by default: revoke that explicitly
-- before granting, or `authenticated` inherits execute through PUBLIC and can
-- overwrite any tenant's recovery set by passing a p_user_id of its choosing.
revoke all on function public.replace_mfa_recovery_codes_for_user(uuid, text[])
  from public, anon, authenticated;
grant execute on function public.replace_mfa_recovery_codes_for_user(uuid, text[])
  to service_role;

comment on function public.replace_mfa_recovery_codes_for_user(uuid, text[]) is
  'Atomically replace a tenant''s MFA recovery-code set (delete + insert in one '
  'transaction, so a failed insert leaves the previous set intact). Service-role '
  'only; p_user_id must come from server-verified session state, never from client '
  'input. Returns the number of hashes stored. See 0031.';
