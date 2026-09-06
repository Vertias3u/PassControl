-- ============================================================================
-- PassControl — make an operator's recovery of an abandoned attempt reach the
-- rebuild, without letting it be counted twice.
--
-- WHY THIS EXISTS. The rebuild recomputes an agent's spend from
-- `agent_log_spend_rows`, which reads `agent_logs`. But an attempt whose worker
-- died leaves an OPEN HOLD and no row at all, and the only way that hold ever
-- closes is an operator saying what it cost. That statement went to
-- `admin_audit` — a record of what a human did, which is not, and must not
-- become, an input to spend. So the documented recovery sequence (resolve the
-- open holds, then rebuild) recomputed spend from a ledger missing exactly the
-- charges the operator had just supplied. Both halves worked; the sequence lost
-- money. Resolving AFTER the rebuild is not an escape: the rebuild rewrites the
-- generation, and the hold is then fenced out of settlement permanently.
--
-- ── Why the charge does not simply become an agent_logs row ─────────────────
--
-- Because agent_logs is not a spend ledger, it is the gateway's own record of
-- calls it handled, and three existing invariants say so with teeth:
-- migration 0006 makes it append-only, 0026's CHECK requires every row to carry
-- a complete passport OR direct-key identity, and a test asserts lib/log.ts is
-- its ONLY application writer. An operator's recovery has no visa and no key —
-- the identity died with the worker — so it cannot honestly satisfy 0026, and
-- forcing it to would mean inventing an identity for a row in the table that
-- feeds receipts, statements and the call log. The right answer is that this is
-- a different KIND of fact: not "the gateway handled a call" but "a human
-- determined what an unrecorded attempt cost". It gets its own table.
--
-- ── Why agent_logs still gains a column ────────────────────────────────────
--
-- Some of these attempts ARE already in the ledger: a settle whose Redis write
-- was refused or rejected still writes its row and still leaves the hold open.
-- Counting both that row and the operator's adjustment is a double charge.
-- Nothing linked a row to an attempt, so nothing could tell the two cases apart.
-- `attempt_id` is that link, and the rebuild below is where it is spent: an
-- adjustment applies only to an attempt the ledger has no account of at all.
--
-- ── APPLY THIS BEFORE DEPLOYING THE CODE THAT GOES WITH IT ─────────────────
--
-- Every previous column addition here was written so that new code against an
-- older schema still wrote its audit rows — lib/log.ts omits an unknown column
-- rather than naming it, because PostgREST rejects the WHOLE insert on one it
-- does not recognise, and agent_logs writes are best-effort, so the failure is
-- silent and total. THIS ONE CANNOT DEGRADE THAT WAY. The proxy always supplies
-- `attempt_id` now, because the dedup below is worthless without it — so code
-- deployed ahead of this migration writes NO audit rows at all, on every call,
-- and the only sign is a captured error.
--
-- The resolve route degrades more kindly: its insert into a table that does not
-- exist yet fails loudly and reports `ledger_recorded: false`.
--
-- So the order is: migrate, then deploy. Not the reverse, and not concurrently.
--
-- Fully additive. One nullable column, one index, one new table, and a
-- redefined function with an UNCHANGED signature. Every existing row keeps
-- `attempt_id` NULL, and a unique index treats NULLs as distinct, so unlimited
-- historical rows coexist under it. Applying this alone moves no checkpoint.
-- ============================================================================

-- ── 1. The link ─────────────────────────────────────────────────────────────

alter table public.agent_logs
  add column if not exists attempt_id uuid;

comment on column public.agent_logs.attempt_id is
  'The budget attempt this row accounts for (lib/state/holds.ts). NULL for rows written before this column. UNIQUE so that the gateway and an operator recovery cannot both claim one attempt.';

-- Not CONCURRENTLY: the migration runner wraps each file in a transaction, and
-- CREATE INDEX CONCURRENTLY cannot run inside one. This takes a brief write lock
-- on agent_logs. If that is unacceptable at your row count, create the index by
-- hand with CONCURRENTLY first — this statement is then a no-op.
create unique index if not exists agent_logs_attempt_id_key
  on public.agent_logs (attempt_id);

-- ── 2. What a human decided about an attempt nobody logged ─────────────────

