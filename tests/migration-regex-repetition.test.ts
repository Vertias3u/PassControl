import { readdirSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";

// Postgres refuses a regex repetition count above 255 (RE_DUP_MAX), and it does so
// only when the pattern is evaluated, not when the migration that declares it runs.
// So a check constraint like `~ '^[A-Za-z0-9_-]{1,1364}$'` applies cleanly and then
// refuses every insert into its table. 0089 hit this; 0094 did it again on
// mission_owner_keys.credential_id, which would have refused every passkey.
// Write a length bound with char_length() instead.
const dir = new URL("../db/migrations/", import.meta.url);

function withoutComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
}

it("no migration uses a regex repetition count Postgres would refuse", () => {
  const offenders: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = withoutComments(readFileSync(new URL(file, dir), "utf8"));
    for (const m of sql.matchAll(/\{(\d+)(?:,(\d*))?\}/g)) {
      const counts = [m[1], m[2]].filter((n): n is string => !!n).map(Number);
      if (counts.some((n) => n > 255)) offenders.push(`${file}: ${m[0]}`);
    }
  }
  expect(offenders).toEqual([]);
});
