import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ACCOUNT_EXPORT_SCHEMA_VERSION, loadAccountExport } from "@/lib/account-lifecycle";

// Calls a client reported (0084, subscription mode) are data held about the tenant,
// so "everything held about you" carries them. The table has `received_at`, not
// `created_at`, and a database before 0084 has no table at all: that must leave the
// section empty, never fail the whole export.
function accountDb(reported: { data: unknown[] | null; error: { code?: string } | null }) {
  const calls: { table: string; select?: string; eq: [string, unknown][]; order?: string }[] = [];
  const client = {
    from(table: string) {
      const call: (typeof calls)[number] = { table, eq: [] };
      calls.push(call);
      const chain: Record<string, unknown> = {
        select: (cols: string) => ((call.select = cols), chain),
        eq: (column: string, value: unknown) => (call.eq.push([column, value]), chain),
        order: (column: string) => ((call.order ??= column), chain),
        range: () => chain,
        maybeSingle: async () => ({ data: null, error: null }),
        then: (resolve: (v: unknown) => void) =>
          resolve(table === "client_reported_calls" ? reported : { data: [], error: null, count: 0 }),
      };
      return chain;
    },
  };
  return { client: client as never, calls };
}
const user = { id: "u1", email: "op@example.test", created_at: "2026-09-01T00:00:00Z" } as never;
const ROW = { id: "r1", agent_id: "a1", model: "claude-haiku-5-5", reported_cost_usd_micros: 1200 };

describe("the account export carries reported calls", () => {
  it("exports this tenant's reported calls, oldest first, by when they were received", async () => {
    const { client, calls } = accountDb({ data: [ROW], error: null });
    const out = await loadAccountExport(client, user, client);
    expect(out.data.reportedCalls).toEqual([ROW]);
    const read = calls.find((c) => c.table === "client_reported_calls")!;
    expect(read.eq).toContainEqual(["user_id", "u1"]);
    expect(read.order).toBe("received_at");
    // Every column 0084 creates, read from the migration itself: a column added later
    // (Phase 2's tool decisions) cannot be left out of the export unnoticed.
    const sql = readFileSync(new URL("../db/migrations/0084_client_reported_calls.sql", import.meta.url), "utf8");
    const body = sql.slice(sql.indexOf("create table if not exists public.client_reported_calls"));
    const columns = [...body.slice(0, body.indexOf("constraint")).matchAll(/^\s{2}([a-z_]+)\s+(?:uuid|text|bigint|integer|timestamptz)\b/gm)].map((m) => m[1]);
    expect(columns).toEqual(expect.arrayContaining(["tool_name", "decision", "rule_index", "status_code", "model"]));
    expect(read.select!.split(",").sort()).toEqual([...columns].sort());
  });

  it.each([["42P01"], ["PGRST205"]])("exports an empty list on a database before 0084 (%s)", async (code) => {
    const { client } = accountDb({ data: null, error: { code } });
    const out = await loadAccountExport(client, user, client);
    expect(out.data.reportedCalls).toEqual([]);
  });

  it("refuses rather than export a silent gap on any other failure", async () => {
    const { client } = accountDb({ data: null, error: { code: "57014" } });
    await expect(loadAccountExport(client, user, client)).rejects.toThrow("account_export_reportedCalls_unavailable");
  });

  it("bumped the schema version for the new section", () => {
    expect(ACCOUNT_EXPORT_SCHEMA_VERSION).toBe(4);
  });
});
