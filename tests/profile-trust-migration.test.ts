// Reserved public identities and manually issued profile checks.
//
// These are trust controls, so the useful assertions cross the application /
// database boundary: every application-reserved handle must be in the database,
// neither registry is browser-readable, and a check cannot be self-issued.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { RESERVED_HANDLES } from "@/lib/profile/handle";

const MIGRATIONS_DIR = join(process.cwd(), "db/migrations");
const migrationFiles = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith(".sql"))
  .sort();
const migrations = migrationFiles
  .map((name) => readFileSync(join(MIGRATIONS_DIR, name), "utf8"))
  .join("\n");

function seededReservedHandles(sql: string): Set<string> {
  const result = new Set<string>();
  for (const insert of sql.matchAll(
    /insert\s+into\s+public\.reserved_usernames\s*\([^)]*\)\s*values([\s\S]*?);/gi
  )) {
    for (const row of insert[1]!.matchAll(/\(\s*'([^']+)'/g)) result.add(row[1]!);
  }
  return result;
}

describe("the reserved handle registry", () => {
  it("backs every application default with a database row", () => {
    const seeded = seededReservedHandles(migrations);
    expect(seeded.size).toBeGreaterThan(40);
    for (const handle of RESERVED_HANDLES) {
      expect(seeded.has(handle), `${handle} is reserved only in TypeScript`).toBe(true);
    }
  });

  it("is private, RLS-protected, and enforced on direct writes", () => {
    expect(migrations).toMatch(/create table[^;]*public\.reserved_usernames/i);
    expect(migrations).toMatch(/alter table public\.reserved_usernames enable row level security/i);
    expect(migrations).toMatch(/revoke all on public\.reserved_usernames from (?:public,\s*)?authenticated, anon/i);
    expect(migrations).toMatch(/create trigger users_reject_reserved_username[\s\S]*?before insert or update of username/i);
  });

  it("allows an explicit account assignment without making the name public", () => {
    expect(migrations).toMatch(/assigned_user_id\s+uuid/i);
    expect(migrations).toMatch(/r\.assigned_user_id is distinct from new\.id/i);
  });
});

describe("the profile verification registry", () => {
  it("is server-only and cannot be self-issued by a browser session", () => {
    expect(migrations).toMatch(/create table[^;]*public\.profile_verifications/i);
    expect(migrations).toMatch(/alter table public\.profile_verifications enable row level security/i);
    expect(migrations).toMatch(/revoke all on public\.profile_verifications from (?:public,\s*)?authenticated, anon/i);
    expect(migrations).toMatch(/grant select, insert, update, delete on public\.profile_verifications to service_role/i);
  });

  it("is one current check per account and disappears with that account", () => {
    expect(migrations).toMatch(/user_id\s+uuid primary key[\s\S]*?references public\.users\(id\) on delete cascade/i);
  });
});
