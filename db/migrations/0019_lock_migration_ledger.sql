-- ============================================================================
-- PassControl — take the migration ledger off the public API.
--
-- `public.schema_migrations` is the only table in this product that no migration
-- creates: scripts/migrate.sh and scripts/dev-stack.sh both create it themselves,
-- as `postgres`, before applying anything. Supabase's default privileges on
-- schema `public` grant every table postgres creates there to `anon` and
-- `authenticated` — so the ledger has come up readable AND writable through
-- PostgREST on every database this project has ever migrated, with the anon key
-- alone and no session at all.
--
-- Confirmed against the local stack on 2026-08-07:
--   GET    /rest/v1/schema_migrations                       → 200, full list
--   DELETE /rest/v1/schema_migrations?version=eq.<no match> → 204 (authorised)
--
-- Two things that costs, stated at their real size:
--
--   * It leaks the roadmap. The applied list names work by feature —
--     `0017_agent_owners` is readable today by anyone holding the publishable
--     key, which is by design a public value.
--   * Wiping it strands the migration tooling. The next `migrate.sh` replays
--     from 0001 and dies there (0001 references `spent_cents`, which 0005
--     renamed), so no further migration can be shipped until the ledger is
--     rebuilt by hand.
--
-- And one thing it does NOT cost, because the temptation is to write this up as
-- worse than it is: it is not a route to the data corruption 0005 warns about.
-- That replay fails at 0001, inside 0001's own transaction, so 0005's scaling
-- `update` is unreachable. Verified by replaying 0001–0005 against the live
-- schema inside a rolled-back transaction.
--
-- Two independent locks, because they fail in different directions. The revoke
-- is the fix; RLS is the backstop for the day a future `alter default
-- privileges` — or a hand-run `grant all on all tables in schema public` — hands
-- the grants back. With no policy on the table, neither PostgREST role can see a
-- row even holding a grant. `postgres` owns it and `service_role` bypasses RLS,
-- so both migration scripts keep working unchanged.
-- ============================================================================

do $$
begin
  -- The scripts create the ledger before applying any file, so it is here in
  -- every normal path. Guarded anyway: a database migrated by some other route
  -- must not fail this migration on a table it never had.
  if to_regclass('public.schema_migrations') is null then
    raise notice 'public.schema_migrations does not exist — nothing to lock.';
    return;
  end if;

  revoke all on public.schema_migrations from anon;
  revoke all on public.schema_migrations from authenticated;

  alter table public.schema_migrations enable row level security;

  comment on table public.schema_migrations is
    'Applied-migration ledger. Tooling state, not application data: written only by scripts/migrate.sh and scripts/dev-stack.sh as postgres. Deliberately unreachable from PostgREST — revoked from anon and authenticated, and RLS-enabled with no policy so a restored grant still yields nothing.';
end
$$;
