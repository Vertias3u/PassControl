import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repo = process.cwd();

describe("agent policy migration", () => {
  it("adds only a nullable jsonb policy column with an empty-object default", () => {
    const sql = readFileSync(join(repo, "db/migrations/0014_agent_policy.sql"), "utf8");

    expect(sql).toMatch(/alter table public\.agents\s+add column policy jsonb/i);
    expect(sql).toMatch(/default\s+'\{\}'::jsonb/i);
    expect(sql).not.toMatch(/policy jsonb[^;]*not null/i);
    expect(sql).not.toMatch(/create policy/i);
  });

  it("inherits the existing authenticated update allowlist instead of widening it", () => {
    const lockSql = readFileSync(
      join(repo, "db/migrations/0011_lock_agent_status.sql"),
      "utf8"
    );

    expect(lockSql).toMatch(/revoke update on public\.agents from authenticated, anon/i);
    expect(lockSql).toMatch(/grant update \(name, allowed_scopes, budget_tokens, budget_cents\)/i);
    expect(lockSql).not.toMatch(/grant update \([^)]*policy/i);
  });
});
