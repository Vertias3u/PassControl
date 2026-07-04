-- ============================================================================
-- PassControl — MFA recovery codes (one-time backup codes for dashboard login).
--
-- Stored as SHA-256 hashes only (like api_keys); each is single-use (used_at).
-- Owner-scoped RLS: a user manages/consumes only their own codes (the login
-- step-up runs as the authenticated AAL1 user, so RLS is the boundary).
-- ============================================================================

create table if not exists public.mfa_recovery_codes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users(id) on delete cascade,
  code_hash  text not null,
  used_at    timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, code_hash)
);
create index if not exists mfa_recovery_codes_user_idx on public.mfa_recovery_codes (user_id);

alter table public.mfa_recovery_codes enable row level security;

drop policy if exists mfa_recovery_codes_select on public.mfa_recovery_codes;
create policy mfa_recovery_codes_select on public.mfa_recovery_codes
  for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists mfa_recovery_codes_insert on public.mfa_recovery_codes;
create policy mfa_recovery_codes_insert on public.mfa_recovery_codes
  for insert to authenticated with check (user_id = (select auth.uid()));
drop policy if exists mfa_recovery_codes_update on public.mfa_recovery_codes;
create policy mfa_recovery_codes_update on public.mfa_recovery_codes
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists mfa_recovery_codes_delete on public.mfa_recovery_codes;
create policy mfa_recovery_codes_delete on public.mfa_recovery_codes
  for delete to authenticated using (user_id = (select auth.uid()));

grant all on public.mfa_recovery_codes to anon, authenticated, service_role;
