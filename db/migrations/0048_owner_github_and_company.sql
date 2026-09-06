-- ============================================================================
-- PassControl — a second free proof, and a checkable company claim.
--
-- 0017 shipped one provable owner binding (`domain`) and reserved `idv` for a
-- paid one. This adds the two evidence sources that are free, and it puts them
-- on opposite sides of a line that must not blur:
--
--   github / github  — PROVEN. The owner published our token in a public
--                      repository at github.com/<login>/passcontrol-owner,
--                      which only that account can create. A peer of `domain`,
--                      not a lesser tier: both prove control of a public
--                      identifier and neither proves who the human is.
--
--   company_*        — NOT PROVEN, and deliberately not a tier at all. See the
--                      long note below. These are plain columns on the same
--                      row, so a company claim travels ALONGSIDE a proof
--                      instead of replacing one.
--
-- ── Why the company claim is columns and not a `kind` ───────────────────────
--
-- `user_id` is the primary key: one owner row per tenant, and 0017 explains at
-- length why that is load-bearing (upsert onConflict, two maybeSingle() reads,
-- and a LEFT JOIN in verify_passport that would otherwise multiply agent rows).
-- So a `kind = 'company'` would not be an ADDITION to a domain proof — it would
-- REPLACE it. A tenant recording their company number would give up a proven
-- binding to hold an unprovable one, which is strictly worse than what they had
-- wearing a better-sounding label.
--
-- And it is unprovable for free. A domain or a GitHub account can be proven
-- because the owner publishes a token somewhere only they control. A company
-- register is a public record that anyone can read and anyone can quote; there
-- is nowhere to put a token. That gap is what paid business verification sells,
-- and it is why `idv` was reserved rather than implemented.
--
-- What these columns DO carry is narrower and still worth having: this register
-- entry exists, is active, and resolves to this legal name — checked by us
-- against the register, on an explicit owner action. Combined with a proven
-- domain or GitHub account it makes a claim a stranger can falsify against the
-- same public register, which is the whole point of the binding.
--
-- THE RULE: nothing about the company columns may ever influence `tier`.
-- lib/owner/manage.ts enforces it, tests/owner-manage.test.ts pins it, and
-- every surface that renders a company line must label it as asserted.
-- ============================================================================

-- Apply via scripts/migrate.sh, which ledgers each file in
-- public.schema_migrations and will not run this twice.

-- ── The two widened constraints ─────────────────────────────────────────────
--
-- Named explicitly rather than dropped by lookup: a column-level `check (...)`
-- in 0017 got the deterministic name `<table>_<column>_check`, and stating it
-- means a rename upstream fails loudly here instead of silently leaving the old
-- constraint in place next to a new one.
alter table public.agent_owners
  drop constraint if exists agent_owners_kind_check;
alter table public.agent_owners
  add constraint agent_owners_kind_check
  check (kind in ('self_attested', 'domain', 'github', 'idv'));

alter table public.agent_owners
  drop constraint if exists agent_owners_tier_check;
alter table public.agent_owners
  add constraint agent_owners_tier_check
  check (tier in ('unverified', 'domain', 'github', 'idv'));

-- ── The company claim ───────────────────────────────────────────────────────
--
-- All nullable, no default, and independent of every column above. A row with a
-- company line and tier 'unverified' is a legitimate state: the owner named a
-- real registered company and has not proven control of anything.
--
-- There is deliberately no `company_address`. The registers return a postal
-- address of a real place, this row can be published on /verify, and nothing
-- downstream needs it — so it is not read, not stored, and not available to
-- leak later.
alter table public.agent_owners
  add column if not exists company_id text,
  add column if not exists company_source text
    check (company_source in ('vat', 'lei')),
  add column if not exists company_name text,
  add column if not exists company_jurisdiction text,
  add column if not exists company_active boolean,
  add column if not exists company_checked_at timestamptz;

comment on column public.agent_owners.company_id is
  'A register identifier the owner ASSERTS (EU VAT number or ISO 17442 LEI), '
  'normalised. Looked up and confirmed to exist; NEVER proven to belong to this '
  'tenant. Must not influence tier — see 0048 header.';

comment on column public.agent_owners.company_checked_at is
  'When the register last answered. Stale is not wrong: a company that was real '
  'last month is still evidence, and the date is shown so a reader can judge it.';

-- Both writes stay service_role. 0017 grants `authenticated` SELECT and nothing
-- else, so no grant changes here — a client that could write company_name could
-- publish any legal name it liked next to a proven domain, which is the exact
-- failure the tier rule exists to prevent, one column over.

-- ============================================================================
-- verify_passport v3 — the same question, plus the company line.
--
-- DROP and recreate, NOT `create or replace`: Postgres refuses to change the
-- return type of an existing function, and widening a RETURNS TABLE is exactly
-- that. 0017 hit the same wall and documented the trap that comes with it —
--
--   DROPPING A FUNCTION DISCARDS ITS ACL, and a newly created function defaults
--   to EXECUTE for PUBLIC. Without the revoke re-issued below, anon could call
--   this RPC directly through PostgREST, silently undoing 0015's central
--   protection. The grants at the bottom are not belt-and-braces; they are the
--   only thing standing between anon and this function.
-- ============================================================================

drop function if exists public.verify_passport(text);

create function public.verify_passport(p_passport_id text)
returns table (
  passport_pubkey      text,
  status               text,
  created_at           timestamptz,
  owner_kind           text,
  owner_subject        text,
  owner_tier           text,
  owner_verified_at    timestamptz,
  owner_company_id     text,
  owner_company_source text,
  owner_company_name   text,
  owner_company_active boolean,
  owner_company_at     timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    a.passport_pubkey,
    a.status::text,
    a.created_at,
    o.kind,
    o.subject,
    o.tier,
    o.verified_at,
    o.company_id,
    o.company_source,
    o.company_name,
    o.company_active,
    o.company_checked_at
  from public.agents a
  -- `and o.published` stays part of the JOIN, not a WHERE: an unpublished owner
  -- must yield NULL owner columns, not suppress the passport row entirely.
  left join public.agent_owners o
    on o.user_id = a.user_id and o.published
  where a.passport_pubkey = p_passport_id
  limit 1
$$;

comment on function public.verify_passport(text) is
  'Public passport verification (PAVP). Returns the issued/revoked state of one '
  'passport by its public key, a published owner assertion with its tier, and an '
  'asserted company register line. Never returns user_id, name, scopes, budgets, '
  'traffic, or a postal address. SECURITY DEFINER, service_role execute only.';

revoke all on function public.verify_passport(text) from public, anon, authenticated;
grant execute on function public.verify_passport(text) to service_role;
