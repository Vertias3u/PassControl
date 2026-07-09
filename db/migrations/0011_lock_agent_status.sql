-- ============================================================================
-- PassControl — keep agent revocation terminal for dashboard-authenticated users.
--
-- RLS scopes an authenticated user to their own agent, but it does not prevent
-- that user from PATCHing any column through PostgREST. The earlier table-wide
-- grant cannot be narrowed with a column-only REVOKE, so replace it with grants
-- for the editable metadata columns. Status transitions now run only in
-- server-side fleet mutations, which explicitly filter by user_id and preserve
-- the revoked terminal state.
-- ============================================================================

revoke update on public.agents from authenticated, anon;
grant update (name, allowed_scopes, budget_tokens, budget_cents)
  on public.agents to authenticated;
