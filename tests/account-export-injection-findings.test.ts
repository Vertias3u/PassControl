import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ACCOUNT_EXPORT_SCHEMA_VERSION, loadAccountExport } from "@/lib/account-lifecycle";

// Injection findings are tenant data, including when a service-role client exports them.
type Answer = { data: unknown[] | null; error: { code?: string } | null };
function accountDb(findings: Answer | ((select: string) => Answer)) {
  const calls: { table: string; select?: string; eq: [string, unknown][]; order: [string, unknown][] }[] = [];
  const client = {
    from(table: string) {
      const call: (typeof calls)[number] = { table, eq: [], order: [] };
      calls.push(call);
      const chain: Record<string, unknown> = {
        select: (cols: string) => ((call.select = cols), chain),
        eq: (column: string, value: unknown) => (call.eq.push([column, value]), chain),
        order: (column: string, options: unknown) => (call.order.push([column, options]), chain),
        range: () => chain,
        maybeSingle: async () => ({ data: null, error: null }),
        then: (resolve: (v: unknown) => void) =>
          resolve(
            table !== "injection_findings"
              ? { data: [], error: null, count: 0 }
              : typeof findings === "function"
                ? findings(call.select ?? "")
                : findings
          ),
      };
      return chain;
    },
  };
  return { client: client as never, calls };
}
const user = { id: "u1", email: "op@example.test", created_at: "2026-09-01T00:00:00Z" } as never;
const ROW = { id: "f1", user_id: "u1", agent_id: "a1", families: ["role_markup"], content_hmac: "a".repeat(64), normalization_version: 1 };

describe("the account export carries injection findings", () => {
  it("exports this tenant's injection findings, oldest first with a stable ID order", async () => {
    const { client, calls } = accountDb({ data: [ROW], error: null });
    const out = await loadAccountExport(client, user, client);
    expect(out.data.injectionFindings).toEqual([ROW]);
    const read = calls.find((c) => c.table === "injection_findings")!;
    expect(read.eq).toContainEqual(["user_id", "u1"]);
    expect(read.order).toEqual([["created_at", { ascending: true }], ["id", { ascending: true }]]);
    // Read every column from the migrations, including arrays and small integers: 0089
    // creates the table, and any later one adds to it.
    const sql = readFileSync(new URL("../db/migrations/0089_injection_findings.sql", import.meta.url), "utf8");
    const body = sql.slice(sql.indexOf("create table if not exists public.injection_findings"));
    const columns = [...body.slice(0, body.indexOf("constraint")).matchAll(/^\s{2}([a-z_]+)\s+(?:uuid|text(?:\[\])?|bigint|integer|smallint|timestamptz)(?=\s|,)/gm)].map((m) => m[1]);
    const later = readFileSync(new URL("../db/migrations/0090_injection_findings_sidecar.sql", import.meta.url), "utf8");
    columns.push(...[...later.matchAll(/add column if not exists ([a-z_]+)/g)].map((m) => m[1]));
    expect(columns).toEqual(expect.arrayContaining(["families", "content_hmac", "normalization_version", "tool_name"]));
    expect(read.select!.split(",").sort()).toEqual([...columns].sort());
  });

  it.each([["42P01"], ["PGRST205"]])("exports an empty list on a database before 0089 (%s)", async (code) => {
    const { client } = accountDb({ data: null, error: { code } });
    const out = await loadAccountExport(client, user, client);
    expect(out.data.injectionFindings).toEqual([]);
  });

  it("still exports a database at 0089, before 0090's tool_name", async () => {
    const { client, calls } = accountDb((select) =>
      select.includes("tool_name") ? { data: null, error: { code: "42703" } } : { data: [ROW], error: null }
    );
    const out = await loadAccountExport(client, user, client);
    expect(out.data.injectionFindings).toEqual([ROW]);
    const reads = calls.filter((c) => c.table === "injection_findings");
    expect(reads.at(-1)!.select).not.toContain("tool_name");
    expect(reads.every((c) => c.eq.some(([column, value]) => column === "user_id" && value === "u1"))).toBe(true);
  });

  it("refuses rather than export a silent gap on any other failure", async () => {
    const { client } = accountDb({ data: null, error: { code: "57014" } });
    await expect(loadAccountExport(client, user, client)).rejects.toThrow("account_export_injectionFindings_unavailable");
  });

  it("bumped the schema version for the new section", () => {
    expect(ACCOUNT_EXPORT_SCHEMA_VERSION).toBe(5);
  });
});
