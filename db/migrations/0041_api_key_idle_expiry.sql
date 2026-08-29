-- ============================================================================
-- PassControl — control keys can expire when nobody is using them.
--
-- `api_keys` had no expiry column and nothing enforced one, so a `pc_` key was
-- immortal. That was survivable while keys were minted by hand, one or two per
-- account, in Settings. `passcontrol login` changed the shape: it mints a
-- write-scoped key per MACHINE, and it is meant to be run on every laptop,
-- container and CI runner an operator has. Machines are decommissioned, lost and
-- reimaged far more often than anyone remembers to revoke the key that was on
-- them — so the product now manufactures exactly the credential it had no way to
-- retire. A stolen laptop kept create/suspend/revoke authority over the whole
-- fleet, plus the kill switch, forever.
--
-- ── One nullable column, no backfill ────────────────────────────────────────
--
-- `null` means never expires, and every key that exists when this migration runs
-- stays null. The same shape as `agents.expires_at` in 0021, for the same reason:
-- a security column that retires live credentials the moment it is added is a
-- migration nobody can safely apply.
--
-- That does mean this closes nothing retroactively. Keys minted before today are
-- still immortal until someone revokes them. Backfilling a deadline onto them
-- was considered and rejected: the rolling window below is measured from LAST
-- USE, so a backfill would not gently retire an idle key — it would kill it on
-- the spot, including keys in a CI pipeline that happens to run monthly. Retiring
-- existing keys is an operator decision with a dashboard in front of it, not a
-- side effect of applying a migration.
--
-- ── Why the window rolls instead of capping ─────────────────────────────────
--
-- Enforcement lives in lib/control/auth.ts, which refuses a key whose deadline
-- has passed and pushes the deadline forward on every successful authentication
-- (IDLE_WINDOW_MS, 90 days). So a key in daily use never expires and a key in a
-- drawer dies.
--
-- An absolute cap was the obvious alternative and is worse here. It would break
-- working CI on a schedule, which buys nothing: a key being used constantly is a
-- key whose owner would notice losing it. The threat is the key nobody is
-- watching, and only an idle window can tell the two apart.
--
-- ── The column is deliberately NOT client-writable ──────────────────────────
--
-- 0012 narrowed `authenticated` to `grant update (revoked_at) on public.api_keys`,
-- a COLUMN-level grant. A new column therefore inherits no write permission, and
-- this migration adds none: the rolling push happens with the service role inside
-- the authentication path, never from a browser. Do not add
-- `grant update (expires_at)` here later without deciding, out loud, that a user
-- extending their own key's deadline from the client is intended — the enforcement
-- above is only as good as the fact that nothing else can move the number.
--
-- Reads are unaffected: `api_keys_select` (0008) is row-level and covers whatever
-- columns the table has, so the dashboard can show the deadline with no new grant.
-- ============================================================================

alter table public.api_keys
  add column if not exists expires_at timestamptz;

comment on column public.api_keys.expires_at is
  'Idle deadline. null = never expires (every key predating 0041, and every key '
  'created by hand in Settings). Set only by the CLI device flow, and pushed '
  'forward by lib/control/auth.ts on each successful use, so the window retires '
  'abandoned machines and never a working one. Not client-writable: 0012 grants '
  'authenticated update on revoked_at only.';

-- No index. The authentication lookup is by `key_hash`, which is UNIQUE and
-- already indexed; `expires_at` is read from the row that lookup returns and is
-- never itself a search key. An index here would cost every write and serve
-- nothing.

comment on table public.api_keys is
  'Control-plane developer keys. Minted server-side only, behind the strict MFA '
  'gate, with the service role; `authenticated` may read its own metadata and '
  'set revoked_at, and nothing else. See 0028. Keys minted by `passcontrol login` '
  'carry a rolling idle deadline in expires_at; see 0041.';
