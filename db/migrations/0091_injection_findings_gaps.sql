-- 0091 — Tool output the injection guard could not fully check (1.7.1, external review P1).
--
-- Until now a scan that stopped early was silent: past the gateway's block or depth limit,
-- past the sidecar's size limit, or when the scanner threw, the output read as clean. That
-- is the one thing it must not read as. Such output is now a finding of its own kind:
--
--   * `severity` may be 'incomplete', with no families (nothing was found because not all
--     of it was read, which is different from clean).
--   * `gap`, why: 'too_large' (past the sidecar's scan budget or its hook body limit),
--     'scan_failed' (the scanner threw), 'too_many_blocks' or 'too_deep' (the gateway's
--     limits, lib/injection-blocks.ts). Set exactly on an 'incomplete' row.
--
-- In hold mode a new gap taints like a strong finding (lib/state/taint.ts), with its own
-- reason to the owner; monitor mode only records it. `content_hmac` is the same per-tenant
-- HMAC as before, over what identifies the gap (the failed blocks, or the whole body), so
-- the same output re-sent is the same row, and the owner's Clear sticks as it does for a
-- tell. Still never the text.
--
-- A database before this refuses a gap row only: the code names the column on gap rows
-- alone, so every tell still fits 0089 and 0090, and the hold still applies in Redis.
--
-- A new migration, not an edit to 0090: 0090 is already in a database's ledger.
-- Grants are unchanged: 0089's are table-wide, so they cover the new column.

alter table public.injection_findings
  add column if not exists gap text;

alter table public.injection_findings
  drop constraint if exists injection_findings_vocab;
alter table public.injection_findings
  add constraint injection_findings_vocab check (
    surface in ('proxy', 'sidecar')
    and severity in ('high', 'low', 'incomplete')
    and families <@ array['role_markup', 'instruction_override', 'exfil_directive', 'authority_claim', 'hidden_text']::text[]
    and (
      (severity = 'incomplete' and cardinality(families) = 0)
      or (severity <> 'incomplete' and cardinality(families) between 1 and 5)
    )
  );

alter table public.injection_findings
  drop constraint if exists injection_findings_gap;
alter table public.injection_findings
  add constraint injection_findings_gap check (
    (severity = 'incomplete') = (gap is not null)
    and (gap is null or gap in ('too_large', 'scan_failed', 'too_many_blocks', 'too_deep'))
    and (gap is null or surface = 'proxy' or gap in ('too_large', 'scan_failed'))
  );

comment on column public.injection_findings.gap is
  'Why tool output was not fully checked, on an incomplete row only: too_large, scan_failed, too_many_blocks, too_deep. Never the text.';
