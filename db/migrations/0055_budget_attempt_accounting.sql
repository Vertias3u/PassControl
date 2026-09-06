-- ============================================================================
-- PassControl — one attempt lifecycle for budget accounting.
--
-- The gateway had no durable record of what a single attempt reserved, so every
-- consumer of that reservation guessed. Three defects fell out of the same root:
-- the reconcile cron SET `spent:` from a lagged total and erased live spend
-- settled inside the lag window; settlement replayed through a transport retry
-- because nothing was keyed on the attempt; and a stream that broke after
-- delivering content refunded its whole hold for tokens the provider had
-- actually generated.
--
-- The Redis half of that lives in lib/state/holds.ts. THIS FILE is the database
-- half, and it exists for one reason: the checkpoint that the cron folds into
-- `spent:` counted `status = 'ok'` rows only. An attempt whose usage is unknown
-- is charged in Redis at its estimate — so unless the checkpoint counts it too,
-- the very next cron run hands the capacity straight back. Fixing settlement
-- idempotence alone leaves the cron refunding.
--
-- Fully additive, and deliberately so: nullable columns with no default, a new
-- view, a redefined function with an UNCHANGED signature, one new function, two
-- nullable columns on agents, one partial index. The old code path calls the
-- same RPC and gets the same numbers, because no `usage_unknown` rows exist
-- until the code that writes them deploys. That is what lets this apply while
-- the current deployment is still running.
--
-- Apply via scripts/migrate.sh, which ledgers each file in
-- public.schema_migrations and will not run this twice.
-- ============================================================================

-- ── 1. What was ENFORCED, alongside what was OBSERVED ───────────────────────
--
-- These are not a correction of input_tokens/cost_microcents and must never be
-- read as one. The observed columns stay observed: a stream that broke after
-- reporting 40 tokens really did report 40 tokens, and `cost_microcents` stays
-- NULL with `unpriced = true` on a call nobody could price. What the gateway
-- CHARGED that attempt is a different number — max(observed, estimate) for an
-- uncertain ending — and it is the number a budget was enforced against.
--
-- Recording both is what lets the row stay truthful while the database still
-- agrees with Redis about enforcement. Same ethic as `unpriced` in 0053: when a
-- number and its provenance disagree, add the provenance rather than editing the
-- number.
--
-- NULLABLE, NO DEFAULT, AND WRITTEN ONLY WHEN THEY DIFFER FROM THE OBSERVED
-- FIGURES. lib/log.ts names them with the same conditional spread it already
-- uses for `receipt`, `policy_shadow_would`, `sender_proof_would` and
-- `unpriced`, and for the same reason: PostgREST rejects the WHOLE insert on an
-- unknown column, so a deployment running newer code against a pre-0055 schema
-- would write NO audit rows at all, silently, on every call.
--
-- REJECTED ALTERNATIVE, recorded with its reason: a `counts_toward_spend`
-- boolean. It would have to be named in every insert — including the inserts
-- that predate it — which is the failure mode lib/log.ts already guards four
-- times. The status column already carries that fact and needs no backfill.
alter table public.agent_logs
  add column if not exists enforced_tokens bigint,
  add column if not exists enforced_microcents bigint;

comment on column public.agent_logs.enforced_tokens is
  'Tokens charged against the budget for this attempt, when that differs from the observed input+output. NULL means the observed total was what was enforced.';
comment on column public.agent_logs.enforced_microcents is
  'Micro-cents charged against the budget for this attempt, when that differs from the observed cost. NULL means the observed cost was what was enforced.';

-- Serves both readers below. 0013's `status = 'ok'` partial index is left alone
-- on purpose: it serves different queries in lib/, and widening it would change
-- their plans for a benefit this index already provides.
create index if not exists agent_logs_agent_spend_idx
  on public.agent_logs (agent_id, created_at)
  where status in ('ok', 'usage_unknown');

