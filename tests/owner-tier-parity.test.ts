import { readFile } from "node:fs/promises";
import { describe, it, expect } from "vitest";

import { OWNER_TIERS } from "@/lib/owner/current";

async function migration(name: string): Promise<string> {
  return readFile(new URL(`../db/migrations/${name}`, import.meta.url), "utf8");
}

/**
 * Two independent copies of one list: the CHECK constraint in the migration and
 * the allowlist a receipt's owner claim is filtered through. The same shape that
 * kept a provider out of the beta form until somebody noticed, except this one
 * fails silently — a tier the allowlist does not know falls to `unverified` and
 * loses its verification date, so a proven owner would go out on every signed
 * receipt as unproven with nothing anywhere reporting an error.
 */
describe("the owner tier list has exactly one meaning", () => {
  it("matches the CHECK constraint the database enforces", async () => {
    const sql = await migration("0048_owner_github_and_company.sql");
    const match = sql.match(/check \(tier in \(([^)]*)\)\)/u);
    expect(match, "0048 no longer declares a tier CHECK in the shape this reads").toBeTruthy();

    const fromSql = [...(match?.[1] ?? "").matchAll(/'([a-z_]+)'/gu)].map((m) => m[1]);
    expect(fromSql).toEqual([...OWNER_TIERS]);
  });

  it("matches the kinds a binding may be declared as, plus unverified", async () => {
    const sql = await migration("0048_owner_github_and_company.sql");
    const match = sql.match(/check \(kind in \(([^)]*)\)\)/u);
    const kinds = [...(match?.[1] ?? "").matchAll(/'([a-z_]+)'/gu)].map((m) => m[1]);

    // Every tier above `unverified` is named after the kind that earns it, so a
    // kind with no matching tier could never be promoted and a tier with no
    // matching kind could never be reached.
    expect(new Set(OWNER_TIERS)).toEqual(new Set([...kinds, "unverified"].filter((k) => k !== "self_attested")));
  });
});
