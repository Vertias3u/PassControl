-- ============================================================================
-- PassControl — an operator may STATE an expectation for passport key custody.
--
-- Companion to the declaration added in the same series, which lives in Redis
-- (`keystorage:<agent_id>`) because it is evidence with a shelf life. This is
-- the opposite kind of fact: durable operator intent, stated once and expected
-- to still be there next quarter. A policy that silently vanished after a 45-day
-- TTL would be worse than one that was never stated, so it is a column.
--
-- ── It enforces nothing, and that is the design ─────────────────────────────
--
-- research/passport-key-protection.md §5 settles what the settings tab is
-- allowed to be. The dashboard runs on the server, the passport private key
-- lives on the agent's machine, and the server has never seen it — so no control
-- here can move a key, and "building something that looks like it can would be
-- worse than not building it". What §5 does allow is exactly this: state an
-- expectation people can act on.
--
-- So: nothing in the proxy, the visa mint, or a signed receipt reads this
-- column. An agent below the stated expectation is not blocked, not flagged in
-- an audit row, and not marked on any artifact a stranger verifies. The only
-- consumer is the dashboard, which shows whether a DECLARED tier met it.
--
-- That is not a weak version of enforcement, it is the honest one. §4: the
-- gateway cannot verify a custody claim at any tier. Enforcing on an unverified
-- self-report would build a gate whose key is "say the right word", and this
-- product does not get to overclaim about key custody.
--
-- ── Why no grant ────────────────────────────────────────────────────────────
--
-- 0032 revoked insert/update/delete on public.users from `authenticated` and
-- `anon`, and 0033's note is explicit about the consequence being useful:
-- column grants are additive, so simply never granting one leaves a column
-- server-write-only by construction. The write goes through serviceClient() in
-- app/dashboard/settings/key-custody-actions.ts behind mfaAuthorizedUser(), the
-- same posture as every other write to this table. SELECT is untouched: RLS
-- already confines a tenant to its own row, and this value is not a secret.
--
-- ── Why a store token and not an enum ───────────────────────────────────────
--
-- The value is the same vocabulary the agent declares in ('file', 'os'), so
-- comparison is one tier lookup on both sides rather than a mapping between two
-- vocabularies that can drift. NULL means no expectation stated — the only
-- representation of that, so "not stated" never has to be told apart from "".
-- Adding tier 2 later widens this CHECK and the offered list in
-- lib/key-custody-expectation.ts, and changes nothing else.
-- ============================================================================

-- Apply via scripts/migrate.sh, which ledgers each file in
-- public.schema_migrations and will not run this twice.

alter table public.users
  add column if not exists key_custody_expectation text
    check (key_custody_expectation in ('file', 'os'));

comment on column public.users.key_custody_expectation is
  'The passport key-storage tier this workspace expects of its agents, as a '
  'store token matching what an agent declares: file = tier 0, os = tier 1. '
  'NULL means no expectation stated. STATED, NEVER ENFORCED — nothing in the '
  'proxy, the visa mint or a receipt reads it, because the declaration it is '
  'compared against is a self-report the gateway cannot verify at any tier '
  '(research/passport-key-protection.md §4-5). Server-write-only: no grant is '
  'added here, so 0032''s revoke on this table still governs it.';
