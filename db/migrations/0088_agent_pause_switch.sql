-- ============================================================================
-- PassControl — a cheaper model at the pause line (1.6.0, L7).
--
-- At its pause line (0087) an agent can go on with a cheaper model instead of
-- pausing, for the rest of the period, unless its owner lets it go on.
--
--   agents.pause_action          — 'pause' (the default, today's behaviour) or
--                                  'switch'.
--   agents.pause_switch_provider — the provider the switch applies to. A call to
--                                  any other provider past the line pauses.
--   agents.pause_switch_model    — the one exact model those calls go to.
--   agent_logs.requested_model   — on a switched call's row only: the model the
--                                  agent asked for. `model` stays the model sent.
--
-- ── What enforces it ──────────────────────────────────────────────────────
--
-- The gateway, at the pause step (app/api/v1/[provider]/[...path]/route.ts, 4d).
-- The switch never widens what the agent may call: the cheaper model goes through
-- the same scope, endpoint and policy gate as any model, with the scope the call
-- carries, and a model that fails it is refused, never sent. The hold prices the
-- model sent, and the hard limits are enforced behind it exactly as before. The
-- dashboard refuses a switch to a model outside the agent's scope when it is
-- saved (lib/fleet.ts); the gateway's check is the one that holds, because the
-- scope can be narrowed after the switch was saved.
--
-- ── Grants ────────────────────────────────────────────────────────────────
--
-- The same column UPDATE grant `authenticated` has on pause_percent (0087), for
-- the same reason: the tenant's own setting, through the same tenant-scoped
-- update, which invalidates the gateway's policy cache. RLS is unchanged. The
-- check constraints are the boundary a direct PATCH meets.
--
-- agent_logs gets no new grant. Rows are written by the service role only, and
-- the tenant's existing SELECT policy covers the new column.
--
-- Additive. Old code ignores the columns; nothing is backfilled. A gateway that
-- deploys before this migration reads "pause" (lib/state/policy.ts, its own rung
-- of the select ladder), and never writes requested_model, because only a switch
-- configured in these columns produces a switched call.
-- ============================================================================

alter table public.agents
  add column if not exists pause_action text not null default 'pause',
  add column if not exists pause_switch_provider text,
  add column if not exists pause_switch_model text;

alter table public.agents
  drop constraint if exists agents_pause_action_values,
  add constraint agents_pause_action_values
    check (pause_action in ('pause', 'switch'));

-- A switch names its model, and applies at a pause line. A pause carries neither.
alter table public.agents
  drop constraint if exists agents_pause_switch_shape,
  add constraint agents_pause_switch_shape
    check (
      (pause_action = 'pause' and pause_switch_provider is null and pause_switch_model is null)
      or (
        pause_action = 'switch'
        and pause_percent is not null
        and pause_switch_provider is not null
        and pause_switch_model is not null
        and length(pause_switch_model) between 1 and 200
        and position('*' in pause_switch_model) = 0
      )
    );

comment on column public.agents.pause_action is
  'At the pause line (pause_percent): ''pause'' refuses calls until the owner lets the agent go on; ''switch'' sends that provider''s calls to pause_switch_model instead. The scope, policy and limits apply to the model sent.';
comment on column public.agents.pause_switch_provider is
  'The provider whose calls switch at the pause line. Calls to any other provider past the line pause.';
comment on column public.agents.pause_switch_model is
  'The exact model calls switch to at the pause line. Must be in the agent''s scope: the gateway refuses, and never sends, a switch outside it.';

grant update (pause_action, pause_switch_provider, pause_switch_model) on public.agents to authenticated;

alter table public.agent_logs
  add column if not exists requested_model text;

comment on column public.agent_logs.requested_model is
  'Set only on a call switched to a cheaper model at the pause line (0088): the model the agent asked for. model is the model sent.';
