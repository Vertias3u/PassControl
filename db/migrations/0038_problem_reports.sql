-- Append-only problem reports, so a beta user who gets stuck can say so.
--
-- Deliberately NOT beta_feedback. That table is `user_id ... not null unique`
-- and is written with upsert(onConflict: 'user_id'), which means one row per
-- person forever: a second report silently destroys the first. It is a survey
-- (a 1-5 setup rating), and it FKs to beta_applications, so it cannot hold a
-- report from anyone who arrived by another route. Both tables stay.
--
-- Two properties this file is responsible for:
--
--   The browser reaches this table not at all — RLS enabled, no policies, no
--   grant. Writes are server-only because that is what makes the rate limit and
--   the free-text secret redaction unbypassable: a direct PostgREST insert
--   would skip both, and the redaction is the only thing standing between a
--   pasted provider key and a durable table.
--
--   Reads are server-only for a separate reason that is easy to get wrong. RLS
--   filters ROWS, not COLUMNS. A `grant select ... to authenticated` with an
--   owner policy hands the tenant every column of their own row — including
--   `schema_head` and `app_version`, which are precisely what /dashboard/system
--   restricts to PASSCONTROL_SYSTEM_OPERATOR_EMAILS behind verified TOTP,
--   because how far behind a database is doubles as a list of the fixes it
--   lacks. "Our UI does not render it" is not a boundary; PostgREST is. So this
--   table takes the beta_applications shape from 0025, not the beta_feedback
--   one. A reporter retrieves their own reports through the account export,
--   which is server-side and can choose its columns.
--
--   `diagnostics` never receives a database row. It receives the output of
--   buildCloudSupportBundle (lib/cloud-operations.ts), which is constructed
--   from an explicit field allowlist precisely so a future secret-bearing
--   column cannot leak into it by being added to a SELECT. It is null unless
--   the reporter ticked the consent box, having been shown the exact contents.
create table if not exists public.problem_reports (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.users(id) on delete cascade,
  kind            text not null check (kind in ('bug', 'confusing', 'feature', 'security')),
  message         text not null check (char_length(message) between 20 and 4000),
  diagnostics     jsonb,
  -- Denormalised so the triage LIST can say whether an artifact exists without
  -- selecting it: 250 rows x 256 KB would be a 64 MB response for a boolean.
  -- The constraint below makes the flag and the payload unable to disagree,
  -- rather than merely unlikely to.
  diagnostics_attached boolean not null default false,
  app_version     text,
  schema_head     text,
  release_commit  text,
  status          text not null default 'open'
                  check (status in ('open', 'acknowledged', 'resolved')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint problem_reports_attachment_state check (
    diagnostics_attached = (diagnostics is not null)
  ),
  -- A hard ceiling the server action also enforces. jsonb has no natural bound
  -- and this is a free tier.
  constraint problem_reports_diagnostics_size check (
    diagnostics is null or octet_length(diagnostics::text) <= 262144
  )
);

-- Triage reads newest-first across all tenants; a reporter reads their own.
create index if not exists problem_reports_created_idx
  on public.problem_reports (created_at desc);
create index if not exists problem_reports_user_created_idx
  on public.problem_reports (user_id, created_at desc);

alter table public.problem_reports enable row level security;

revoke all on public.problem_reports from public, anon, authenticated;
grant select, insert, update, delete on public.problem_reports to service_role;

-- Deliberately no policies. RLS is enabled so that a future grant cannot open
-- the table by accident, and there is nothing for anon or authenticated to
-- match: both roles hold no privilege here at all.

-- Retention. purge_beta_launch_data() drops beta_feedback after 180 days, and a
-- new table that grows forever would be the one exception in the schema. The
-- clock runs on resolution, not on filing: an OPEN report is one nobody has
-- answered yet, and deleting it would destroy the only record of a problem
-- while the problem is still live. Resolved reports age out.
create or replace function public.purge_problem_reports()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer := 0;
begin
  delete from public.problem_reports
   where status = 'resolved'
     and updated_at < now() - interval '180 days';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.purge_problem_reports() from public, anon, authenticated;
grant execute on function public.purge_problem_reports() to service_role;

comment on table public.problem_reports is
  'Append-only bug/feedback reports. Browser-read-only; writes are server-only so redaction and rate limiting cannot be bypassed.';
comment on column public.problem_reports.diagnostics is
  'Allowlist-constructed support bundle (lib/cloud-operations.ts). Null unless the reporter consented after seeing its contents. Never a serialized database row.';
comment on column public.problem_reports.message is
  'Free text, scrubbed of secret-shaped values by lib/redact.ts before insert.';
