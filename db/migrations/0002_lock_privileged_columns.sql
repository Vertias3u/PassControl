-- ============================================================================
-- PassControl — Harden: prevent self privilege-escalation on public.users.
--
-- The users_self RLS policy is `for all` (so a user can upsert their own profile
-- row). RLS gates WHICH rows, not WHICH columns, so without this an authenticated
-- user could PATCH their own row via the anon/auth client and set plan = 'pro'
-- (or any future entitlement column). plan is not security-enforced today, but we
-- close the path now. Column-level GRANTs are independent of RLS: revoking
-- UPDATE(plan) blocks the change for authenticated/anon while leaving the rest of
-- the row editable. service_role (gateway/server) is unaffected and remains the
-- only writer of entitlement columns.
-- ============================================================================

revoke update (plan) on public.users from authenticated, anon;

-- INSERT still defaults plan to 'free' (see 0001). A user inserting their own
-- profile cannot choose a non-default plan because they lack INSERT(plan) either:
revoke insert (plan) on public.users from authenticated, anon;
