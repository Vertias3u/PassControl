-- ============================================================================
-- PassControl — explicit table grants.
--
-- The schema was relying on Supabase's IMPLICIT default-privilege grants (anon/
-- authenticated/service_role auto-granted on objects created in public). Those do
-- not reproduce on a from-scratch `supabase start` + psql apply — surfaced by the
-- RLS CI job (authenticated got "permission denied for table agents"). Codify the
-- grants the hosted project already has so a fresh database is identical to prod.
--
-- These are intentionally broad (the Supabase model): RLS is the real gate. Rows
-- are scoped by the per-table policies; operations a role has no policy for are
-- denied regardless of the grant (agent_logs allows only SELECT; agent_spend_
-- checkpoint has no policy at all). The agent_logs immutability triggers (0006)
-- additionally reject UPDATE/DELETE/TRUNCATE even though the grant exists.
-- ============================================================================

grant usage on schema public to anon, authenticated, service_role;

grant all on
  public.users,
  public.agents,
  public.provider_credentials,
  public.agent_logs,
  public.admin_audit,
  public.agent_spend_checkpoint
to anon, authenticated, service_role;
