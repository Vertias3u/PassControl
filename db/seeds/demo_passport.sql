-- ============================================================================
-- Seed the public demo passport.
--
-- The public verification page (/verify) links to one passport so a stranger can
-- see what a real answer looks like without owning an agent. That link only
-- resolves if this row exists in the database the site is pointed at.
--
-- scripts/seed.mjs already creates this row on the local stack under
-- PASSCONTROL_DEMO=1, but it also provisions an admin account, which is not what
-- you want to run against the hosted demo project. This file is the row on its
-- own: paste it into the Supabase SQL editor for the demo project.
--
-- The identifier is the committed demo public key from lib/demo/identity.ts. It
-- is public by design. Keep the two in sync — and never give this row a real
-- provider scope; `demo` reaches the keyless demo provider only, so a passport
-- anyone on the internet can look up can never spend money.
--
-- Idempotent: re-running it re-asserts the demo row and touches nothing else.
-- ============================================================================

insert into public.agents (user_id, name, passport_pubkey, status, budget_tokens, budget_cents, allowed_scopes)
select
  u.id,
  'demo-agent',
  'kZCFp7d2x4VDruiulJ21gogYbczBDAGZa-OuwR3qgh8',
  'active',
  200000,
  null,
  '[{"provider":"demo","models":["*"]}]'::jsonb
from public.users u
order by u.created_at
limit 1
on conflict (passport_pubkey) do update
  set status        = 'active',
      name          = 'demo-agent',
      allowed_scopes = excluded.allowed_scopes;

-- Confirm it landed and is exactly what the public page will report.
select passport_pubkey, status, created_at
from public.agents
where passport_pubkey = 'kZCFp7d2x4VDruiulJ21gogYbczBDAGZa-OuwR3qgh8';
