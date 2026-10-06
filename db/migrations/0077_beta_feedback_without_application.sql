-- 0077: feedback from accounts that never had a beta application.
--
-- 0025 tied every feedback row to an accepted beta application, which was true
-- while the only way in was an invitation. With open sign-up most accounts
-- never apply, so application_id becomes optional: set when the account came in
-- through an invitation, null otherwise. The row is still owned by user_id and
-- still erased with the account (public.users cascade); the rating and length
-- checks are unchanged, and only the service role writes it.
alter table public.beta_feedback alter column application_id drop not null;