create table if not exists public.agent_spend_adjustments (
  -- The attempt IS the identity. One decision per attempt, so a retried or
  -- duplicated resolve inserts nothing the second time and cannot double-charge.
  attempt_id  uuid primary key,
  agent_id    uuid not null references public.agents(id) on delete cascade,
  user_id     uuid references public.users(id) on delete set null,
  tokens      bigint not null default 0,
  microcents  bigint not null default 0,
  created_at  timestamptz not null default now()
);

create index if not exists agent_spend_adjustments_agent_idx
  on public.agent_spend_adjustments (agent_id, created_at desc);

-- DELIBERATELY NO IMMUTABILITY TRIGGER, unlike agent_logs (migration 0006).
-- That table records what the gateway observed and may never be rewritten. This
-- one records what a person reconstructed, and until a rebuild runs it is the
-- only record of what its attempt cost — so a figure mistyped into it would be
-- permanent, and the amounts the endpoint admits leave room to be wrong by a
-- factor of ten and still be believed. Correction is the point; every version
-- of it is in admin_audit. Adding a trigger here would silently break that.

comment on table public.agent_spend_adjustments is
  'Operator-supplied cost for an attempt the gateway never logged, written by the hold-resolve route when settlement could not reach the counters. Read by rebuild_agent_spend, and only for attempts agent_log_spend_rows has no row for. Correctable in place by repeating the resolve, because a mistyped figure would otherwise be permanent; every version is in admin_audit.';

-- Service-role only: RLS enabled with NO policy denies authenticated and anon
-- entirely, and the service-role routes that read and write it bypass RLS. Same
-- posture as agent_spend_checkpoint, for the same reason — a tenant must not be
-- able to write its own spend corrections.
alter table public.agent_spend_adjustments enable row level security;
revoke all on public.agent_spend_adjustments from public, anon, authenticated;
grant all on public.agent_spend_adjustments to service_role;

-- ── 3. The spend view learns which attempt each row accounts for ───────────
--
-- Recreated rather than replaced, and `security_invoker` re-specified, because
-- 0055's own header says the invoker/RLS/SECURITY-DEFINER interaction here is
-- the reason db/tests/budget_accounting_invariants.sql exists: if it ever
-- yields zero rows the checkpoint stops advancing and NOTHING FAILS. Losing
-- that option on a redefinition would be silent.
--
-- Identical to 0055 but for the trailing column.
drop view if exists public.agent_log_spend_rows;
create view public.agent_log_spend_rows
  with (security_invoker = true) as
select
  l.agent_id,
  l.created_at,
  -- GREATEST, not COALESCE, and that change is a fix rather than a tidy-up.
  -- `enforced` answers "what was charged" and is written only when it differs
  -- from the observation, which for a real settle means it is LARGER: an
  -- uncertain dimension keeps the reserve, a cost cap charges its estimate.
  -- Smaller is a contradiction — a row cannot have observed usage that cost
  -- nothing — and COALESCE took the contradiction over the measurement, so one
  -- bad enforced zero turned a paid call into a free one. Taking the larger
  -- reads a damaged row conservatively and is identical on every honest one.
  greatest(
    coalesce(l.enforced_tokens, 0),
    coalesce(l.input_tokens, 0) + coalesce(l.output_tokens, 0)
  )::bigint as spend_tokens,
  greatest(
    coalesce(l.enforced_microcents, 0),
    coalesce(l.cost_microcents, 0)
  )::bigint as spend_microcents,
  -- New in 0056. Lets the rebuild ask what this ledger already counts FOR ONE
  -- ATTEMPT, which is the question the adjustment arithmetic below turns on.
  l.attempt_id
from public.agent_logs as l
where l.status in ('ok', 'usage_unknown');

comment on view public.agent_log_spend_rows is
  'The single definition of which agent_logs rows count toward spend and for how much. Read by reconcile_agent_spend and rebuild_agent_spend so the incremental fold and the full rebuild can never drift.';

revoke all on public.agent_log_spend_rows from public, anon, authenticated;
grant select on public.agent_log_spend_rows to service_role;

