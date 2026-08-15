-- ============================================================================
-- PassControl — per-agent provider fallbacks (failover phase 2).
--
-- An ordered, opt-in list of {provider, model} the gateway may retry on when the
-- agent's chosen provider fails in an allowlisted way. NULL and [] both preserve
-- the pre-failover proxy behaviour exactly, the same property migration 0014
-- gave policy.
--
-- Current gateway state, deliberately not a visa claim: an operator's change
-- takes effect after at most the 60-second cache window rather than waiting out
-- a live visa's TTL. Same reasoning as 0014.
-- ============================================================================

alter table public.agents
  add column fallbacks jsonb not null default '[]'::jsonb;

comment on column public.agents.fallbacks is
  'Ordered opt-in [{provider, model}] retried on an allowlisted upstream failure. Re-checked against scope, policy, budget and the kill switch on every attempt — it can never grant capability the agent does not already have.';

-- Unlike 0014's policy column, this one IS operator-editable from the dashboard,
-- so it needs an explicit column grant. Migration 0011 revoked the table-wide
-- authenticated UPDATE and restored an allowlist precisely because "RLS does not
-- prevent that user from PATCHing any column through PostgREST" — so a column
-- with a write path has to be named here or the dashboard's authenticated client
-- cannot write it at all.
--
-- Granting it is a smaller step than it looks: allowed_scopes is already in that
-- allowlist and is strictly more powerful, because it IS the capability. A
-- fallback entry is re-checked against scope on every attempt, so a tenant who
-- PATCHes this column directly — bypassing validateFallbacks — can name
-- providers the agent still cannot reach. The gateway therefore treats this
-- column as untrusted input, exactly as parsePolicy does for policy.
grant update (fallbacks) on public.agents to authenticated;
