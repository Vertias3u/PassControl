-- ============================================================================
-- PassControl — passport expiry and rotation.
--
-- A passport is an Ed25519 keypair whose private half lives on the agent's
-- machine and never touches the wire. Until now it was also immortal: the only
-- way to retire a compromised key was to revoke the agent, which is terminal
-- and takes the agent's id, budgets, audit history and receipts with it. So the
-- responsible act — rotating a key — cost more than doing nothing, which is the
-- wrong shape for a security control.
--
-- Three columns, all nullable with no default, so there is no backfill and
-- every existing passport keeps exactly the behaviour it has today:
--
--   agents.expires_at               null = never expires
--   agents.previous_passport_pubkey null = nothing has been rotated away
--   agents.previous_valid_until     the moment the retired key stops working
--
-- ── Why a second column and not a keys table ────────────────────────────────
--
-- A separate agent_keys table would be the cleaner data model, and it would
-- move both the uniqueness constraint and the challenge lookup — the most
-- security-critical query in the product — off `agents`. It is not worth that
-- to support a third simultaneous key nobody has asked for. Keeping one row per
-- agent means agent_id, budgets, agent_logs, receipts and the decision trace all
-- keep pointing at one continuous identity across a rotation, which is the whole
-- point of rotating rather than reissuing.
--
-- ── No `grant update`, and that is a decision ───────────────────────────────
--
-- Migration 0011 replaced the table-wide `authenticated` UPDATE on `agents` with
-- a column allowlist, because RLS confines a user to their own row but does not
-- stop them PATCHing any column of it through PostgREST. These three are
-- deliberately absent from that allowlist, like 0014's `policy` and 0020's
-- `policy_shadow`. It matters most for previous_valid_until: it is the deadline
-- that ends a retired key's life, and a tenant who could PATCH it could keep a
-- key they have already told their auditor was retired working indefinitely.
--
-- ── previous_passport_pubkey is UNIQUE, and that is not the whole story ─────
--
-- The constraint stops the same retired key being registered twice as retired.
-- It deliberately does NOT cross-check `passport_pubkey`: nothing here prevents
-- another tenant registering an agent whose current key equals this tenant's
-- retired one. A passport id is a PUBLIC key — it is printed on /verify and
-- carried in every receipt — so anyone can copy it, and they still cannot sign
-- for it. The consequence is only that the two columns can legitimately collide
-- ACROSS rows, which is why the auth lookup tries passport_pubkey first and
-- previous_passport_pubkey only on a miss. A single combined query would return
-- two rows and fail the very grace window this migration exists to provide.
--
-- The reconcile cron clears previous_passport_pubkey once previous_valid_until
-- has passed, so a retired key does not hold this unique constraint hostage
-- forever. That sweep is HOUSEKEEPING, not enforcement: expiry is enforced by
-- the auth routes on every single challenge, and a cron that has not run must
-- never be the reason an expired passport still works.
--
-- ── verify_passport is deliberately NOT extended ────────────────────────────
--
-- The public verification RPC from 0015 matches `passport_pubkey` only, and
-- stays that way. It answers a question about a CURRENT passport, and teaching
-- it to resolve retired keys would have a key its owner rotated away keep
-- reporting `active` to the public — worse than not resolving at all. Receipts
-- are verified by signature against /.well-known/jwks.json, not by this lookup,
-- so nothing historical breaks. This is a decision, not an oversight.
-- ============================================================================

alter table public.agents
  add column expires_at               timestamptz,
  add column previous_passport_pubkey text,
  add column previous_valid_until     timestamptz;

-- Named rather than inline so the sweep and any future repair can reference it.
-- Postgres unique constraints ignore nulls, so the overwhelming majority of rows
-- — every agent that has never rotated — do not participate at all.
alter table public.agents
  add constraint agents_previous_passport_pubkey_key unique (previous_passport_pubkey);

-- The sweep looks for rows whose grace window has closed. Partial, so it indexes
-- only rows that have actually rotated rather than the whole table.
create index if not exists agents_previous_valid_until_idx
  on public.agents (previous_valid_until)
  where previous_passport_pubkey is not null;

comment on column public.agents.expires_at is
  'When this passport stops authenticating. NULL means it never expires. '
  'Enforced by the auth routes at challenge time, not by any scheduled job.';

comment on column public.agents.previous_passport_pubkey is
  'The key this agent used before its most recent rotation. Accepted until '
  'previous_valid_until passes, then cleared by the reconcile sweep.';

comment on column public.agents.previous_valid_until is
  'The moment the retired key stops being accepted. A retired key with no '
  'deadline is refused: the auth path fails closed rather than treating a '
  'missing deadline as an open one.';