-- ── 2. ONE expression, used by BOTH readers ─────────────────────────────────
--
-- The incremental fold and the full rebuild have to agree permanently. If they
-- are two copies of the same arithmetic, the day one of them learns about a new
-- status is the day a rebuild silently disagrees with every checkpoint that
-- preceded it — and a rebuild is what an operator reaches for precisely when
-- they have stopped trusting the numbers. So the arithmetic is written once,
-- here, and both functions select from it. Same ethic as MAX_FALLBACKS and the
-- CLI presets: the definition lives in one place and the users import it.
--
-- `usage_unknown` counts. That is the whole point of the file — see the header.
--
-- `security_invoker = true` so the view carries no privilege of its own: it is a
-- named expression, not a new way to read agent_logs. RLS on the underlying
-- table therefore still decides, evaluated as whoever is reading.
--
-- WHY THAT IS SAFE INSIDE A SECURITY DEFINER FUNCTION, since this is the
-- interaction that fails silently if it is wrong: `reconcile_agent_spend` is
-- `security definer` with `search_path = ''`, so "the invoker" inside it is the
-- function's OWNER. That owner also owns agent_logs and holds BYPASSRLS, and
-- agent_logs does not FORCE row security — so the rows come back. If any of
-- those three facts stopped holding, this view would return zero rows, the
-- checkpoint would stop advancing, and NOTHING WOULD FAIL: the cron would still
-- return ok with a count of agents. db/tests/budget_accounting_invariants.sql
-- asserts the rows are visible from inside the function for exactly that reason.
drop view if exists public.agent_log_spend_rows;
create view public.agent_log_spend_rows
  with (security_invoker = true) as
select
  l.agent_id,
  l.created_at,
  -- The FOLDED token total, matching what the proxy writes and what the previous
  -- definition of reconcile_agent_spend summed. Anthropic's cache dimensions are
  -- already folded into input_tokens by lib/log.ts; there is no cache column
  -- here to read, and adding one would double-count them.
  coalesce(
    l.enforced_tokens,
    coalesce(l.input_tokens, 0) + coalesce(l.output_tokens, 0)
  )::bigint as spend_tokens,
  -- An unpriced call has cost_microcents NULL and, when a cost cap was enforced
  -- against its estimate, enforced_microcents set. Preferring the enforced value
  -- is what stops a custom endpoint from being free to a cost cap.
  coalesce(
    l.enforced_microcents,
    coalesce(l.cost_microcents, 0)
  )::bigint as spend_microcents
from public.agent_logs as l
where l.status in ('ok', 'usage_unknown');

comment on view public.agent_log_spend_rows is
  'The single definition of which agent_logs rows count toward spend and for how much. Read by reconcile_agent_spend and rebuild_agent_spend so the incremental fold and the full rebuild can never drift.';

revoke all on public.agent_log_spend_rows from public, anon, authenticated;
grant select on public.agent_log_spend_rows to service_role;

-- ── 3. The incremental fold, pointed at the view ────────────────────────────
--
-- Same signature, same lag, same watermark, same return shape. The only change
-- is where the amounts come from.
--
-- THERE IS NO RETROACTIVE STEP CHANGE. The fold is incremental and every
-- historical row that this widening newly admits — an `upstream_error` row is
-- NOT admitted; only the new `usage_unknown` status is — would have to sit after
-- some agent's `reconciled_at` to be counted, and no such row exists until the
-- code that writes them deploys. So applying this migration alone moves no
-- checkpoint by a single token.
drop function if exists public.reconcile_agent_spend(int);
create or replace function public.reconcile_agent_spend(p_lag_seconds int default 60)
returns table (agent_id uuid, spent_tokens bigint, spent_microcents bigint)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_cutoff timestamptz := now() - make_interval(secs => greatest(p_lag_seconds, 0));
begin
  -- Ensure a checkpoint row exists for every budgeted agent. Cost-only budgets
  -- need the same authoritative reseed path as token budgets.
  insert into public.agent_spend_checkpoint (agent_id)
  select a.id
    from public.agents a
   where a.budget_tokens is not null
      or a.budget_cents is not null
  on conflict (agent_id) do nothing;

  return query
  with delta as (
    select c.agent_id as aid,
           coalesce(sum(l.spend_tokens), 0)::bigint as token_delta,
           coalesce(sum(l.spend_microcents), 0)::bigint as cost_delta
      from public.agent_spend_checkpoint c
      join public.agents a
        on a.id = c.agent_id
       and (a.budget_tokens is not null or a.budget_cents is not null)
      left join public.agent_log_spend_rows l
        on l.agent_id = c.agent_id
       and l.created_at > c.reconciled_at
       and l.created_at <= v_cutoff
     group by c.agent_id
  )
  update public.agent_spend_checkpoint c
     set spent_tokens = c.spent_tokens + delta.token_delta,
         spent_microcents = c.spent_microcents + delta.cost_delta,
         reconciled_at = v_cutoff,
         updated_at = now()
    from delta
   where delta.aid = c.agent_id
  returning c.agent_id, c.spent_tokens, c.spent_microcents;
end;
$$;

revoke all on function public.reconcile_agent_spend(int) from public, anon, authenticated;
grant execute on function public.reconcile_agent_spend(int) to service_role;

