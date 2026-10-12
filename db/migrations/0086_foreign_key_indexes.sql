-- ============================================================================
-- PassControl — an index under every foreign key that had none.
--
-- Deleting a parent row (a user, an agent, a beta application or invite) makes
-- Postgres look for rows that still point at it. With no index leading with the
-- key's column, that lookup reads the whole child table, once per deleted parent.
-- Supabase's performance advisor reports each one as "unindexed foreign key".
--
-- 0081 added `delegation_revocations.user_id` (its unique key leads with
-- `agent_id`); the other nine keys are older. Every table here is small, so this is
-- tidiness now rather than a fix for a slow query, and it keeps the advisor quiet
-- enough that a NEW finding stands out.
--
-- Additive only: no column, constraint, policy or grant changes, and every index
-- is `if not exists`, so the file can be applied twice.
-- ============================================================================

create index if not exists agent_access_keys_agent_id_idx
  on public.agent_access_keys (agent_id);

create index if not exists agent_spend_adjustments_user_id_idx
  on public.agent_spend_adjustments (user_id);

create index if not exists beta_feedback_application_id_idx
  on public.beta_feedback (application_id);

create index if not exists beta_invites_user_id_idx
  on public.beta_invites (user_id);

create index if not exists beta_operator_events_actor_user_id_idx
  on public.beta_operator_events (actor_user_id);

create index if not exists beta_operator_events_invite_id_idx
  on public.beta_operator_events (invite_id);

create index if not exists delegation_revocations_user_id_idx
  on public.delegation_revocations (user_id);

create index if not exists onboarding_state_refusal_test_agent_id_idx
  on public.onboarding_state (refusal_test_agent_id);

create index if not exists reserved_usernames_assigned_user_id_idx
  on public.reserved_usernames (assigned_user_id);

