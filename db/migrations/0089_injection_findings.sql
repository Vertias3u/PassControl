-- 0089 — What the injection guard found (plans/injection-guard.md, Phase 1).
--
-- With `injection_guard: { mode: "monitor" }` in an agent's live policy, the gateway
-- scans what tools handed the model inside each request (tool results, documents,
-- search and fetch results) for the tells injected instructions carry, and records
-- each NEW block that has one here. Nothing is refused and nothing in the call changes.
--
-- What a row holds, and what it never does:
--   * where the block was (`path`, a JSON path into the request), which kind of block
--     carried it (`source`), the families of tell and the strongest severity;
--   * which detector found it, exactly (`detector`, `normalization_version`): a change to
--     the scanner ships under a new id, so an old row always says what produced it;
--   * `content_hmac`, an HMAC of the block under a key that is the tenant's own. Never a
--     bare hash: one compared across tenants would say whether another tenant has read
--     the same page. Never the text, a snippet or a match.
--
-- One row per block, not per call: a coding agent re-sends the whole conversation on
-- every call, so the same tool result arrives again and again. The unique index below
-- is the backstop for the gateway's own de-duplication; a repeat is a no-op
-- (`on conflict do nothing`).
--
-- Append-only and locked like every tenant table: RLS on, a tenant reads only its own
-- rows, the service role reads and inserts, nobody updates or deletes a row (deleting
-- the agent or the account removes its rows by cascade). Phase 2 (the hold, and the
-- owner's "clear") brings its own migration for what it needs to change.
--
-- Kept 30 days. A row leaves early only through the two functions below, whose window is
-- fixed inside them: the gateway ages an agent's rows out at most once a day after a
-- write (both deploy modes), and Cloud's daily retention sweep purges every tenant's.
--
-- Apply before deploying the code that writes it. Until then the gateway's write fails
-- quietly, the agent page says the records are not available, and calls are unaffected.

create table if not exists public.injection_findings (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references public.users(id) on delete cascade,
  agent_id              uuid not null,
  created_at            timestamptz not null default now(),
  surface               text not null,
  source                text not null,
  path                  text not null,
  families              text[] not null,
  severity              text not null,
  detector              text not null,
  normalization_version smallint not null,
  content_hmac          text not null,
  provider              text,
  model                 text,
  constraint injection_findings_agent_tenant
    foreign key (agent_id, user_id) references public.agents (id, user_id) on delete cascade,
  constraint injection_findings_vocab check (
    surface in ('proxy')
    and severity in ('high', 'low')
    and cardinality(families) between 1 and 5
    and families <@ array['role_markup', 'instruction_override', 'exfil_directive', 'authority_claim', 'hidden_text']::text[]
  ),
  -- `is not null` beside a pattern where the column is required: a NULL fails a regex
  -- as UNKNOWN, and a check constraint lets UNKNOWN through.
  constraint injection_findings_fields check (
    source is not null and source ~ '^[a-z_]{1,64}$'
    -- A length, not `{1,512}`: Postgres refuses a repetition count above 255, and only
    -- when a row is checked, so the migration applies and then every insert fails.
    and path is not null and char_length(path) between 1 and 512 and path ~ '^[A-Za-z0-9_.\[\]?-]+$'
    and detector is not null and detector ~ '^[a-z0-9.+-]{1,64}$'
    and normalization_version between 1 and 1000
    and content_hmac is not null and content_hmac ~ '^[0-9a-f]{64}$'
    and (provider is null or provider ~ '^[a-z0-9_-]{1,32}$')
    and (model is null or model ~ '^[A-Za-z0-9._:/@-]{1,100}$')
  )
);

comment on table public.injection_findings is
  'Injection tells the gateway found in tool output inside model requests (injection_guard monitor mode): where, which kind of block, which families, which detector, and a per-tenant HMAC of the block. Never the text.';
comment on column public.injection_findings.content_hmac is
  'HMAC-SHA256 of the block under a per-tenant key. Not comparable across tenants by design.';

-- One row per block per detector: a re-sent conversation is a no-op.
create unique index if not exists injection_findings_one_per_block
  on public.injection_findings (user_id, agent_id, content_hmac, detector);
-- The agent page reads the newest first. Leads with the composite foreign key's full
-- column list, in order, which is what covers it (Supabase's unindexed_foreign_keys
-- advisor), so a deleted agent's cascade does not scan.
create index if not exists injection_findings_agent_recent
  on public.injection_findings (agent_id, user_id, created_at desc);

alter table public.injection_findings enable row level security;

revoke all on table public.injection_findings from public, anon, authenticated, service_role;
grant select on table public.injection_findings to authenticated;
grant select, insert on table public.injection_findings to service_role;

drop policy if exists injection_findings_select_own on public.injection_findings;
create policy injection_findings_select_own on public.injection_findings
  for select to authenticated
  using (user_id = (select auth.uid()));

-- Retention: this agent's rows older than 30 days, for the tenant that owns it.
-- SECURITY DEFINER because nobody holds DELETE on the table; the window is not a
-- parameter. Returns how many rows went.
create or replace function public.prune_injection_findings(p_agent_id uuid, p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  removed integer;
begin
  delete from public.injection_findings
   where agent_id = p_agent_id
     and user_id = p_user_id
     and created_at < now() - interval '30 days';
  get diagnostics removed = row_count;
  return removed;
end;
$$;

revoke all on function public.prune_injection_findings(uuid, uuid) from public, anon, authenticated;
grant execute on function public.prune_injection_findings(uuid, uuid) to service_role;

-- Retention across every tenant, for Cloud's daily retention sweep.
create or replace function public.purge_injection_findings()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  removed integer;
begin
  delete from public.injection_findings
   where created_at < now() - interval '30 days';
  get diagnostics removed = row_count;
  return removed;
end;
$$;

revoke all on function public.purge_injection_findings() from public, anon, authenticated;
grant execute on function public.purge_injection_findings() to service_role;
