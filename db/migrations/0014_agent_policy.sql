-- Per-agent policy is current gateway state, deliberately not a visa claim.
-- NULL and the empty object both preserve the pre-policy proxy behavior.
alter table public.agents
  add column policy jsonb default '{}'::jsonb;

comment on column public.agents.policy is
  'Optional current-state deny, UTC window, and per-hour request rules enforced before budget reserve.';

-- No new RLS policy or column grant is needed. Migration 0011 revoked the
-- table-wide authenticated UPDATE grant and restored only an explicit metadata
-- allowlist; this new column is therefore not directly updateable through
-- PostgREST. Service-role operations remain available for a future validated
-- mutation surface.
