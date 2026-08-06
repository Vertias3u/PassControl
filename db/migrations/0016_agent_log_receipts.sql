-- Signed call receipts.
--
-- A detached EdDSA (Ed25519) compact JWS over this call, signed by the key the
-- deployment publishes at /.well-known/jwks.json. It lets a third party verify
-- offline that this agent made this call, to this provider and model, with this
-- verdict and this cost — without an account here and without reaching us.
-- NULL when the deployment configures no INSTANCE_SIGNING_KEY.
alter table public.agent_logs
  add column if not exists receipt text;

comment on column public.agent_logs.receipt is
  'Detached EdDSA compact JWS over this call, signed by the instance key '
  'published at /.well-known/jwks.json. NULL when no signing key is configured.';

-- Why a column and not a receipts table.
--
-- Migration 0006 makes agent_logs append-only with a trigger that rejects UPDATE
-- at depth 1 *including for service_role*. So "insert the row now, sign and fill
-- the receipt in afterwards" is not available at any privilege level. The
-- alternatives were a second insert into a separate table — which doubles the
-- failure modes on a write path that is already best-effort, and can orphan a
-- receipt from its call — or one row written once, atomically. This is that.
--
-- The 0006 triggers still apply unchanged: a receipt cannot be altered or
-- removed after the fact, which is the property that makes it worth signing.

-- No grant or RLS change. agent_logs already allows only SELECT to
-- authenticated, scoped by user_id, and the control plane selects an explicit
-- column list — the receipt is served from its own tenant-scoped route rather
-- than widening the list endpoint.
