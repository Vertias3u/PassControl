-- ============================================================================
-- PassControl — close the write surface on public.users that 0002 aimed at and
-- missed, and give every account the profile row the schema already assumes.
--
-- This migration is deliberately NOT the operator-profile feature. It is the
-- precondition for it, it fixes a defect that exists today on its own terms, and
-- it is kept separately revertible for that reason. The feature lands in 0033.
--
-- ── The defect ──────────────────────────────────────────────────────────────
--
-- 0002_lock_privileged_columns.sql set out to stop a user choosing their own
-- `plan`. Its entire executable content is two statements:
--
--     revoke update (plan) on public.users from authenticated, anon;
--     revoke insert (plan) on public.users from authenticated, anon;
--
-- No GRANT. That is a no-op twice over, and this repo already documents both
-- reasons in its own headers:
--
--   * A column-level REVOKE cannot narrow a table-level GRANT. 0011 says it
--     ("The earlier table-wide grant cannot be narrowed with a column-only
--     REVOKE, so replace it with grants for the editable metadata columns") and
--     0012 repeats it. Both then fix it that way. 0002 never issued the grant.
--   * 0007_grants.sql runs AFTER 0002 — filename order is apply order — and
--     re-issues `grant all on public.users, … to anon, authenticated,
--     service_role`, which would have undone a correct 0002 regardless.
--
-- The live database agrees. backup-public-20260819-0900.sql carries
-- `GRANT ALL ON TABLE public.users TO anon/authenticated/service_role` and no
-- column-level entry for that table, while public.agents shows the 0011 pattern
-- working as intended (`GRANT UPDATE(name)`, `GRANT UPDATE(budget_tokens)`, …).
-- So today this succeeds for any logged-in session:
--
--     update public.users set plan = 'whatever' where id = auth.uid();
--
-- Stated at its real size, because the temptation is to write it up as worse
-- than it is: nothing in the application reads `plan` except the account export,
-- so this is a latent escalation rather than one that currently buys an attacker
-- anything, and RLS still confines it to the caller's own row — it is not a
-- tenant boundary failure. It is closed now because 0033 turns this table into
-- the operator's public identity, and a self-writable identity is not one.
--
-- ── Which lock ──────────────────────────────────────────────────────────────
--
-- Not 0011/0012's column allowlist. That pattern is right when the browser must
-- keep writing some columns, and it carries a standing cost: every future
-- profile column has to be added to the grant, and forgetting fails OPEN.
--
-- The precedent followed instead is agent_owners (0017) — the closest relative,
-- being the other table with a public/`published` toggle. It revokes
-- insert/update/delete outright and runs every mutation server-side. Its header
-- gives the reason, and it applies verbatim: a client that can write its own
-- published state makes that state meaningless. 0028 made the same move for
-- public.agents, noting the user-scoped write "went over PostgREST under the
-- caller's own JWT, and RLS can only ask who owns the row — never whether this
-- session cleared a second factor."
--
-- Consequence, and it is load-bearing: the two `db.from("users").upsert(...)`
-- calls in app/dashboard/actions.ts ran under the caller's JWT and stop working
-- the moment this applies. They move to serviceClient() in the same commit.
-- ============================================================================

-- ── 1. Backfill ──────────────────────────────────────────────────────────────
--
-- No row in public.users is created at signup. Not by app/actions/auth.ts, not
-- by app/auth/callback/route.ts, and not by a trigger — there are none on
-- auth.users. Rows appear lazily inside store_provider_key (0001/0027/0030),
-- inside redeem_beta_invite (0025), and at the two agent-creation call sites.
--
-- That has a live consequence beyond this migration. public.agent_owners.user_id
-- references public.users(id), so an operator who signs up and declares an owner
-- BEFORE registering an agent or storing a provider key hits a foreign-key
-- violation, which lib/owner/manage.ts surfaces as a generic write failure. The
-- backfill makes that unreachable for every account that exists today; the
-- ensureProfile() helper in lib/profile/manage.ts covers the ones created after.

insert into public.users (id, email)
select id, email from auth.users
on conflict (id) do nothing;

-- ── 2. The write lock ────────────────────────────────────────────────────────
--
-- SELECT stays: the users_self policy from 0001 already confines a read to the
-- caller's own row, and the dashboard needs it. Writes go through serviceClient()
-- in lib/profile/manage.ts, which verifies the session and the second factor in
-- code first — the thing RLS structurally cannot do.
--
-- No column grant is handed back. That is the difference from 0011/0012 and it
-- is the point: there is no editable-column list to keep in sync, so a profile
-- column added later cannot accidentally arrive writable.

revoke insert, update, delete, truncate on public.users from authenticated, anon;
grant select on public.users to authenticated;

comment on table public.users is
  'The operator account row. Read-your-own through RLS; every write goes through '
  'the service role in lib/profile/manage.ts, because RLS can prove ownership but '
  'not that the session cleared a second factor. See 0032 for why the column '
  'allowlist in 0002 never took effect.';
