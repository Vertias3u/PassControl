-- 0090 — Injection findings from the sidecar (plans/injection-guard.md §2b, Phase 1).
--
-- In subscription mode the gateway never sees the model traffic, so 0089's proxy scan
-- has nothing to read. The local sidecar scans what Claude Code's PostToolBatch hook
-- hands it (each tool's output, as the model sees it) and uploads what it found through
-- POST /api/v1/client-events, kind `injection_finding`. This lets those rows in:
--
--   * `surface` may now be 'sidecar' as well as 'proxy'. A sidecar row is the client's
--     word, and says so: the gateway checks its shape, not that the detector fired.
--   * `tool_name`, the tool that returned the block ('WebFetch', 'mcp__github__get_file').
--     The hook knows it; the proxy does not, so only a sidecar row may carry one.
--
-- Nothing else changes. The sidecar never sends the text, only a SHA-256 of it, and that
-- is not stored either: `content_hmac` is the gateway's per-tenant HMAC of that hash, so
-- 0089's rule (never a bare hash, never comparable across tenants) still holds.
--
-- A new migration, not an edit to 0089: 0089 is already in a database's ledger, and
-- scripts/migrate.sh refuses a changed file.
--
-- Grants are unchanged. 0089's are table-wide, so they cover the new column: the tenant
-- reads it through the same RLS policy, the service role inserts it, nobody updates.
--
-- Additive. A gateway that deploys before this migration still writes proxy rows (they
-- never name `tool_name`), and drops sidecar findings as unavailable; the batch's other
-- events are unaffected.

alter table public.injection_findings
  add column if not exists tool_name text;

alter table public.injection_findings
  drop constraint if exists injection_findings_vocab;
alter table public.injection_findings
  add constraint injection_findings_vocab check (
    surface in ('proxy', 'sidecar')
    and severity in ('high', 'low')
    and cardinality(families) between 1 and 5
    and families <@ array['role_markup', 'instruction_override', 'exfil_directive', 'authority_claim', 'hidden_text']::text[]
  );

alter table public.injection_findings
  drop constraint if exists injection_findings_tool_name;
alter table public.injection_findings
  add constraint injection_findings_tool_name check (
    tool_name is null
    or (surface = 'sidecar' and tool_name ~ '^[A-Za-z0-9_.-]{1,128}$')
  );

comment on column public.injection_findings.tool_name is
  'The tool that returned the block, on a sidecar row only (the hook names it; the proxy cannot).';
