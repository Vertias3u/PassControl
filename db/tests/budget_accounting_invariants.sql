-- Budget accounting invariants (migration 0055).
--
-- THE FIRST ASSERTION IS THE REASON THIS FILE EXISTS, and it is not the obvious
-- one. `reconcile_agent_spend` is SECURITY DEFINER with `search_path = ''` and
-- now reads a view declared `security_invoker = true`, over an RLS-enabled
-- table. If that interaction ever yields zero rows, the checkpoint silently
-- stops advancing — and NOTHING FAILS. The cron still returns ok, still reports
-- a count of agents, still writes to Redis. The monotone raise in
-- lib/reconcile.ts then never fires, and the only symptom is that authoritative
-- spend quietly stops tracking reality.
--
-- Asserting that the function RUNS proves nothing: it returns one row per
-- budgeted agent whether or not the view gave it any amounts. So this asserts
-- the AMOUNTS arrive, through the real function, from a row it had to read
-- across that boundary.
--
-- Run: DATABASE_URL=… npm run test:budget-db

begin;

do $$
declare
  test_user      constant uuid := '7c2e9a41-0000-4000-8000-0000000000b1';
  agent_boundary constant uuid := '7c2e9a41-0000-4000-8000-0000000000b2';
  agent_enforced constant uuid := '7c2e9a41-0000-4000-8000-0000000000b3';
  agent_unpriced constant uuid := '7c2e9a41-0000-4000-8000-0000000000b4';
  agent_excluded constant uuid := '7c2e9a41-0000-4000-8000-0000000000b5';
  agent_empty    constant uuid := '7c2e9a41-0000-4000-8000-0000000000b6';

  -- Placed comfortably in the past so every cutoff below includes them, and so
  -- the half-open `created_at > reconciled_at` comparison against the epoch
  -- default is never the thing under test here.
  t0 constant timestamptz := now() - interval '3 hours';

  definition record;
  explanation record;
  folded record;
  rebuilt record;
  watermark timestamptz;
  seen bigint;
