import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const path = join(
  process.cwd(),
  "db/migrations/0047_sender_constrained_auth_method.sql"
);

describe("sender-constrained auth_method migration", () => {
  it("adds one durable third value without changing the agent opt-in default", () => {
    expect(existsSync(path)).toBe(true);
    const sql = readFileSync(path, "utf8");

    expect(sql).toMatch(
      /auth_method in \('passport', 'passport_proof_per_request', 'direct_key'\)/i
    );
    expect(sql).toMatch(
      /auth_method in \('passport', 'passport_proof_per_request'\)[\s\S]*passport_id is not null[\s\S]*jti is not null/i
    );
    expect(sql).not.toMatch(/alter table public\.agents/i);
    expect(sql).not.toMatch(/require_sender_constrained_visa[\s\S]*default true/i);
  });

  it("replaces and validates both existing auth constraints", () => {
    const sql = readFileSync(path, "utf8");
    for (const name of [
      "agent_logs_auth_method_known",
      "agent_logs_identity_discriminated",
    ]) {
      expect(sql).toMatch(new RegExp(`drop constraint ${name}`, "i"));
      expect(sql).toMatch(new RegExp(`add constraint ${name}`, "i"));
      expect(sql).toMatch(new RegExp(`validate constraint ${name}`, "i"));
    }
  });
});
