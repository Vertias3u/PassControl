-- ============================================================================
-- PassControl — MFA recovery codes are credential material, not user data.
--
-- ── Why this exists, and why 0028 was not enough ────────────────────────────
--
-- 0028 stopped an aal1 session from minting credentials by removing the direct
-- INSERT paths that went around the MFA gate. This migration closes the way
-- through the gate, which is worse, because it defeats 0028 completely.
--
-- A recovery code is not a second password. At /login/verify a code that is not
-- six digits is treated as an EMERGENCY RESET, and the reset is deliberate and
-- documented in the MFA scoping notes: Supabase's assurance level cannot be
-- reached with a recovery code, so `submitLoginMfa` consumes one, UNENROLLS the
-- TOTP factor, clears the remaining codes, and lets the session in at aal1 with
-- a re-enrol prompt. That is the correct design for someone who lost their
-- phone, and it stays.
--
-- The problem was who could write the table. `authenticated` held INSERT, UPDATE
-- and DELETE on `public.mfa_recovery_codes`, with owner-scoped RLS. So an
-- attacker holding an aal1 session for an MFA-enrolled account could:
--
--   1. INSERT a row with a `code_hash` of their own choosing,
--   2. submit that code to /login/verify,
--   3. have the factor unenrolled on their behalf,
--
-- and now `mfaAuthorizedUser` returns ok for their session — not through a bug,
-- but because `verified.length === 0` and there is genuinely no step-up left to
-- clear. Every credential mint in app/dashboard/actions.ts is then reachable
-- through the legitimate, gated, service-role path 0028 just built. The strict
-- gate, the signed-AAL-claim reasoning in lib/mfa.ts, and 0028 are all intact
-- and all irrelevant: the attacker removed the factor instead of forging one.
--
-- UPDATE mattered for the same reason and is revoked with it. `used_at` is the
-- entire single-use mechanism (`consumeRecoveryCode` guards on `used_at IS
-- NULL`), so a client that can write that column can replay one real code
-- forever. DELETE goes too — clearing the codes is part of the reset, not
-- something a browser should be able to do on its own.
--
-- SELECT stays: `getMfaStatus` counts the codes still unused to render the
-- Security panel, and a count of one's own remaining codes leaks nothing.
--
-- ── The application half ────────────────────────────────────────────────────
--
-- Revoking alone would break enrolment, so app/dashboard/mfa-actions.ts moves
-- its recovery-code writes to the service role, and two actions gain the strict
-- gate they were missing:
--
--   * `unenrollMfa` — disabling MFA outright was reachable at aal1 with nothing
--     but `requireUser()`, needing no planted row at all. It is the same bypass
--     in one call. MFA_SCOPING.md always specified "unenroll (with a code
--     re-check)"; the implementation never had one. Now gated.
--   * `regenerateRecoveryCodes` — it MINTS ten valid codes and returns them to
--     the caller, so an aal1 attacker could ask for a working code rather than
--     plant one. Locking the table does nothing about that. Now gated.
--
-- `submitLoginMfa` is deliberately NOT gated: it is the emergency path, it must
-- work from an aal1 session by definition, and after this migration the only
-- codes it can match are ones the server actually issued.
-- ============================================================================

revoke insert, update, delete, truncate, trigger
  on public.mfa_recovery_codes from authenticated, anon;

comment on table public.mfa_recovery_codes is
  'Hashed single-use MFA recovery codes. Redeeming one unenrolls the TOTP factor, '
  'so a client-writable row is a full MFA bypass: `authenticated` may read its own '
  'remaining count and nothing else. Issued and consumed server-side. See 0029.';
