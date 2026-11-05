import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dir = join(process.cwd(), "db/migrations");
const migrations = readdirSync(dir).filter(name => /^\d+.*\.sql$/.test(name)).sort();
const statements = migrations.flatMap(file => readFileSync(join(dir, file), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/--[^\n]*/g, "")
  .split(";")
  .map(sql => ({ file, sql: sql.trim().toLowerCase() })));

// Follow table privilege changes in apply order, including multi-table GRANT ALL
// and later grants that could accidentally reopen the hole. Hosted Supabase also
// grants these rights implicitly on CREATE; require an explicit final REVOKE.
function lastPrivilege(table: string, role: string, privilege: string) {
  let last: { file: string; action: string } | undefined;
  for (const { file, sql } of statements) {
    const match = sql.match(/^(grant|revoke)\s+(.+?)\s+on\s+(?:table\s+)?([\s\S]+?)\s+(?:to|from)\s+(.+)$/s);
    if (!match) continue;
    const [, action = "", privileges = "", tables = "", roles = ""] = match;
    if (!tables.split(",").map(s => s.trim()).includes(`public.${table}`)) continue;
    if (!roles.split(",").map(s => s.trim()).includes(role)) continue;
    if (!/\ball\b/.test(privileges) && !privileges.split(",").map(s => s.trim()).includes(privilege)) continue;
    last = { file, action };
  }
  return last;
}

describe("latent table privilege hardening", () => {
  it.each(["admin_audit", "agent_spend_checkpoint", "agent_owners", "break_glass_grants"])(
    "%s leaves TRUNCATE, TRIGGER and REFERENCES revoked from both API roles",
    table => {
      for (const role of ["anon", "authenticated"]) {
        for (const privilege of ["truncate", "trigger", "references"]) {
          const last = lastPrivilege(table, role, privilege);
          expect(last, `${table}: ${role} ${privilege}`).toMatchObject({ action: "revoke" });
          expect(last!.file > "0007_grants.sql").toBe(true);
        }
      }
    },
  );
});
