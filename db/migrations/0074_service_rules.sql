-- ============================================================================
-- PassControl — service rules and service call rows (any-API, phase 1).
--
-- ── What this adds ────────────────────────────────────────────────────────
--
-- An agent can now call a non-LLM API (GitHub first) through the gateway, with
-- the tenant's token injected from Vault the way a provider key is. Three
-- columns, all nullable, nothing backfilled:
--
--   1. agents.service_rules — which service calls the agent may make, per
--      service: method + path allow rules and an hourly call cap. Read LIVE by
--      the gateway on every service call (never snapshotted into a visa), and
--      re-validated there on every read: the check below only guarantees the
--      shape is an object. Anything the gateway cannot read or validate denies
--      that service — a service rule read FAILS CLOSED on every deployment
--      (plans/any-api-credentials.md, threat T11).
--
--   2. agent_logs.call_kind — NULL for every LLM call, which is every row
--      written before this migration and every row an older build writes;
--      'service' for a service call. 0006 refuses UPDATE on agent_logs, so this
--      can never be backfilled, and NULL must keep meaning "LLM".
--
--   3. agent_logs.endpoint — for a service call, the TEMPLATE of the rule that
--      admitted it (e.g. `GET /repos/acme/*/issues`), not the raw path: the log
--      stays readable, and repository names are not stored a second time. The
--      raw path is in the signed receipt, which only the tenant is handed.
--
-- ── Grants ────────────────────────────────────────────────────────────────
--
-- None added, on purpose. `authenticated` holds table-level SELECT on both
-- tables, which covers new columns. Its UPDATE on agents is column-level
-- (0011, 0018, 0073) and does not include `policy`; `service_rules` follows
-- `policy`, not the budget columns: it is written only by a server action that
-- validates it and requires MFA step-up, so a tenant session cannot PATCH it
-- directly. The gateway validates on read regardless.
--
-- Additive. Old code ignores all three columns.
-- ============================================================================

alter table public.agents
  add column if not exists service_rules jsonb;

alter table public.agents
  drop constraint if exists agents_service_rules_object,
  add constraint agents_service_rules_object
    check (service_rules is null or jsonb_typeof(service_rules) = 'object'),
  -- A bound, not a format. 200 rules of 32 segments fit well inside it.
  drop constraint if exists agents_service_rules_size,
  add constraint agents_service_rules_size
    check (service_rules is null or pg_column_size(service_rules) <= 262144);

comment on column public.agents.service_rules is
  'Per-service call rules for non-LLM APIs: {"<service>": {"allow": [{"method": "GET", "path": "/repos/acme/*/issues"}], "max_requests_per_hour": 200}}. Deny by default. Read live and re-validated by the gateway on every service call; unreadable or invalid denies that service (lib/services/rules.ts).';

alter table public.agent_logs
  add column if not exists call_kind text,
  add column if not exists endpoint text;

alter table public.agent_logs
  drop constraint if exists agent_logs_call_kind_known,
  add constraint agent_logs_call_kind_known
    check (call_kind is null or call_kind = 'service'),
  drop constraint if exists agent_logs_endpoint_size,
  add constraint agent_logs_endpoint_size
    check (endpoint is null or char_length(endpoint) <= 10000);

comment on column public.agent_logs.call_kind is
  'NULL = an LLM call (every row before 0074). service = a call to a non-LLM API through the service route.';
comment on column public.agent_logs.endpoint is
  'Service calls only: METHOD plus the template of the rule that admitted the call (e.g. GET /repos/acme/*/issues). NULL when no rule matched. The raw path is signed into the receipt.';
