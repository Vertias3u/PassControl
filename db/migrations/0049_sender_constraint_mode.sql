-- ============================================================================
-- PassControl — sender-proof: a third state, and a way to measure it.
--
-- 0046 added `require_sender_constrained_visa`, a boolean: enforce, or do not.
-- Two things came out of shipping it.
--
-- 1. NOTHING COULD EVER SET IT. The column has no writer anywhere in the
--    product — grep it. Enforcement was reachable only by hand-editing the row,
--    so the strongest capability in the gateway has been off everywhere since
--    the day it shipped.
--
-- 2. THERE IS NO EVIDENCE TO TURN IT ON WITH. research/sender-constrained-
--    visas.md gates default-on explicitly: "Later, and only on evidence from
--    steps 2-3." But with the flag off the proxy deliberately does not inspect
--    an unsolicited proof at all, and that refusal is CORRECT — recording mere
--    header presence as enforcement would turn a receipt into a false assurance
--    claim. So no evidence was ever being produced, and the gate could never
--    open.
--
-- Both are one missing state. `observe` verifies the proof exactly as
-- enforcement would, records what it found, and admits the call regardless. An
-- operator can then run it against real traffic for a fortnight and SEE whether
-- requiring it would break them, instead of finding out afterwards.
--
-- ── Why this replaces the boolean instead of sitting beside it ──────────────
--
-- off/observe/required is one setting. A second boolean would make it two
-- columns that can disagree, and "two hand-maintained copies of one fact" is
-- the defect this codebase has now fixed in the CLI presets, the guide list,
-- the llms.txt links, the owner tier list and the workspace export. Not again,
-- and not on the enforcement flag of an authentication control.
--
-- The backfill makes the swap lossless even for a row somebody set by hand.
-- ============================================================================

-- Apply via scripts/migrate.sh, which ledgers each file in
-- public.schema_migrations and will not run this twice.

alter table public.agents
  add column if not exists sender_constraint_mode text not null default 'off'
    check (sender_constraint_mode in ('off', 'observe', 'required'));

-- Preserve any row an operator set directly. Runs before the drop, on purpose.
update public.agents
   set sender_constraint_mode = 'required'
 where require_sender_constrained_visa;

alter table public.agents
  drop column if exists require_sender_constrained_visa;

comment on column public.agents.sender_constraint_mode is
  'Whether passport work-visas for this agent require a fresh request-bound '
  'Ed25519 proof. off = bearer visa, and an unsolicited proof is not inspected. '
  'observe = the proof is verified and recorded in agent_logs.sender_proof_would '
  'but decides nothing. required = a valid proof or the call is refused. '
  'Service-managed: no authenticated column grant is added here, exactly as 0046 '
  'added none. Direct Agent Keys stay bearer credentials in every mode.';

-- ── The observation column ─────────────────────────────────────────────────
--
-- Modelled on agent_logs.policy_shadow_would from 0020, down to the wording:
-- it is a record of what WOULD have happened, and it decides nothing. NULL
-- means no proof was evaluated for this attempt — because the mode was off, or
-- because the credential was a Direct Agent Key.
alter table public.agent_logs
  add column if not exists sender_proof_would text;

comment on column public.agent_logs.sender_proof_would is
  'What the sender-proof check found on this attempt while in observe mode: '
  'pass, missing, invalid, clock_skew or replayed. Decides nothing — the call '
  'was admitted whatever this says, and auth_method stays `passport` rather '
  'than `passport_proof_per_request`, because an unenforced proof is not '
  'assurance. NULL means no proof was evaluated.';
