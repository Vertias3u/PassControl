import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 0023's `authenticate_direct_agent_key` filtered `a.status = 'active'`, so a
 * SUSPENDED agent's key looked exactly like an unknown one: 401
 * `invalid_credential`, no audit row. The suspend gate in the proxy never ran.
 * Found live on 2026-09-21 with an unchanged external workload.
 */
const path = join(process.cwd(), "db/migrations/0071_direct_key_sees_suspended_agents.sql");

describe("0071: a suspended agent's Direct Agent Key still authenticates", () => {
  it("exists", () => {
    expect(existsSync(path)).toBe(true);
  });

  const sql = () => readFileSync(path, "utf8");
  const body = () => sql().replace(/^\s*--.*$/gm, "");

  it("recreates the RPC, because its return shape changes", () => {
    expect(body()).toMatch(/drop function if exists public\.authenticate_direct_agent_key\(text\)/i);
    expect(body()).toMatch(/create function public\.authenticate_direct_agent_key\(p_key_hash text\)/i);
  });

  it("returns the agent's status so the gateway can refuse it with a reason", () => {
    expect(body()).toMatch(/agent_status\s+text/i);
    expect(body()).toMatch(/a\.status::text/i);
  });

  it("admits active and suspended agents and never revoked ones", () => {
    expect(body()).toMatch(/a\.status in \('active', 'suspended'\)/i);
    expect(body()).not.toMatch(/a\.status = 'active'/i);
    expect(body()).not.toMatch(/'revoked'\s*\)/i);
  });

  it("keeps every other credential check from 0023", () => {
    expect(body()).toMatch(/k\.key_hash = p_key_hash/i);
    expect(body()).toMatch(/k\.revoked_at is null/i);
    expect(body()).toMatch(/k\.expires_at is null or k\.expires_at > now\(\)/i);
    expect(body()).toMatch(/security definer/i);
    expect(body()).toMatch(/set search_path = ''/i);
  });

  it("stays service-role only", () => {
    expect(body()).toMatch(
      /revoke all on function public\.authenticate_direct_agent_key\(text\) from public, anon, authenticated/i
    );
    expect(body()).toMatch(
      /grant execute on function public\.authenticate_direct_agent_key\(text\) to service_role/i
    );
  });
});
