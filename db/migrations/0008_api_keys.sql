-- ============================================================================
-- PassControl — developer API keys for the public control-plane API (phase 3).
--
-- A key is a high-entropy token shown once; we persist only its SHA-256 hash plus
-- a short non-secret display prefix. Owners manage their own keys from the Control
-- Tower (RLS owner-scoped). The control plane (Phase B) authenticates by hashing
-- the presented token and looking up the row via the service role. Revocation is a
-- soft delete (revoked_at) so the key_prefix stays referenceable in the audit log.
-- ============================================================================

create table if not exists public.api_keys (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.users(id) on delete cascade,
  name         text not null,
  key_prefix   text not null,                 -- e.g. 'pc_a1b2c3d4' (display + scanning)
  key_hash     text not null unique,          -- sha256(token); the token itself is never stored
  scope        text not null check (scope in ('read','write')),
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists api_keys_user_idx on public.api_keys (user_id, created_at desc);
-- key_hash is UNIQUE → its implicit index backs the verification lookup.

alter table public.api_keys enable row level security;

-- Owner-scoped: a user manages only their own keys. Our queries select metadata
-- columns only (never key_hash). service_role bypasses RLS to verify a key.
drop policy if exists api_keys_select on public.api_keys;
create policy api_keys_select on public.api_keys
  for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists api_keys_insert on public.api_keys;
create policy api_keys_insert on public.api_keys
  for insert to authenticated with check (user_id = (select auth.uid()));
drop policy if exists api_keys_update on public.api_keys;
create policy api_keys_update on public.api_keys
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists api_keys_delete on public.api_keys;
create policy api_keys_delete on public.api_keys
  for delete to authenticated using (user_id = (select auth.uid()));

-- Match the explicit-grants convention (0007); RLS is the gate.
grant all on public.api_keys to anon, authenticated, service_role;
