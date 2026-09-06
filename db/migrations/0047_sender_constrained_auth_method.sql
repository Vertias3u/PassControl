-- Record what authentication the gateway actually enforced for each call.
--
-- 0026 closed the agent_logs identity contract around two values. Sender-
-- constrained passport calls keep the same passport_id + visa jti identity,
-- but are materially stronger: the gateway also verified a fresh Ed25519 proof
-- bound to this visa, method and path, then burned its proof jti. A third value
-- preserves that fact instead of collapsing it back to bearer `passport`.
--
-- This migration changes no agent setting and no default. In particular,
-- agents.require_sender_constrained_visa remains opt-in and defaults false.
-- Apply this migration before the writer that can emit the new value.

alter table public.agent_logs
  drop constraint agent_logs_auth_method_known;

alter table public.agent_logs
  drop constraint agent_logs_identity_discriminated;

alter table public.agent_logs
  add constraint agent_logs_auth_method_known
  check (auth_method in ('passport', 'passport_proof_per_request', 'direct_key'))
  not valid;

alter table public.agent_logs
  validate constraint agent_logs_auth_method_known;

alter table public.agent_logs
  add constraint agent_logs_identity_discriminated
  check (
    (
      auth_method in ('passport', 'passport_proof_per_request')
      and passport_id is not null
      and jti is not null
      and agent_access_key_id is null
      and credential_use_id is null
    )
    or (
      auth_method = 'direct_key'
      and agent_access_key_id is not null
      and credential_use_id is not null
      and passport_id is null
      and jti is null
    )
  )
  not valid;

alter table public.agent_logs
  validate constraint agent_logs_identity_discriminated;

comment on column public.agent_logs.auth_method is
  'What the gateway actually enforced for this call: passport is a bearer '
  'work-visa; passport_proof_per_request additionally means a fresh Ed25519 '
  'proof bound to the exact visa, method and path was verified and its proof '
  'jti was claimed; direct_key is bearer possession of a Direct Agent Key. '
  'This records enforcement, never the agent configuration flag.';