-- ── 4. The incremental fold must not re-charge what the rebuild already took ─
--
-- THE DEFECT THIS CLOSES needs no typo, no duplicate row and no status change —
-- only elapsed time. An attempt's hold is resolved while its proxy log row has
-- not landed yet, so the rebuild, seeing no ledger row, counts the operator's
-- adjustment. The row then arrives, dated after the watermark that rebuild set,
-- and the very next cron fold adds the same attempt a second time. The agent
-- exhausts its budget on spending that happened once.
--
-- The fold cannot retract what an earlier pass counted, so it subtracts instead:
-- a row whose attempt already has an adjustment contributes only the amount by
-- which the observation EXCEEDS that reconstruction, never less than zero. When
-- the two agree — the ordinary case, since the operator was reading the same
-- call — it contributes nothing. When the observation is larger the difference
-- is picked up here rather than waiting for a rebuild. When it is smaller the
-- checkpoint stays high until a rebuild lowers it, which is the direction this
-- subsystem always errs in.
--
-- This assumes the adjustment was already counted, which is true wherever it
-- matters: an adjustment is only ever written on the state-lost branch, and
-- such an agent is refused at admission until an operator rebuilds. So the
-- window in which the assumption could be false is a window in which that agent
-- cannot spend, and it closes with a rebuild that recomputes from scratch.
--
-- Signature, lag, watermark and return shape are 0055's, unchanged.
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
  insert into public.agent_spend_checkpoint (agent_id)
  select a.id
    from public.agents a
   where a.budget_tokens is not null
      or a.budget_cents is not null
  on conflict (agent_id) do nothing;

  return query
  with delta as (
    select c.agent_id as aid,
           coalesce(sum(greatest(l.spend_tokens - coalesce((
             select x.tokens from public.agent_spend_adjustments x
              where x.attempt_id = l.attempt_id
           ), 0), 0)), 0)::bigint as token_delta,
           coalesce(sum(greatest(l.spend_microcents - coalesce((
             select x.microcents from public.agent_spend_adjustments x
              where x.attempt_id = l.attempt_id
           ), 0), 0)), 0)::bigint as cost_delta
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

-- ── 5. The rebuild counts them, once ───────────────────────────────────────
--
-- Same signature, same checkpoint write, same return shape as 0055. The only
-- change is the second sum and the per-attempt test that keeps it from
-- overlapping the first. Deliberately NOT added to reconcile_agent_spend: that fold is
-- incremental behind a watermark and feeds a monotone floor which only ever
-- raises, so omitting adjustments there can under-count and never refund.
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
  v_adj_tokens bigint;
  v_adj_microcents bigint;
begin
  select coalesce(sum(l.spend_tokens), 0)::bigint,
         coalesce(sum(l.spend_microcents), 0)::bigint
    into v_tokens, v_microcents
    from public.agent_log_spend_rows l
   where l.agent_id = p_agent_id
     and l.created_at <= v_cutoff;

  -- ONLY FOR AN ATTEMPT THE GATEWAY HAS NO ACCOUNT OF. A ledger row is what the
  -- gateway OBSERVED; an adjustment is what a person RECONSTRUCTED afterwards,
  -- and it exists for one situation — an attempt that was never recorded. So an
  -- observation always wins, and no arithmetic combines the two.
  --
  -- Three rules were tried before this one, and each failed on a case the next
  -- one had to keep passing. Taking the LARGER is an upper bound rather than an
  -- account: an operator's tenfold typo, well inside what the endpoint admits,
  -- permanently overstates spend. Treating a dimension that COUNTS ZERO as
  -- silence then let a reconstruction override a genuine measurement of zero —
  -- a model-discovery GET really does cost nothing, and charging an operator's
  -- mistaken figure for it consumes budget for a free request.
  --
  -- Both of those were attempts to work around a ledger row that said zero
  -- while its own observation said otherwise. That contradiction is fixed above,
  -- in the view, where it belongs — so this can be the simple rule it should
  -- always have been.
  --
  -- Against the VIEW, not the table. A row whose status the view excludes is
  -- not an account of what an attempt cost, so it must not silence the only
  -- party that has one.
  select coalesce(sum(x.tokens), 0)::bigint,
         coalesce(sum(x.microcents), 0)::bigint
    into v_adj_tokens, v_adj_microcents
    from public.agent_spend_adjustments x
   where x.agent_id = p_agent_id
     and x.created_at <= v_cutoff
     and not exists (
       select 1 from public.agent_log_spend_rows r
        where r.attempt_id = x.attempt_id
     );

  v_tokens := v_tokens + v_adj_tokens;
  v_microcents := v_microcents + v_adj_microcents;

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
