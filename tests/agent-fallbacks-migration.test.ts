import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repo = process.cwd();
const sql = readFileSync(join(repo, "db/migrations/0018_agent_fallbacks.sql"), "utf8");

describe("agent fallbacks migration", () => {
  // Off by default, in both spellings. A deployment that runs this migration and
  // nothing else must behave byte-for-byte as it did before failover existed.
  it("defaults to an empty list so existing agents are unchanged", () => {
    expect(sql).toMatch(/alter table public\.agents\s+add column fallbacks jsonb/i);
    expect(sql).toMatch(/default\s+'\[\]'::jsonb/i);
  });

  // Migration 0011 replaced the table-wide authenticated UPDATE with a column
  // allowlist, because RLS confines a user to their own row but does not stop
  // them PATCHing any column of it. A column with a dashboard write path has to
  // be named there or the authenticated client simply cannot write it — which is
  // the difference between this column and 0014's policy, which has no write
  // path at all.
  it("grants exactly the one column it needs, and no more", () => {
    expect(sql).toMatch(/grant update \(fallbacks\)\s+on public\.agents to authenticated/i);
    expect(sql).not.toMatch(/grant update on public\.agents/i);
    expect(sql).not.toMatch(/grant update \([^)]*status/i);
    expect(sql).not.toMatch(/grant .*(insert|delete)/i);
  });

  it("does not touch RLS", () => {
    expect(sql).not.toMatch(/create policy/i);
    expect(sql).not.toMatch(/alter table[^;]*(disable|force) row level security/i);
  });

  // The 0011 allowlist itself must stay as it was; this migration adds to the
  // grant, it does not restate or widen the original.
  it("leaves the original allowlist intact", () => {
    const lockSql = readFileSync(join(repo, "db/migrations/0011_lock_agent_status.sql"), "utf8");
    expect(lockSql).toMatch(/grant update \(name, allowed_scopes, budget_tokens, budget_cents\)/i);
    expect(lockSql).not.toMatch(/fallbacks/i);
  });
});
