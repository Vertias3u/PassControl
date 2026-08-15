-- ============================================================================
-- PassControl — policy shadow mode (try a rule before it bites).
--
-- An operator tightening a policy today has exactly two options: leave it alone,
-- or turn it on and find out from the agents it breaks. Shadow mode is the
-- missing third: a candidate policy that is evaluated on every real call and
-- recorded, and that decides nothing.
--
-- Two columns, both nullable with no default, so there is no backfill and every
-- existing row keeps its meaning:
--
--   agents.policy_shadow           null = shadow mode is off for this agent
--   agent_logs.policy_shadow_would null = no shadow policy was evaluated
--
-- No `grant update` on either, and that is a decision rather than an omission.
-- Migration 0011 replaced the table-wide `authenticated` UPDATE with a column
-- allowlist because RLS confines a user to their own row but does not stop them
-- PATCHing any column of it through PostgREST. So a column is writable by the
-- dashboard's authenticated client only if it is named in that allowlist. This
-- one is deliberately not: like 0014's `policy` and unlike 0018's `fallbacks`,
-- the write path is a validated server action on the service-role client. A
-- tenant who could PATCH this column directly would bypass validatePolicy — and
-- while a malformed shadow policy is inert by design, "inert by design" is a
-- property of the read path, not a licence to let anything into the column.
--
-- agent_logs is append-only from 0006, so the shadow verdict is written once by
-- the same insert that writes the call and is never updated afterwards.
--
-- Worth being exact about HOW, because the grant table reads alarmingly here and
-- the wrong reading leads somewhere bad. `has_column_privilege(authenticated,
-- 'policy_shadow_would', 'UPDATE')` returns true — as it does for `status`,
-- `model` and every other column on this table, and has since 0001. The grants
-- on agent_logs are wide; they are not what holds the line. Two other things do:
-- RLS on agent_logs carries a SELECT policy and no UPDATE policy at all, so an
-- UPDATE by `authenticated` matches no rows, and the `agent_logs_no_mutate`
-- trigger from 0006 raises if one ever did. Checked on 2026-08-07 by PATCHing
-- this column through PostgREST with a real signed-in session: 204, and 0 of 20
-- rows changed. The temptation this note exists to head off is "adding a column
-- grant here would be harmless because the grants are already wide" — the
-- grants are wide, and the column allowlist on `agents` from 0011 is what stops
-- that being true over there.
-- ============================================================================

alter table public.agents
  add column policy_shadow jsonb;

comment on column public.agents.policy_shadow is
  'Candidate policy evaluated alongside the live one on every call and recorded in agent_logs.policy_shadow_would. Decides nothing: it can neither allow a call the live policy denies nor deny one it allows. NULL means shadow mode is off.';

alter table public.agent_logs
  add column policy_shadow_would text;

comment on column public.agent_logs.policy_shadow_would is
  'What the shadow policy would have decided for this call ("allow" / "deny:policy"), or NULL when no shadow policy was configured or the evaluation did not complete. A floor, not a census: writeLog is best-effort, so a database blip loses the row and this verdict with it.';