begin
  -- ── Posture, before any data ───────────────────────────────────────────────
  -- to_regclass, not a ::regclass cast: the cast RAISES on a missing relation,
  -- which would replace this file's one useful diagnostic with a parse error.
  if to_regclass('public.agent_log_spend_rows') is null then
    raise exception 'agent_log_spend_rows is missing — migration 0055 has not been applied';
  end if;
  if to_regclass('public.agent_spend_checkpoint') is null then
    raise exception 'agent_spend_checkpoint is missing — the schema predates migration 0010';
  end if;

  -- security_invoker is what keeps the view a named expression rather than a new
  -- privilege over agent_logs. A view that lost it would read as its owner and
  -- hand every caller the whole audit table.
  if not exists (
    select 1 from pg_class
     where oid = 'public.agent_log_spend_rows'::regclass
       and 'security_invoker=true' = any (reloptions)
  ) then
    raise exception 'agent_log_spend_rows must be security_invoker = true';
  end if;

  if has_table_privilege('anon', 'public.agent_log_spend_rows', 'select')
     or has_table_privilege('authenticated', 'public.agent_log_spend_rows', 'select') then
    raise exception 'agent_log_spend_rows must not be readable by anon or authenticated';
  end if;
  if not has_table_privilege('service_role', 'public.agent_log_spend_rows', 'select') then
    raise exception 'service_role must read agent_log_spend_rows';
  end if;

  select p.prosecdef, coalesce(array_to_string(p.proconfig, ','), '') as cfg into definition
    from pg_proc as p where p.oid = 'public.rebuild_agent_spend(uuid)'::regprocedure;
  if not definition.prosecdef or definition.cfg not like '%search_path=%' then
    raise exception 'rebuild_agent_spend must be security definer with a pinned search_path';
  end if;

  -- rebuild_agent_spend is the ONLY sanctioned lowering of a spend total in the
  -- product. A tenant-facing role that could call it could zero its own cap.
  if has_function_privilege('anon', 'public.rebuild_agent_spend(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.rebuild_agent_spend(uuid)', 'execute') then
    raise exception 'rebuild_agent_spend must be service_role only';
  end if;
  if not has_function_privilege('service_role', 'public.rebuild_agent_spend(uuid)', 'execute') then
    raise exception 'service_role must execute rebuild_agent_spend';
  end if;
  if to_regprocedure('public.explain_workspace_spend(uuid)') is null then
    raise exception 'explain_workspace_spend is missing — migration 0070 has not been applied';
  end if;
  if has_function_privilege('anon', 'public.explain_workspace_spend(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.explain_workspace_spend(uuid)', 'execute') then
    raise exception 'explain_workspace_spend must be service_role only';
  end if;
  if not has_function_privilege('service_role', 'public.explain_workspace_spend(uuid)', 'execute') then
    raise exception 'service_role must execute explain_workspace_spend';
  end if;
  if has_function_privilege('anon', 'public.reconcile_agent_spend(int)', 'execute')
     or has_function_privilege('authenticated', 'public.reconcile_agent_spend(int)', 'execute') then
    raise exception 'reconcile_agent_spend must be service_role only';
  end if;

  -- The budget-state columns decide whether the gateway trusts its own counters.
  -- 0011 left `authenticated` a COLUMN ALLOWLIST on public.agents, so a column
  -- added later is excluded automatically — this asserts that still held, rather
  -- than assuming it, because the failure is an agent editing away the evidence
  -- that its counters were ever established.
  if has_column_privilege('authenticated', 'public.agents', 'budget_epoch', 'update')
     or has_column_privilege('authenticated', 'public.agents', 'budget_state_established_at', 'update') then
    raise exception 'authenticated must not write the budget-state columns';
  end if;

  -- ── Fixtures ───────────────────────────────────────────────────────────────
  --
  -- EVERY ROW IS INSERTED BEFORE THE SINGLE FOLD BELOW, and each concern gets
  -- its own agent. That shape is forced by what is under test: the fold is
  -- INCREMENTAL, so a second call only sees rows created after the watermark the
  -- first call set. Backdating rows and folding twice reads as a bug in the view
  -- when it is the fold working exactly as designed — the first draft of this
  -- file did precisely that and blamed the wrong component.
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
  values (test_user, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'budget-accounting-invariants@example.invalid', 'x', now(), now());
  insert into public.users (id, email) values (test_user, 'budget-accounting-invariants@example.invalid');

  insert into public.agents (id, user_id, name, budget_tokens) values
    (agent_boundary, test_user, 'budget-boundary',  1000000),
    (agent_enforced, test_user, 'budget-enforced',  1000000),
    (agent_unpriced, test_user, 'budget-unpriced',  1000000),
    (agent_excluded, test_user, 'budget-excluded',  1000000);
  -- Budgeted on COST only, and deliberately given no rows at all: reconcile must
  -- still return it, at zero, rather than skipping it. The marker sweep this
  -- work deletes had exactly this hole in the other direction — it only ever
  -- swept agents the RPC had returned.
  insert into public.agents (id, user_id, name, budget_cents)
  values (agent_empty, test_user, 'budget-empty', 500);

  -- The boundary agent: one ordinary settled call.
  insert into public.agent_logs (user_id, agent_id, status, created_at, input_tokens, output_tokens, cost_microcents, passport_id, jti)
  values (test_user, agent_boundary, 'ok', t0, 30, 70, 1200, 'cGFzc3BvcnQtYg', 'visa-b1');

  -- The enforced agent: one ordinary call, plus one whose usage nobody could
  -- confirm. The second was charged at its estimate in Redis.
  insert into public.agent_logs (user_id, agent_id, status, created_at, input_tokens, output_tokens, cost_microcents, passport_id, jti)
  values (test_user, agent_enforced, 'ok', t0, 30, 70, 1200, 'cGFzc3BvcnQtYg', 'visa-e1');
  insert into public.agent_logs (user_id, agent_id, status, created_at, input_tokens, output_tokens, cost_microcents, enforced_tokens, enforced_microcents, passport_id, jti)
  values (test_user, agent_enforced, 'usage_unknown', t0 + interval '1 minute', 10, 30, 90, 1200, 4000, 'cGFzc3BvcnQtYg', 'visa-e2');

  -- The unpriced agent: a custom endpoint nobody could price. cost_microcents
  -- stays NULL and `unpriced` stays true — the row is unchanged in what it
  -- OBSERVES — while enforced_microcents records what the cost cap was actually
  -- charged. Before this column a cost cap never advanced on such a call at all.
  insert into public.agent_logs (user_id, agent_id, status, created_at, input_tokens, output_tokens, cost_microcents, unpriced, enforced_microcents, passport_id, jti)
  values (test_user, agent_unpriced, 'ok', t0, 5, 5, null, true, 700, 'cGFzc3BvcnQtYg', 'visa-u1');

  -- The excluded agent: statuses that must contribute nothing. Given absurd
  -- figures so that counting them would be unmissable rather than plausible.
  insert into public.agent_logs (user_id, agent_id, status, created_at, input_tokens, output_tokens, cost_microcents, passport_id, jti)
  values (test_user, agent_excluded, 'upstream_error', t0, 999, 999, 99999, 'cGFzc3BvcnQtYg', 'visa-x1');
  insert into public.agent_logs (user_id, agent_id, status, created_at, input_tokens, output_tokens, cost_microcents, passport_id, jti)
  values (test_user, agent_excluded, 'blocked_budget', t0 + interval '1 minute', 0, 0, null, 'cGFzc3BvcnQtYg', 'visa-x2');
  insert into public.agent_logs (user_id, agent_id, status, created_at, input_tokens, output_tokens, cost_microcents, passport_id, jti)
  values (test_user, agent_excluded, 'provider_exhausted', t0 + interval '2 minutes', 7, 7, 77, 'cGFzc3BvcnQtYg', 'visa-x3');

  -- ── ONE fold, captured. Everything below reads this. ──────────────────────
  create temporary table _pc_fold on commit drop as
    select * from public.reconcile_agent_spend(0);

  -- ── 1. THE BOUNDARY: amounts must cross security_invoker → security definer ─
  --
  -- Asserting the function RETURNED A ROW proves nothing — it returns one per
  -- budgeted agent whether or not the view gave it any amounts. The AMOUNT is
  -- the assertion.
  select f.spent_tokens, f.spent_microcents into folded
    from _pc_fold f where f.agent_id = agent_boundary;

  if folded.spent_tokens is null then
    raise exception 'reconcile_agent_spend returned no row for a budgeted agent';
  end if;
  if folded.spent_tokens <> 100 or folded.spent_microcents <> 1200 then
    raise exception
      'THE VIEW IS INVISIBLE INSIDE THE DEFINER FUNCTION: folded % tokens / % microcents, expected 100 / 1200. '
      'agent_log_spend_rows is security_invoker = true and reconcile_agent_spend is security definer with search_path = '''' — '
      'if the function owner stopped owning agent_logs, lost BYPASSRLS, or agent_logs gained FORCE row security, '
      'the checkpoint stops advancing and NOTHING ELSE FAILS.',
      folded.spent_tokens, folded.spent_microcents;
  end if;

  -- The watermark moved, which is what makes the fold incremental rather than a
  -- repeated full scan.
  select c.reconciled_at into watermark
    from public.agent_spend_checkpoint c where c.agent_id = agent_boundary;
  if watermark <= 'epoch'::timestamptz then
    raise exception 'reconcile_agent_spend did not advance the watermark';
  end if;

  -- ── 2. usage_unknown counts, at its ENFORCED figure ───────────────────────
  --
  -- This is the reason the migration exists. An attempt whose usage nobody could
  -- confirm is charged in Redis at its estimate; if the checkpoint did not count
  -- it, the next cron run would fold a total that omits it and hand the capacity
  -- straight back. Fixing settlement idempotence alone leaves the cron refunding.
  select f.spent_tokens, f.spent_microcents into folded
    from _pc_fold f where f.agent_id = agent_enforced;

  -- 100 + 1200, not 100 + 40: the enforced figure wins over the observed one.
  -- Likewise 1200 + 4000, not 1200 + 90.
  if folded.spent_tokens <> 1300 then
    raise exception 'expected the enforced token figure to win (1300), folded %', folded.spent_tokens;
  end if;
  if folded.spent_microcents <> 5200 then
    raise exception 'expected the enforced cost figure to win (5200), folded %', folded.spent_microcents;
  end if;

  -- ── 3. An unpriced call still moves a cost cap ────────────────────────────
  select f.spent_microcents into seen
    from _pc_fold f where f.agent_id = agent_unpriced;
  if seen <> 700 then
    raise exception 'an unpriced call with an enforced cost must advance the cost total to 700, got %', seen;
  end if;
  -- And its OBSERVED cost is still absent, because nobody could price it. The
  -- enforced column must never be mistaken for a correction of the row.
  if exists (
    select 1 from public.agent_logs l
     where l.agent_id = agent_unpriced and l.cost_microcents is not null
  ) then
    raise exception 'the unpriced row must keep cost_microcents null — enforced_* records enforcement, not a price';
  end if;

  -- ── 4. NO RETROACTIVE STEP CHANGE ─────────────────────────────────────────
  --
  -- `upstream_error` is deliberately NOT admitted, and a new status was added
  -- rather than widening it. Widening would make a rebuild count historical
  -- error rows no checkpoint ever saw, and rebuild and fold would part company
  -- at the first recovery an operator ever ran.
  select f.spent_tokens, f.spent_microcents into folded
    from _pc_fold f where f.agent_id = agent_excluded;
  if folded.spent_tokens <> 0 or folded.spent_microcents <> 0 then
    raise exception
      'RETROACTIVE STEP CHANGE: an agent with only upstream_error / blocked_budget / provider_exhausted rows folded % / %, expected 0 / 0',
      folded.spent_tokens, folded.spent_microcents;
  end if;
  select count(*) into seen
    from public.agent_log_spend_rows l where l.agent_id = agent_excluded;
  if seen <> 0 then
    raise exception 'only ok and usage_unknown rows may reach the spend view, it returned % for the excluded agent', seen;
  end if;

  -- ── 5. A budgeted agent with no calls reconciles to zero, not to nothing ──
  select f.spent_tokens into seen
    from _pc_fold f where f.agent_id = agent_empty;
  if seen is distinct from 0::bigint then
    raise exception 'a cost-budgeted agent with no rows must reconcile to 0, got %', seen;
  end if;

  -- ── 6. Rebuild and the incremental fold agree ─────────────────────────────
  --
  -- The whole reason both read one view. They are computed differently — a full
  -- sum against an accumulated delta — so equality here is a real check rather
  -- than a tautology.
  select b.spent_tokens, b.spent_microcents into rebuilt
    from public.rebuild_agent_spend(agent_enforced) as b;
  select f.spent_tokens, f.spent_microcents into folded
    from _pc_fold f where f.agent_id = agent_enforced;

  if rebuilt.spent_tokens <> folded.spent_tokens
     or rebuilt.spent_microcents <> folded.spent_microcents then
    raise exception
      'REBUILD AND FOLD DISAGREE: rebuild says % / %, the incremental checkpoint says % / %. '
      'Both read public.agent_log_spend_rows; if they differ, one of them has stopped.',
      rebuilt.spent_tokens, rebuilt.spent_microcents, folded.spent_tokens, folded.spent_microcents;
  end if;

  -- Rebuild WRITES the checkpoint — it is the authority, not a report.
  select c.spent_tokens into seen
    from public.agent_spend_checkpoint c where c.agent_id = agent_enforced;
  if seen <> rebuilt.spent_tokens then
    raise exception 'rebuild_agent_spend must persist its total, checkpoint holds % not %', seen, rebuilt.spent_tokens;
  end if;

  -- And it must leave the watermark somewhere a following fold adds nothing, or
  -- an operator recovery would be immediately followed by a double count.
  select r.spent_tokens into seen
    from public.reconcile_agent_spend(0) as r where r.agent_id = agent_enforced;
  if seen <> rebuilt.spent_tokens then
    raise exception 'a fold immediately after a rebuild must be a no-op, it moved % to %', rebuilt.spent_tokens, seen;
  end if;

  -- ── 7. Rebuild is idempotent ──────────────────────────────────────────────
  -- docs/budget-recovery.md tells an operator a rebuild is safe to re-run. That has
  -- to be true: they WILL run it twice, because a rebuild is what they reach for
  -- when they have stopped trusting anything, including the first rebuild.
  select b.spent_tokens into seen from public.rebuild_agent_spend(agent_enforced) as b;
  if seen <> rebuilt.spent_tokens then
    raise exception 'rebuild_agent_spend is not idempotent: % then %', rebuilt.spent_tokens, seen;
  end if;
  -- ── 8. Operator adjustments reach the rebuild, exactly once (0056) ────────
  -- The defect this closes: an attempt whose worker died leaves an open hold and
  -- NO agent_logs row, so the operator's resolution was the only record of what
  -- it cost — and it went to admin_audit, which the rebuild does not read. The
  -- documented sequence (resolve the holds, then rebuild) therefore recomputed
  -- spend without the charges the operator had just supplied.
  declare
    attempt_orphan constant uuid := '7c2e9a41-0000-4000-8000-0000000000c1';
    attempt_logged constant uuid := '7c2e9a41-0000-4000-8000-0000000000c2';
    before_adj bigint;
  begin
    select b.spent_tokens into before_adj from public.rebuild_agent_spend(agent_boundary) as b;

    insert into public.agent_spend_adjustments (attempt_id, agent_id, user_id, tokens, microcents)
    values (attempt_orphan, agent_boundary, test_user, 500, 600);

    select b.spent_tokens into seen from public.rebuild_agent_spend(agent_boundary) as b;
    if seen <> before_adj + 500 then
      raise exception 'an adjustment for an unlogged attempt must be counted: % then %', before_adj, seen;
    end if;

    -- THE OTHER HALF: an attempt the ledger ALREADY accounts for. Two accounts
    -- of one spend exist, and the question is which is true — not how to
    -- combine them.
    --
    -- This assertion has been written three ways and the number has been 100
    -- twice, for DIFFERENT reasons, which is worth stating so it does not read
    -- as drift. First: exclude the adjustment because a row is PRESENT — wrong,
    -- because a row that counts nothing then erased the operator's figure.
    -- Second: take the LARGER — wrong, because that is an upper bound rather
    -- than an account, and an operator's tenfold typo (admissible: the endpoint
    -- caps at 100M tokens) permanently overstates spend and exhausts the budget
    -- early. Now: the ledger row is what the gateway OBSERVED and the
    -- adjustment is what a person RECONSTRUCTED, so the observation wins
    -- wherever there is one, and the reconstruction applies only where the
    -- ledger is silent — which the zero-row case below still exercises.
    --
    -- So the ledger's 100 observed tokens beat an operator's 9999.
    insert into public.agent_logs (user_id, agent_id, status, created_at, input_tokens, output_tokens, cost_microcents, passport_id, jti, attempt_id)
    values (test_user, agent_boundary, 'ok', t0, 40, 60, 800, 'cGFzc3BvcnQtYg', 'visa-b2', attempt_logged);
    insert into public.agent_spend_adjustments (attempt_id, agent_id, user_id, tokens, microcents)
    values (attempt_logged, agent_boundary, test_user, 9999, 9999);

    select b.spent_tokens into seen from public.rebuild_agent_spend(agent_boundary) as b;
    if seen <> before_adj + 500 + 100 then
      raise exception 'an observed ledger row must outrank a reconstructed adjustment: expected %, got %', before_adj + 500 + 100, seen;
    end if;

    -- And the link the exclusion above depends on is enforced, so two rows can
    -- never claim one attempt and make that NOT EXISTS decide the wrong way.
    begin
      insert into public.agent_logs (user_id, agent_id, status, created_at, input_tokens, output_tokens, cost_microcents, passport_id, jti, attempt_id)
      values (test_user, agent_boundary, 'ok', t0, 1, 1, 1, 'cGFzc3BvcnQtYg', 'visa-b3', attempt_logged);
      raise exception 'agent_logs.attempt_id must be UNIQUE — a second row claimed one attempt';
    exception when unique_violation then
      null;
    end;
  end;

  -- Session 02 part 3: a refused proxy settle can leave an observed paid call
  -- with enforced zero. Presence of that row must not erase the operator's
  -- separately recorded amount. This tests the SQL consequence independently
  -- of whether a particular epoch-conflicted hold is recoverable by the API.
  declare
    zero_attempt constant uuid := '7c2e9a41-0000-4000-8000-0000000000c3';
  begin
    insert into public.agent_logs
      (user_id, agent_id, status, created_at, input_tokens, output_tokens,
       cost_microcents, enforced_tokens, enforced_microcents, passport_id, jti, attempt_id)
    values (test_user, agent_empty, 'ok', t0, 40, 60, 800, 0, 0,
            'cGFzc3BvcnQtYg', 'visa-zero-refused', zero_attempt);
    insert into public.agent_spend_adjustments (attempt_id, agent_id, user_id, tokens, microcents)
    values (zero_attempt, agent_empty, test_user, 100, 800);
    select * into rebuilt from public.rebuild_agent_spend(agent_empty);
    if rebuilt.spent_tokens <> 100 or rebuilt.spent_microcents <> 800 then
      raise exception 'zero proxy row erased operator charge: expected 100/800, got %/%',
        rebuilt.spent_tokens, rebuilt.spent_microcents;
    end if;
  end;

  -- Session 02 part 4: max is an upper bound, not a truth discriminator.
  -- The proxy logged definitive provider usage after a transport failure kept
  -- settlement from executing. Later, partial counter loss makes an operator
  -- resolve degraded. The operator mistypes both amounts by ten times, within
  -- the endpoint limits. Companion TS/real-Redis tests pin those transitions.
  -- This deliberately tests the exact-spend claim, not an unconditional rule
  -- preferring the log: the preceding zero-log regression must still hold.
  declare
    typo_agent constant uuid := '7c2e9a41-0000-4000-8000-0000000000d1';
    typo_attempt constant uuid := '7c2e9a41-0000-4000-8000-0000000000d2';
  begin
    insert into public.agents (id, user_id, name, budget_tokens)
    values (typo_agent, test_user, 'operator-overstatement', 1000000);
    insert into public.agent_logs
      (user_id, agent_id, status, created_at, input_tokens, output_tokens,
       cost_microcents, passport_id, jti, attempt_id)
    values (test_user, typo_agent, 'ok', t0, 19000, 412, 2156000,
            'cGFzc3BvcnQtYg', 'visa-truthful-before-recovery', typo_attempt);
    insert into public.agent_spend_adjustments
      (attempt_id, agent_id, user_id, tokens, microcents)
    values (typo_attempt, typo_agent, test_user, 194120, 21560000);
    select * into rebuilt from public.rebuild_agent_spend(typo_agent);
    if rebuilt.spent_tokens <> 19412 or rebuilt.spent_microcents <> 2156000 then
      raise exception 'operator typo overrides truthful ledger: expected 19412/2156000, got %/%',
        rebuilt.spent_tokens, rebuilt.spent_microcents;
    end if;
  end;

  -- Session 02 part 5: discovery GET is a complete observation of zero,
  -- unlike part 3's paid call whose refused settle wrote an enforced zero.
  -- Settlement transport can fail before execution while this row still lands;
  -- the open hold can then be resolved after partial counter loss. The operator
  -- mistakenly supplies nonzero usage. Observation must still outrank that
  -- reconstruction. The companion proxy test proves this is a real row shape.
  declare
    discovery_agent constant uuid := '7c2e9a41-0000-4000-8000-0000000000e1';
    discovery_attempt constant uuid := '7c2e9a41-0000-4000-8000-0000000000e2';
  begin
    insert into public.agents (id, user_id, name, budget_tokens)
    values (discovery_agent, test_user, 'genuine-zero-discovery', 1000000);
    insert into public.agent_logs
      (user_id, agent_id, status, created_at, input_tokens, output_tokens,
       cost_microcents, passport_id, jti, attempt_id)
    values (test_user, discovery_agent, 'ok', t0, 0, 0, 0,
            'cGFzc3BvcnQtYg', 'visa-genuine-zero-discovery', discovery_attempt);
    insert into public.agent_spend_adjustments
      (attempt_id, agent_id, user_id, tokens, microcents)
    values (discovery_attempt, discovery_agent, test_user, 100, 800);
    select * into rebuilt from public.rebuild_agent_spend(discovery_agent);
    if rebuilt.spent_tokens <> 0 or rebuilt.spent_microcents <> 0 then
      raise exception 'genuine zero observation overridden: expected 0/0, got %/%',
        rebuilt.spent_tokens, rebuilt.spent_microcents;
    end if;
  end;

  -- ── 9. A row that does not count is not an account (0056) ────────────────
  -- The adjustment is excluded by the presence of a row in the VIEW, not in the
  -- table, and this is the difference. An attempt that ended in upstream_error
  -- has an agent_logs row, but the view excludes that status, so the gateway
  -- has no account of what it cost. Excluding on the table would let that row
  -- silence the only party who does have one.
  declare
    excluded_agent   constant uuid := '7c2e9a41-0000-4000-8000-0000000000f1';
    excluded_attempt constant uuid := '7c2e9a41-0000-4000-8000-0000000000f2';
  begin
    insert into public.agents (id, user_id, name, budget_tokens)
    values (excluded_agent, test_user, 'uncounted-row', 1000000);
    insert into public.agent_logs
      (user_id, agent_id, status, created_at, input_tokens, output_tokens,
       cost_microcents, passport_id, jti, attempt_id)
    values (test_user, excluded_agent, 'upstream_error', t0, 0, 0, null,
            'cGFzc3BvcnQtYg', 'visa-uncounted', excluded_attempt);
    insert into public.agent_spend_adjustments (attempt_id, agent_id, user_id, tokens, microcents)
    values (excluded_attempt, excluded_agent, test_user, 250, 900);

    select * into rebuilt from public.rebuild_agent_spend(excluded_agent);
    if rebuilt.spent_tokens <> 250 or rebuilt.spent_microcents <> 900 then
      raise exception 'a row the view excludes must not silence an adjustment: expected 250/900, got %/%',
        rebuilt.spent_tokens, rebuilt.spent_microcents;
    end if;
  end;

  -- Session 02 part 6: a delayed proxy insert must not charge an attempt
  -- whose adjustment has ALREADY been incorporated by rebuild. No status
  -- change or duplicate row is needed: the countable row simply arrives later.
  declare
    late_agent constant uuid := '7c2e9a41-0000-4000-8000-000000000101';
    late_attempt constant uuid := '7c2e9a41-0000-4000-8000-000000000102';
  begin
    insert into public.agents (id, user_id, name, budget_tokens)
    values (late_agent, test_user, 'late-ledger-after-rebuild', 1000000);
    insert into public.agent_spend_adjustments
      (attempt_id, agent_id, user_id, tokens, microcents, created_at)
    values (late_attempt, late_agent, test_user, 250, 900, t0);
    select * into rebuilt from public.rebuild_agent_spend(late_agent);
    if rebuilt.spent_tokens <> 250 or rebuilt.spent_microcents <> 900 then
      raise exception 'late-row setup: orphan rebuild must count 250/900';
    end if;

    -- now() is fixed for this rollback-only test transaction. Move only this
    -- fixture's watermark into the past to model the elapsed time between the
    -- completed rebuild and a later insert/cron. Keep its real rebuilt amounts.
    update public.agent_spend_checkpoint
       set reconciled_at = now() - interval '2 minutes'
     where agent_id = late_agent;
    insert into public.agent_logs
      (user_id, agent_id, status, created_at, input_tokens, output_tokens,
       cost_microcents, passport_id, jti, attempt_id)
    values (test_user, late_agent, 'ok', now() - interval '1 minute',
            200, 50, 900, 'cGFzc3BvcnQtYg', 'visa-late-ledger', late_attempt);

    select * into folded from public.reconcile_agent_spend(0) r
      where r.agent_id = late_agent;
    if folded.spent_tokens <> 250 or folded.spent_microcents <> 900 then
      raise exception 'late ledger double charged rebuilt adjustment: expected 250/900, got %/%',
        folded.spent_tokens, folded.spent_microcents;
    end if;
  end;

  -- ── 11. The fold subtracts, it does not skip ─────────────────────────────
  -- Section 10's delayed row happened to match the operator's figure exactly,
  -- so "contribute nothing" and "contribute the excess" are indistinguishable
  -- there. They are not the same rule. When the observation is LARGER than the
  -- reconstruction it replaces, the difference is real spend and the fold is
  -- the only thing that will see it before somebody runs another rebuild.
  declare
    under_agent   constant uuid := '7c2e9a41-0000-4000-8000-000000000111';
    under_attempt constant uuid := '7c2e9a41-0000-4000-8000-000000000112';
  begin
    insert into public.agents (id, user_id, name, budget_tokens)
    values (under_agent, test_user, 'operator-understated', 1000000);
    insert into public.agent_spend_adjustments
      (attempt_id, agent_id, user_id, tokens, microcents, created_at)
    values (under_attempt, under_agent, test_user, 250, 900, t0);
    select * into rebuilt from public.rebuild_agent_spend(under_agent);
    if rebuilt.spent_tokens <> 250 then
      raise exception 'understated setup: orphan rebuild must count 250';
    end if;

    update public.agent_spend_checkpoint
       set reconciled_at = now() - interval '2 minutes'
     where agent_id = under_agent;
    -- The call really cost 400 tokens / 1500 microcents; the operator recorded
    -- 250 / 900 from what they could see at the time.
    insert into public.agent_logs
      (user_id, agent_id, status, created_at, input_tokens, output_tokens,
       cost_microcents, passport_id, jti, attempt_id)
    values (test_user, under_agent, 'ok', now() - interval '1 minute',
            300, 100, 1500, 'cGFzc3BvcnQtYg', 'visa-understated', under_attempt);

    select * into folded from public.reconcile_agent_spend(0) r
      where r.agent_id = under_agent;
    if folded.spent_tokens <> 400 or folded.spent_microcents <> 1500 then
      raise exception 'the fold must add the excess of observation over reconstruction: expected 400/1500, got %/%',
        folded.spent_tokens, folded.spent_microcents;
    end if;
  end;

  -- ── 12. The read-only explanation is exactly the rebuild ledger ──────────
  -- This spans the fixtures above: confirmed calls, conservative unknown
  -- usage, excluded statuses, an orphan adjustment, and adjustments shadowed
  -- by a durable row. The public function must expose their arithmetic without
  -- widening the spend statuses or counting an attempt twice.
  select * into explanation from public.explain_workspace_spend(test_user);
  if explanation.log_tokens <> (
       select coalesce(sum(r.spend_tokens), 0)::bigint
         from public.agent_log_spend_rows r
         join public.agents a on a.id = r.agent_id
        where a.user_id = test_user
     )
     or explanation.log_microcents <> (
       select coalesce(sum(r.spend_microcents), 0)::bigint
         from public.agent_log_spend_rows r
         join public.agents a on a.id = r.agent_id
        where a.user_id = test_user
     ) then
    raise exception 'workspace explanation log arithmetic diverged from agent_log_spend_rows';
  end if;
  if explanation.adjustment_tokens <> (
       select coalesce(sum(x.tokens), 0)::bigint
         from public.agent_spend_adjustments x
         join public.agents a on a.id = x.agent_id
        where a.user_id = test_user
          and not exists (
            select 1 from public.agent_log_spend_rows r where r.attempt_id = x.attempt_id
          )
     )
     or explanation.adjustment_microcents <> (
       select coalesce(sum(x.microcents), 0)::bigint
         from public.agent_spend_adjustments x
         join public.agents a on a.id = x.agent_id
        where a.user_id = test_user
          and not exists (
            select 1 from public.agent_log_spend_rows r where r.attempt_id = x.attempt_id
          )
     ) then
    raise exception 'workspace explanation adjustment precedence diverged from rebuild_agent_spend';
  end if;
  if explanation.attributable_tokens <> explanation.log_tokens + explanation.adjustment_tokens
     or explanation.attributable_microcents <> explanation.log_microcents + explanation.adjustment_microcents then
    raise exception 'workspace explanation equation does not add up';
  end if;

  raise notice 'Budget accounting invariants: PASS';
end;
$$;

rollback;
