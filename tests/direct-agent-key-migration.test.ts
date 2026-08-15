import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "db/migrations/0023_direct_agent_keys_expand.sql"),
  "utf8"
);

describe("Direct Agent Key expansion migration", () => {
  it("makes the old writer safe before adding direct identity columns", () => {
    expect(migration).toMatch(/alter column passport_id drop not null/i);
    expect(migration).toMatch(/alter column jti drop not null/i);
    expect(migration).toMatch(/add column if not exists auth_method text default 'passport'/i);
    expect(migration).toMatch(/update public\.agent_logs\s+set auth_method = 'passport'/i);
  });

  it("does not prematurely enforce the post-deploy discriminated check", () => {
    expect(migration).not.toMatch(/agent_logs_auth_shape_check/i);
    expect(migration).not.toMatch(/alter column auth_method set not null/i);
  });

  it("invalidates keys but preserves their identity when an agent is deleted", () => {
    expect(migration).toMatch(/agent_id\s+uuid references public\.agents\(id\) on delete set null/i);
    expect(migration).toMatch(/user_id\s+uuid references public\.users\(id\) on delete set null/i);
    expect(migration).toMatch(/agent_access_key_id[\s\S]*on delete restrict/i);
    // The two SET NULL cascades can fire in either order during account
    // deletion. A cross-column CHECK here can make deletion fail halfway.
    expect(migration).not.toMatch(/check \(user_id is not null or agent_id is null\)/i);
  });

  it("keeps hashes and authentication RPCs off the authenticated API", () => {
    expect(migration).toMatch(/revoke all on public\.agent_access_keys from anon, authenticated/i);
    expect(migration).toMatch(/grant all on public\.agent_access_keys to service_role/i);
    expect(migration).toMatch(/revoke all on function public\.authenticate_direct_agent_key\(text\)/i);
    expect(migration).toMatch(/grant execute on function public\.authenticate_direct_agent_key\(text\) to service_role/i);
  });

  it("creates and revokes credentials only through service-role lifecycle RPCs", () => {
    expect(migration).toMatch(/function public\.create_direct_agent\(/i);
    expect(migration).toMatch(/function public\.create_agent_access_key\(/i);
    expect(migration).toMatch(/function public\.revoke_agent_access_key\(/i);
    expect(migration).toMatch(/function public\.attach_agent_passport\(/i);
    expect(migration).toMatch(/grant execute on function public\.create_direct_agent\([\s\S]*?to service_role/i);
    expect(migration).toMatch(/grant execute on function public\.create_agent_access_key\([\s\S]*?to service_role/i);
    expect(migration).toMatch(/grant execute on function public\.revoke_agent_access_key\([\s\S]*?to service_role/i);
  });

  it("upgrades identity in place and refuses a live cross-column key collision", () => {
    expect(migration).toMatch(/function public\.attach_agent_passport\(/i);
    expect(migration).toMatch(/previous_passport_pubkey = p_passport_pubkey[\s\S]*previous_valid_until > now\(\)/i);
    expect(migration).toMatch(/update public\.agents[\s\S]*passport_pubkey = p_passport_pubkey[\s\S]*a\.id = p_agent_id/i);
    expect(migration).not.toMatch(/delete from public\.agents/i);
  });

  it("serializes and enforces only a workspace-wide active-key ceiling", () => {
    expect(migration).toMatch(/pg_advisory_xact_lock/i);
    expect(migration).toMatch(/active_key_limit/i);
    expect(migration).toMatch(/count\(\*\)[\s\S]*user_id = p_user_id[\s\S]*revoked_at is null/i);
    expect(migration).not.toMatch(/count\(\*\)[\s\S]{0,220}agent_id = p_agent_id[\s\S]{0,220}active_key_limit/i);
  });

  it("derives key activity from immutable logs rather than a stale last_used column", () => {
    expect(migration).not.toMatch(/add column(?: if not exists)? last_used_at/i);
    expect(migration).not.toMatch(/agent_access_keys \([\s\S]*?last_used_at[\s\S]*?\);/i);
    expect(migration).toMatch(/function public\.agent_access_key_activity\(/i);
    expect(migration).toMatch(/max\(l\.created_at\)/i);
  });
});
