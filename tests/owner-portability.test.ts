import { readFile } from "node:fs/promises";
import { describe, it, expect } from "vitest";

async function source(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

/**
 * Every list of `agent_owners` columns outside lib/owner/ is a hand-written copy
 * of a schema that just grew. None of them fail loudly when they fall behind: an
 * export silently omits what it does not name, and an import silently rejects
 * what it does not know. Both were already behind by the time this file was
 * written — 0048's company line was missing from two exports, and `github` was
 * missing from the import allowlist, which would have refused a proven binding
 * on restore with "unknown_kind".
 */
/** The `columns:` string of the agent_owners block, with no surrounding prose. */
async function columnsFor(path: string): Promise<string> {
  const text = await source(path);
  const block = text.slice(text.indexOf('table: "agent_owners"'));
  return block.match(/columns:\s*\n?\s*"([^"]*)"/u)?.[1] ?? "";
}

describe("the owner binding survives leaving and re-entering the product", () => {
  it.each([
    ["lib/workspace-export.ts", "the workspace export"],
    ["lib/account-lifecycle.ts", "the account data export"],
  ])("%s carries the whole company line", async (path) => {
    const columns = await columnsFor(path);

    for (const column of [
      "company_id",
      "company_source",
      "company_name",
      "company_jurisdiction",
      "company_active",
      "company_checked_at",
    ]) {
      expect(columns, `${path} omits ${column}`).toContain(column);
    }
  });

  // The token is a live proof of control, not a record of one. It stays out of
  // both exports for the reason lib/workspace-export.ts already gives.
  //
  // Asserted against the COLUMN STRING, not the surrounding block: that comment
  // names `verification_token` in order to say why it is absent, so a block-wide
  // check fails on the correct code — the kind of test that gets deleted rather
  // than fixed.
  it.each(["lib/workspace-export.ts", "lib/account-lifecycle.ts"])(
    "%s still never exports the verification token",
    async (path) => {
      expect(await columnsFor(path)).not.toContain("verification_token");
    }
  );

  it("accepts every kind the database allows on import", async () => {
    const [importer, migration] = await Promise.all([
      source("lib/workspace-import.ts"),
      source("db/migrations/0048_owner_github_and_company.sql"),
    ]);

    const allowed = [
      ...(importer.match(/const OWNER_KINDS = new Set\(\[([^\]]*)\]/u)?.[1] ?? "").matchAll(
        /"([a-z_]+)"/gu
      ),
    ].map((m) => m[1]);
    const constrained = [
      ...(migration.match(/check \(kind in \(([^)]*)\)\)/u)?.[1] ?? "").matchAll(/'([a-z_]+)'/gu),
    ].map((m) => m[1]);

    expect(allowed.sort()).toEqual(constrained.sort());
  });
});
