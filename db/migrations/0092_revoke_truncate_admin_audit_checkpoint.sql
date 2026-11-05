-- Close the latent TRUNCATE/TRIGGER/REFERENCES grants left by 0007 on
-- admin_audit and agent_spend_checkpoint, and by Supabase's default table
-- privileges on agent_owners and break_glass_grants (0017/0022 revoke DML only).
-- TRUNCATE bypasses RLS. This is latent because PostgREST has no TRUNCATE verb;
-- the grants must still be closed for direct SQL or a future exposed path.
-- 0028/0032 closed the same TRUNCATE hole on other tables. Keep SELECT, DML,
-- policies and service_role privileges unchanged.

revoke truncate, trigger, references on public.admin_audit from anon, authenticated;
revoke truncate, trigger, references on public.agent_spend_checkpoint from anon, authenticated;
revoke truncate, trigger, references on public.agent_owners from anon, authenticated;
revoke truncate, trigger, references on public.break_glass_grants from anon, authenticated;
