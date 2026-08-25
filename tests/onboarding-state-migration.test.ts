import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  resolve(process.cwd(), "db/migrations/0037_onboarding_state.sql"),
  "utf8"
);

describe("durable onboarding progression migration", () => {
  it("stores only user-level dismissal and completion timestamps", () => {
    expect(sql).toMatch(/create table(?: if not exists)? public\.onboarding_state/i);
    expect(sql).toMatch(/user_id\s+uuid\s+primary key\s+references auth\.users\s*\(id\)\s+on delete cascade/i);
    expect(sql).toMatch(/dismissed_at\s+timestamptz/i);
    expect(sql).toMatch(/completed_at\s+timestamptz/i);
    expect(sql).not.toMatch(/first_provider|provider_complete|agent_complete|call_complete|security_checked/i);
  });

  it("lets an authenticated operator read only their own row", () => {
    expect(sql).toMatch(/alter table public\.onboarding_state enable row level security/i);
    expect(sql).toMatch(/for select to authenticated[\s\S]*using \(user_id = \(select auth\.uid\(\)\)\)/i);
    expect(sql).toMatch(/grant select on public\.onboarding_state to authenticated/i);
    expect(sql).not.toMatch(/grant[^;]*(?:insert|update|delete)[^;]*on public\.onboarding_state to authenticated/i);
    expect(sql).toMatch(/revoke all on public\.onboarding_state from public, anon, authenticated/i);
  });

  it("persists through narrow authenticated RPCs instead of forgeable table writes", () => {
    for (const name of ["dismiss_onboarding", "complete_onboarding"]) {
      expect(sql).toMatch(new RegExp(`create or replace function public\\.${name}\\(\\)`, "i"));
      expect(sql).toMatch(new RegExp(`${name}\\(\\)[\\s\\S]*security definer[\\s\\S]*set search_path\\s*=\\s*''`, "i"));
      expect(sql).toMatch(new RegExp(`revoke all on function public\\.${name}\\(\\) from public, anon`, "i"));
      expect(sql).toMatch(new RegExp(`grant execute on function public\\.${name}\\(\\) to authenticated`, "i"));
    }
  });

  it("validates completion from real ordered evidence and excludes agent.update", () => {
    const completion = sql.slice(sql.toLowerCase().indexOf("create or replace function public.complete_onboarding"));
    expect(completion).toMatch(/provider_credentials/i);
    expect(completion).toMatch(/agent_logs/i);
    expect(completion).toMatch(/admin_audit/i);
    expect(completion).toMatch(/aa\.created_at\s*>=\s*l\.created_at/i);
    expect(completion).toMatch(/killswitch\.master/i);
    expect(completion).toMatch(/agent\.suspend/i);
    expect(completion).not.toMatch(/aa\.action\s+in\s*\([^)]*agent\.update/i);
  });

  it("backfills operators whose historical call preceded a real stop-control event", () => {
    const beforeFunctions = sql.slice(0, sql.toLowerCase().indexOf("create or replace function"));
    expect(beforeFunctions).toMatch(/insert into public\.onboarding_state[\s\S]*select[\s\S]*agent_logs[\s\S]*admin_audit/i);
    expect(beforeFunctions).toMatch(/aa\.created_at\s*>=\s*l\.created_at/i);
    expect(beforeFunctions).not.toMatch(/aa\.action\s+in\s*\([^)]*agent\.update/i);
  });
});
