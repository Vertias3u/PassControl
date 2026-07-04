-- ============================================================================
-- PassControl — admin-action audit log.
--
-- Append-only record of privileged dashboard mutations (issue passport, add/
-- rotate a provider key, arm the kill switch, suspend an agent). This is the
-- accountability trail for *operator* actions, complementing agent_logs (the
-- per-call gateway trail). Mirrors the agent_logs security model: the owner may
-- read their own rows; clients have NO write path — only the service-role gateway
-- inserts (bypassing RLS). No secret material is ever stored here.
-- ============================================================================

create table if not exists public.admin_audit (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users(id) on delete cascade,
  action      text not null,                 -- e.g. agent.create | killswitch.master
  target_type text,                          -- e.g. agent | provider_key
  target_id   text,                          -- id/label of the affected object
  metadata    jsonb not null default '{}',   -- small, non-secret context (sanitized in app)
  created_at  timestamptz not null default now()
);
create index if not exists admin_audit_user_created_idx
  on public.admin_audit (user_id, created_at desc);

alter table public.admin_audit enable row level security;

-- Owner can read their own audit trail. No insert/update/delete policy exists for
-- authenticated/anon, so RLS denies all client writes; the service-role client
-- (gateway/server actions) bypasses RLS and is the only writer. Append-only by
-- convention (no update/delete path is ever issued).
drop policy if exists admin_audit_select on public.admin_audit;
create policy admin_audit_select on public.admin_audit
  for select to authenticated using (user_id = (select auth.uid()));
