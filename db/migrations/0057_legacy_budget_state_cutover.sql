-- ============================================================================
-- PassControl — 0057: an agent that was already spending is not a new grant.
--
-- WHAT THIS CORRECTS. 0055 §5 added `budget_epoch` and
-- `budget_state_established_at` and deliberately did NOT backfill them:
--
--     "NO BACKFILL, and this is load-bearing. Backfilling `established_at`
--      would make every existing agent refuse on its first call after the
--      deploy. NULL means first-init, which is the correct posture during the
--      cutover window: an agent newly given a budget starts enforcement at
--      zero, deliberately, because it has no epoch and no checkpoint and
--      enforcement begins when the budget does."
--
-- The first sentence is true. The second conflates two populations that happen
-- to look identical in those two columns:
--
--   * an agent that has just been GIVEN a budget and has never spent against
--     it — nothing to protect, first-init at zero is right;
--   * an agent that has been spending for months, whose markers are NULL only
--     because this schema did not exist when it started.
--
-- For the second population, losing Redis inside the cutover window is a full
-- refund of the cap. Reproduced against a real Redis in
-- `tests/holds-legacy-cutover.redis.test.ts`: a 10,000,000-token budget with
-- 1,000,000 already spent admits a 9,500,000 reservation, because with both
-- markers NULL the loss check does not run at all. A pause-and-drain cutover
-- cannot prevent it — there is no writer to drain and no hold to settle.
--
-- 0055's file cannot be edited to say this. `scripts/migrate.sh` records a
-- sha256 per applied file and refuses on a mismatch, so a migration's text is
-- immutable the moment anything applies it. The correction therefore lives
-- here, and in the column comments below, which is where a reader inspecting
-- the live schema meets it.
--
-- ── The encoding ────────────────────────────────────────────────────────────
--
-- `budget_state_established_at` SET while `budget_epoch` is still NULL means:
-- this agent had spend state before generations existed. Adopt whatever
-- counters are actually in Redis; refuse if the ones its caps are enforced
-- against are gone.
--
-- That pair is otherwise unreachable, which is what makes it safe to give a
-- meaning. Both writers set the two columns in ONE update:
-- `establishBudgetState` (lib/state/holds.ts) on first-init, and the audited
-- rebuild endpoint. Neither can produce a timestamp without an epoch. The
-- reverse pair — an epoch with no timestamp — already has a meaning and keeps
-- it: a half-finished first-init, read as not-established (lib/state/policy.ts).
--
-- `establishBudgetState` now guards on `budget_epoch is null` rather than on
-- the timestamp, so a legacy agent can still record the epoch it mints. Both
-- properties that guard protected are unchanged: concurrent first-inits still
-- converge on the epoch Redis actually holds, and an established agent's epoch
-- still cannot be overwritten outside the audited rebuild — an established
-- agent has a non-null epoch, so the guard matches no row.
--
-- ── Who gets marked, and what the criterion costs ───────────────────────────
--
-- A budgeted agent with recorded spend: the checkpoint (authoritative, and 0055
-- guarantees a row for every budgeted agent) or, for an agent the reconcile
-- cron has never folded, any countable row in the spend view.
--
-- Deliberately NOT "every budgeted agent". An agent that has a budget and has
-- never called is a genuine first-init and must keep working without an
-- operator; marking it would refuse its first call for having no counters.
--
-- The criterion has one known cost, stated rather than hidden. An agent with a
-- long UNBUDGETED history that was given a budget shortly before this deploy
-- is marked, because the spend view cannot see when the budget was granted --
-- `public.agents` carries no budget-set timestamp. If that agent then loses
-- Redis it is refused, and the operator's rebuild charges it for spend from
-- before it had a budget, because `rebuild_agent_spend` sums the agent's whole
-- history. That is pre-existing rebuild behaviour, not something introduced
-- here, and it is the only direction in this subsystem that can overcharge.
-- The alternative — leaving that agent unmarked — hands back its whole cap on
-- state loss. Refusing is recoverable by an operator who can see the figures;
-- a silent refund is not.
--
-- Idempotent: the guard is the NULL it fills, and an agent that has since
-- graduated to a real epoch is excluded by `budget_epoch is null`.
--
-- ── APPLY THIS AFTER THE CODE, WHICH IS THE OPPOSITE OF 0056 ────────────────
--
-- 0056 must land BEFORE its code (the proxy names `attempt_id`, and PostgREST
-- rejects the whole insert on a column it does not know, silently, on every
-- call). This one is the other way round, and running the two the same way
-- takes marked agents off the air:
--
--   * new code, 0057 not yet applied — every agent still reads as it does
--     today. Nothing breaks; the defect above simply persists until this runs.
--   * 0057 applied, old code — a marked agent reads as established with an
--     empty epoch, which is the disagreement branch, and refuses EVERY call
--     until the deploy lands.
--
-- So the sequence is: apply 0056 → deploy → apply 0057. The drain the mixed
-- writer window needs belongs with 0056's step, not this one.
-- ============================================================================

update public.agents a
   set budget_state_established_at = now()
 where a.budget_state_established_at is null
   and a.budget_epoch is null
   and (a.budget_tokens is not null or a.budget_cents is not null)
   and (
     exists (
       select 1
         from public.agent_spend_checkpoint c
        where c.agent_id = a.id
          and (c.spent_tokens > 0 or c.spent_microcents > 0)
     )
     or exists (
       select 1
         from public.agent_log_spend_rows r
        where r.agent_id = a.id
     )
   );

comment on column public.agents.budget_epoch is
  'Mirrors Redis epoch:<agid>. A disagreement means the hot-path budget counters were lost and the gateway must refuse rather than re-seed. NULL beside a set budget_state_established_at is 0057''s cutover marker: spend state that predates generations, to be adopted from Redis or refused, never re-seeded at zero.';

comment on column public.agents.budget_state_established_at is
  'When budget counters were first established for this agent. NULL means never — the next budgeted call performs first-init and seeds zero. Set with budget_epoch still NULL means the agent was already spending before 0055 existed (0057), which is NOT first-init: its counters are adopted if present and admission is refused if they are gone.';
