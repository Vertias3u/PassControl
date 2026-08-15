-- ============================================================================
-- PassControl — the contract phase 0023 deferred: agent_logs identity is now
-- structurally enforced, not defaulted.
--
-- 0023 said this out loud: "This migration MUST land before the dual-mode
-- gateway. It deliberately does not add the final discriminated identity CHECK
-- or set auth_method NOT NULL: those constraints belong in a later migration
-- after the new writer has run in production." The new writer has run in
-- production. This is that migration.
--
-- ── Why it matters now ──────────────────────────────────────────────────────
--
-- `auth_method` was a nullable column with `default 'passport'`, and the
-- passport writer in lib/log.ts deliberately OMITS it (see below). So the value
-- 'passport' has been supplied by the database, not asserted by the gateway.
-- That was harmless while the column was only read for display. It stopped being
-- harmless when Passport onboarding began treating
-- `auth_method = 'passport' and status = 'ok'` as PROOF of identity.
--
-- Be exact about what that proves, because the onboarding copy now is. The row
-- proves a passport-DERIVED VISA authenticated the call — and therefore, because
-- `jti` can only have come from a minted visa, that an Ed25519 challenge
-- signature was verified earlier at mint time (app/api/auth/challenge/route.ts).
-- It does NOT prove the private key signed this particular provider request: the
-- proxy verifies a reusable, short-lived HS256 bearer visa via `verifyVisa` and
-- performs no signature check of its own. A reused or still-valid stolen visa is
-- the case that makes the difference observable, which is why the dashboard says
-- "Passport visa accepted" and not "Passport signature accepted".
--
-- A proof must not rest on a column default either: any writer that forgets the
-- column — a repair script, a backfill, a future code path — would have its row
-- silently stamped with an identity it never presented.
--
-- ── Why the default stays anyway ────────────────────────────────────────────
--
-- The obvious fix, "drop the default and make the writer name the column", is
-- the dangerous one. PostgREST rejects an INSERT that names a column the schema
-- does not have, and agent_logs writes are best-effort — so a deployment running
-- new code against a pre-0023 schema would silently stop writing audit rows
-- entirely, on every call. lib/log.ts documents that trap twice already (0016's
-- `receipt`, 0020's `policy_shadow_would`). The omission is correct and stays.
--
-- The teeth are therefore in the CHECK, not in the default. A row must now be
-- INTERNALLY CONSISTENT with whatever identity it claims:
--
--   auth_method = 'passport'    ->  passport_id and jti present,
--                                   no access key, no credential use id
--   auth_method = 'direct_key'  ->  agent_access_key_id and credential_use_id
--                                   present, passport_id and jti null
--
-- That is what closes the hole. A rogue insert that omits `auth_method` gets the
-- 'passport' default and is then REJECTED unless it also carries a passport id
-- and a visa jti — which only a real passport call has. The default can no
-- longer manufacture a passport claim out of an incomplete row.
--
-- ── Ordering ────────────────────────────────────────────────────────────────
--
-- NOT VALID first, then VALIDATE. ADD CONSTRAINT ... NOT VALID starts enforcing
-- NEW rows immediately, and VALIDATE then scans the rows already stored — so
-- enforcement precedes validation, which is the property that matters here. If
-- VALIDATE fails, the transaction aborts and nothing is half-applied. That is
-- the correct outcome: it means a stored row claims an identity its own columns
-- do not support, and that is worth knowing before it is used as proof.
--
-- Note what this ordering does NOT buy in this repository. The usual reason to
-- split ADD from VALIDATE is lock duration — ADD ... NOT VALID takes a brief
-- ACCESS EXCLUSIVE lock, VALIDATE scans under a weaker SHARE UPDATE EXCLUSIVE
-- one. `scripts/migrate.sh` runs each file with `psql -1`, so this whole file is
-- ONE transaction and the ADD's lock is held straight through the VALIDATE
-- anyway; the SET NOT NULL below already takes a full-scan ACCESS EXCLUSIVE
-- besides. The split is kept because it is correct and portable, not because it
-- shortens a lock here. On this table's size that is not a live-traffic concern.
--
-- ── Why there is no backfill UPDATE ─────────────────────────────────────────
--
-- There is nothing to back-fill and no way to do it. 0023 added the column as
-- `text default 'passport'`, which gives every row that already existed that
-- value, and no writer inserts an explicit null (lib/log.ts omits the column on
-- the passport path and sets 'direct_key' on the other). So a repair UPDATE
-- would match zero rows — which is the only reason 0023's own identical UPDATE
-- survived production, because 0006 made agent_logs append-only and a direct
-- UPDATE raises 'agent_logs is append-only' at trigger depth 1. Had a null ever
-- existed, that statement would have aborted the migration with an error about
-- immutability rather than about the null it found. SET NOT NULL reports such a
-- row honestly instead, and an append-only audit table is exactly where a
-- surprise null should stop the migration rather than be quietly rewritten.
-- ============================================================================

alter table public.agent_logs
  alter column auth_method set not null;

-- Bound the vocabulary. An unrecognised value must not reach the dashboard,
-- where it would render through a fallback label rather than be refused.
alter table public.agent_logs
  add constraint agent_logs_auth_method_known
  check (auth_method in ('passport', 'direct_key'))
  not valid;

alter table public.agent_logs
  validate constraint agent_logs_auth_method_known;

-- The discriminated identity itself. Trust boundary 1: a direct receipt must
-- never say a passport signed the call, and the row it is derived from is the
-- first place that can be made structurally impossible.
alter table public.agent_logs
  add constraint agent_logs_identity_discriminated
  check (
    (
      auth_method = 'passport'
      and passport_id is not null
      and jti is not null
      and agent_access_key_id is null
      and credential_use_id is null
    )
    or (
      auth_method = 'direct_key'
      and agent_access_key_id is not null
      and credential_use_id is not null
      and passport_id is null
      and jti is null
    )
  )
  not valid;

alter table public.agent_logs
  validate constraint agent_logs_identity_discriminated;

-- ── 0023's other deferred constraint, finished here ─────────────────────────
--
-- 0023 added agent_logs_access_key_fk NOT VALID and moved on. That deferral has
-- no remaining justification, and "out of scope" is not one — the constraint is
-- half of the same identity contract this migration exists to close: the
-- direct_key arm above requires agent_access_key_id to be PRESENT, and this is
-- what requires it to be REAL.
--
-- Validating it is provably safe, from migration order rather than from hope:
--
--   1. `agent_access_key_id` is added by 0023 itself, in the statement directly
--      before the FK. A column that did not exist a moment earlier is NULL on
--      every already-stored row, and a NULL satisfies any foreign key.
--   2. `agent_access_keys`, the referenced table, is created by that same
--      migration — so no value could have been written against it beforehand.
--   3. A NOT VALID foreign key still enforces every subsequent INSERT and
--      UPDATE. NOT VALID skips the scan of pre-existing rows; it does not stop
--      enforcing new ones.
--
-- (1)+(2) say the pre-existing rows are all NULL; (3) says everything written
-- since was checked. The set of unenforced non-null values is therefore empty by
-- construction, so this VALIDATE has nothing to find on any schema this
-- repository's migrations produced. It is not a proof about a hand-altered
-- database: 0023 says `add column if not exists`, so a column introduced
-- out-of-band before it could carry values the FK never saw. That case aborts
-- the transaction with an honest referential error — the same stance the
-- SET NOT NULL above takes toward a surprise null, and the right one for an
-- immutable audit table. It costs one scan and it
-- converts "enforced going forward" into "true of the whole table", which is the
-- difference between a constraint and a promise on an immutable audit trail.
--
-- It also costs nothing extra in locks: SET NOT NULL above already took a
-- full-table ACCESS EXCLUSIVE in this same psql -1 transaction, and VALIDATE's
-- weaker SHARE UPDATE EXCLUSIVE cannot be observed separately from inside it.
alter table public.agent_logs
  validate constraint agent_logs_access_key_fk;

comment on column public.agent_logs.auth_method is
  'Which credential authenticated this call. Constrained by '
  'agent_logs_identity_discriminated so the value always agrees with the '
  'identity columns beside it: the passport writer may still omit this column '
  'and take the default, but only a row that actually carries a passport id and '
  'a visa jti will be accepted as one. Onboarding treats passport + ok as proof '
  'that a passport-derived visa authenticated the call, and therefore that an '
  'Ed25519 challenge signature was verified earlier when that visa was minted. '
  'It is NOT proof that the private key signed this request — the proxy verifies '
  'an HS256 bearer visa. Both halves of that reading are only honest because of '
  'this constraint.';
