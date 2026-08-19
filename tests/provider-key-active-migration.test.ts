// The bug this migration closes, recorded because the shape of it is the point.
//
// 0001's get_provider_key selected `order by pc.created_at asc limit 1` — the
// OLDEST credential for a (user, provider) pair. provider_credentials is
// `unique (user_id, provider, label)`, and store_provider_key only ever INSERTs,
// so adding a second key for a provider creates a row the gateway can never
// reach. On 2026-08-17 the owner's Anthropic key expired, every upstream call
// returned 401, a replacement key was added — and the gateway kept injecting the
// expired one. Not a cache window: permanent. There was no UI to rotate, switch
// or delete, so the only exit was SQL against the live database.
//
// These are text assertions over the migration file, which is the only gate
// available: the local Supabase stack's PostgREST container is the documented
// dead one and .env.local points at the non-live project, so db/tests/*.sql
// cannot run here. Same pattern as 0023's migration test.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "db/migrations/0027_provider_credential_active.sql"),
  "utf8"
);

describe("active provider credential migration", () => {
  it("stops selecting the oldest credential and prefers the active one", () => {
    // The exact defect: an unqualified oldest-first pick.
    expect(migration).not.toMatch(/order by\s+pc\.created_at asc\s*\n\s*limit 1/i);
    expect(migration).toMatch(/create or replace function public\.get_provider_key/i);
    expect(migration).toMatch(/order by\s+pc\.is_active desc/i);
  });

  it("keeps a deterministic pick when nothing is marked active", () => {
    // Never an arbitrary row: an unordered `limit 1` would make which key gets
    // billed depend on the plan. created_at asc is the legacy behaviour, kept
    // deliberately as the tiebreak so this migration cannot change any tenant's
    // traffic on the day it lands.
    expect(migration).toMatch(/order by\s+pc\.is_active desc,\s*pc\.created_at asc/i);
  });

  it("backfills the row that is being injected TODAY, not the newest", () => {
    // A newest-wins backfill would silently move which upstream account gets
    // billed for every tenant holding two keys. The migration must be a no-op on
    // live traffic; switching is an explicit operator action afterwards.
    expect(migration).toMatch(/distinct on \(user_id, provider\)/i);
    expect(migration).toMatch(/order by user_id, provider, created_at asc/i);
    expect(migration).not.toMatch(/order by user_id, provider, created_at desc/i);
  });

  it("permits at most one active credential per provider, in the database", () => {
    expect(migration).toMatch(
      /create unique index[\s\S]{0,120}provider_credentials[\s\S]{0,120}\(user_id, provider\)[\s\S]{0,40}where is_active/i
    );
  });

  it("activates the first credential a tenant stores for a provider", () => {
    // Otherwise a brand-new tenant inserts is_active=false, nothing is active,
    // and the very first call 409s with no_provider_key.
    expect(migration).toMatch(/create or replace function public\.store_provider_key/i);
    expect(migration).toMatch(/not exists[\s\S]{0,200}is_active/i);
  });

  it("refuses to delete the credential that is currently being injected", () => {
    // A delete that silently promoted another row could change which upstream
    // account gets billed with no explicit operator decision behind it.
    expect(migration).toMatch(/create or replace function public\.delete_provider_key/i);
    expect(migration).toMatch(/raise exception 'active_credential'/i);
  });

  it("removes the Vault secret when a credential row is deleted", () => {
    // provider_credentials holds only a reference; 0024 makes the same point.
    expect(migration).toMatch(/delete from vault\.secrets/i);
  });

  it("derives ownership from auth.uid() in every new mutation", () => {
    // Never a caller-supplied user id — the rule every RPC in 0001 follows.
    for (const fn of ["set_active_provider_key", "delete_provider_key"]) {
      const body = migration.slice(
        migration.indexOf(`function public.${fn}`),
        migration.indexOf(`function public.${fn}`) + 1600
      );
      expect(body).toMatch(/auth\.uid\(\)/);
      expect(body).toMatch(/raise exception 'not authenticated'/i);
      expect(body).toMatch(/security definer/i);
      expect(body).toMatch(/set search_path = ''/);
    }
  });

  // NOTE: 0027's grants below are historical. 0030 supersedes them — it drops
  // these auth.uid()-derived functions entirely and replaces them with
  // service-role-only *_for_user variants, because `authenticated` EXECUTE meant
  // an aal1 session could call them over /rest/v1/rpc and skip the MFA gate.
  // These assertions still describe what 0027 says, which is what they pin; the
  // live privilege boundary is pinned by db/tests/rls_invariants.sql.
  it("keeps the new mutations off the anonymous API", () => {
    expect(migration).toMatch(
      /revoke all on function public\.set_active_provider_key\(uuid\) from public, anon/i
    );
    expect(migration).toMatch(
      /grant execute on function public\.set_active_provider_key\(uuid\) to authenticated, service_role/i
    );
    expect(migration).toMatch(
      /revoke all on function public\.delete_provider_key\(uuid\) from public, anon/i
    );
    expect(migration).toMatch(
      /grant execute on function public\.delete_provider_key\(uuid\) to authenticated, service_role/i
    );
  });

  it("leaves get_provider_key service-role only", () => {
    // It is the single decrypt path. Re-granting it in a later migration is the
    // one mistake here that would be a credential disclosure rather than a bug.
    expect(migration).toMatch(
      /revoke all on function public\.get_provider_key\(uuid, text\) from public, anon, authenticated/i
    );
    expect(migration).not.toMatch(
      /grant execute on function public\.get_provider_key\(uuid, text\) to authenticated/i
    );
  });

  it("still re-derives ownership through the agent join it always did", () => {
    // get_provider_key takes an agent id from the gateway and must never trust a
    // caller-supplied user. The join and the active-agent filter are load-bearing.
    expect(migration).toMatch(/join public\.provider_credentials pc\s*\n\s*on pc\.user_id = a\.user_id/i);
    expect(migration).toMatch(/a\.status = 'active'/);
  });
});
