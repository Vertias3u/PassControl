-- ============================================================================
-- PassControl — the soft pause line (1.6.0, L4).
--
-- An owner can have an agent pause at N % of its spend limits, well before the
-- limit itself refuses it, and then let it go on for an hour from the agent's page.
--
--   agents.pause_percent — 1–99, or NULL for no pause line (the default).
--
-- ── What enforces it ──────────────────────────────────────────────────────
--
-- The gateway, once per call, after scope and policy and before any budget hold
-- (app/api/v1/[provider]/[...path]/route.ts, step 4d; lib/budget-pause.ts). It
-- applies to every limit the agent has: a daily or monthly limit, the lifetime
-- dollar cap and the token cap. Whichever is past the line pauses the agent.
--
-- A SOFT limit. The pause reads the same counters GET /api/v1/self shows, not the
-- atomic hold, so two calls racing past the line can both get through. The hard
-- limits are untouched and still enforced atomically behind it: nothing in this
-- migration, and nothing the pause does, can let an agent spend past them.
--
-- The lift ("let it go on for an hour") is NOT stored here. It is a Redis key with
-- a TTL (lib/state/pause.ts), so it ends on its own and needs no cleanup.
--
-- ── Grants ────────────────────────────────────────────────────────────────
--
-- The same column UPDATE grant `authenticated` has on the agent's own limits
-- (0011, 0073), for the same reason: it is the tenant's own setting, edited
-- through the same tenant-scoped update (lib/fleet.ts updateAgent, which also
-- invalidates the gateway's policy cache). RLS is unchanged: the row is already
-- the tenant's own, and the check constraint is the boundary a direct PATCH meets.
--
-- Additive. Old code ignores the column; nothing is backfilled. A gateway that
-- deploys before this migration reads "no pause line" (lib/state/policy.ts, its
-- own rung of the select ladder).
-- ============================================================================

alter table public.agents
  add column if not exists pause_percent smallint;

alter table public.agents
  drop constraint if exists agents_pause_percent_range,
  add constraint agents_pause_percent_range
    check (pause_percent is null or pause_percent between 1 and 99);

comment on column public.agents.pause_percent is
  'Soft pause line: the gateway pauses the agent once it has used this % of any of its spend limits, until the owner lets it go on (a Redis lift with a TTL). 1-99, NULL = no pause line. The limits themselves are enforced unchanged behind it.';

grant update (pause_percent) on public.agents to authenticated;
