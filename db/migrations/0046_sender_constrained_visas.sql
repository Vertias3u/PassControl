-- Per-agent opt-in for sender-constrained work-visas.
--
-- Default OFF is the migration safety property: existing agents keep accepting
-- bearer visas until their operator deliberately enables proof-per-request.
-- This trust-boundary flag is service-managed; no authenticated column grant is
-- added here. Dashboard surfacing belongs to the later migration step 4.

alter table public.agents
  add column require_sender_constrained_visa boolean not null default false;

comment on column public.agents.require_sender_constrained_visa is
  'When true, passport work-visas require a fresh request-bound Ed25519 proof. Direct Agent Keys remain bearer credentials.';