-- ── 4. The full rebuild — the cold-state and operator-recovery authority ────
--
-- Reads the SAME view, so a rebuild and the running fold can never disagree
-- about which rows count. That is why the new status is a status rather than a
-- widening of `upstream_error`: widening would make a rebuild count historical
-- error rows the checkpoint never saw, and the two would part company at the
-- first recovery an operator ever performed.
--
-- Sets the watermark rather than advancing it, because it has just computed the
-- total from scratch. That is a LOWERING of a checkpoint if history has shrunk,
-- and it is the only sanctioned one — it is reachable exclusively through an
-- audited control endpoint (audit.ts `budget.rebuild`), never from the hot path
-- and never from the cron.
--
-- Residual, stated rather than hidden: a row that commits after v_cutoff is read
-- but carries an earlier created_at falls outside both this sum and the next
-- incremental fold. The window is one transaction's commit latency and the same
-- one 0010's own backfill accepted. It can only ever UNDER-count by that
-- sliver, and the monotone raise in lib/reconcile.ts is what keeps an
-- undercount from becoming a refund.
create or replace function public.rebuild_agent_spend(p_agent_id uuid)
returns table (agent_id uuid, spent_tokens bigint, spent_microcents bigint)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_cutoff timestamptz := now();
  v_tokens bigint;
  v_microcents bigint;
begin
  select coalesce(sum(l.spend_tokens), 0)::bigint,
         coalesce(sum(l.spend_microcents), 0)::bigint
    into v_tokens, v_microcents
    from public.agent_log_spend_rows l
   where l.agent_id = p_agent_id
     and l.created_at <= v_cutoff;

  insert into public.agent_spend_checkpoint as c
              (agent_id, spent_tokens, spent_microcents, reconciled_at, updated_at)
       values (p_agent_id, v_tokens, v_microcents, v_cutoff, now())
  on conflict (agent_id) do update
     set spent_tokens = excluded.spent_tokens,
         spent_microcents = excluded.spent_microcents,
         reconciled_at = excluded.reconciled_at,
         updated_at = now();

  return query select p_agent_id, v_tokens, v_microcents;
end;
$$;

revoke all on function public.rebuild_agent_spend(uuid) from public, anon, authenticated;
grant execute on function public.rebuild_agent_spend(uuid) to service_role;

-- ── 5. Budget state establishment ───────────────────────────────────────────
--
-- Redis holding no counters for a budgeted agent has two completely different
-- meanings, and the old code could not tell them apart: either this agent has
-- never spent anything, or the state was lost. `seedSpent` guessed the first —
-- it NX-seeded from the visa's `st` claim, minted from `agents.spent_tokens`,
-- which is a best-effort mirror that lib/log.ts drops silently on RPC failure.
-- So after a Redis flush it re-initialised from an older, lower number and
-- handed the difference back as spendable capacity. It is deleted.
--
-- These two columns are what replaces the guess. `budget_state_established_at`
-- being set means "counters for this agent existed once"; a Redis epoch that is
-- absent or disagrees then means loss, and the gateway refuses rather than
-- inventing a starting balance. The epoch itself rides in the agent-policy cache
-- the proxy already reads per call, so the check costs no extra round trip.
--
-- NO BACKFILL, and this is load-bearing. Backfilling `established_at` would make
-- every existing agent refuse on its first call after the deploy. NULL means
-- first-init, which is the correct posture during the cutover window: an agent
-- newly given a budget starts enforcement at zero, deliberately, because it has
-- no epoch and no checkpoint and enforcement begins when the budget does.
--
-- Not client-writable, and no grant change is needed to keep it that way:
-- 0011 replaced the table-wide UPDATE grant on public.agents with a COLUMN
-- ALLOWLIST for `authenticated` (name, fallbacks, budget_tokens, budget_cents,
-- allowed_scopes), so a column added later is excluded automatically. Verified
-- against information_schema.column_privileges before writing this line.
-- service_role's grant is table-level and therefore does include them, which is
-- what the control-plane rebuild needs.
alter table public.agents
  add column if not exists budget_epoch uuid,
  add column if not exists budget_state_established_at timestamptz;

comment on column public.agents.budget_epoch is
  'Mirrors Redis epoch:<agid>. A disagreement means the hot-path budget counters were lost and the gateway must refuse rather than re-seed.';
comment on column public.agents.budget_state_established_at is
  'When budget counters were first established for this agent. NULL means never — the next budgeted call performs first-init and seeds zero.';
