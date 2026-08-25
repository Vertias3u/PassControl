/**
 * The operator surface. Two classes of claim here, and they need different
 * tools:
 *
 *   Behaviour — the loaders return the right shape and, critically, the right
 *   COLUMNS. The column lists are the tenant/operator boundary in this feature,
 *   because problem_reports has no RLS policy to fall back on.
 *
 *   Source — the gate is re-checked inside the action, and no report content
 *   reaches markup or a URL. A page-level gate does not gate a server action,
 *   and a behavioural test of the happy path would never notice its absence.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadOwnProblemReports, loadProblemReportRows } from "@/lib/problem-reports";

type Row = Record<string, unknown>;

function client(rows: Row[], users: Row[] = [], error: { code?: string } | null = null) {
  const selected: string[] = [];
  const api = {
    selected,
    from(table: string) {
      const builder: Record<string, unknown> = {
        select(columns: string) {
          if (table === "problem_reports") selected.push(columns);
          return builder;
        },
        eq: () => builder,
        in: () => Promise.resolve({ data: users, error: null }),
        order: () => builder,
        limit: () => Promise.resolve({ data: table === "users" ? users : rows, error }),
        maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error }),
      };
      // `users` is read with .in(...) and no .limit(), so it resolves there.
      return builder;
    },
  };
  return api;
}

const REPORT: Row = {
  id: "11111111-1111-1111-1111-111111111111",
  user_id: "user-1",
  kind: "bug",
  message: "the kill switch page returns a 500",
  status: "open",
  app_version: "0.6.1",
  schema_head: "0038_problem_reports.sql",
  release_commit: null,
  diagnostics_attached: true,
  created_at: "2026-08-24T10:00:00.000Z",
  updated_at: "2026-08-24T10:00:00.000Z",
};

describe("loadOwnProblemReports", () => {
  /**
   * The reason problem_reports has no browser SELECT grant at all: those three
   * columns say how far behind this instance's database is, which doubles as a
   * list of the fixes it lacks, and /dashboard/system restricts exactly that to
   * named operators with verified TOTP.
   */
  it("never selects the operator-restricted build stamp", async () => {
    const db = client([REPORT]);
    await loadOwnProblemReports(db as never, "user-1");
    const columns = db.selected.join(" ");
    expect(columns).not.toContain("app_version");
    expect(columns).not.toContain("schema_head");
    expect(columns).not.toContain("release_commit");
  });

  it("never selects the diagnostics payload", async () => {
    const db = client([REPORT]);
    await loadOwnProblemReports(db as never, "user-1");
    expect(db.selected.join(" ")).not.toContain("diagnostics");
  });

  it("returns an empty history on a pre-0038 database rather than failing the page", async () => {
    const db = client([], [], { code: "42P01" });
    await expect(loadOwnProblemReports(db as never, "user-1")).resolves.toEqual([]);
  });

  it("raises anything that is not an absent table", async () => {
    const db = client([], [], { code: "57014" });
    await expect(loadOwnProblemReports(db as never, "user-1")).rejects.toThrow("problem_reports_unavailable");
  });
});

describe("loadProblemReportRows", () => {
  it("reads the attachment flag and not the payload", async () => {
    const db = client([REPORT], [{ id: "user-1", email: "reporter@example.com" }]);
    const rows = await loadProblemReportRows(db as never);
    // 250 rows x 256 KB would be a 64 MB response to render a checkbox.
    const columns = db.selected.join(" ");
    expect(columns).toContain("diagnostics_attached");
    expect(columns).not.toMatch(/(^|[\s,])diagnostics([\s,]|$)/);
    expect(rows[0]!.diagnosticsAttached).toBe(true);
  });

  it("masks the reporter's address before it reaches a component", async () => {
    const db = client([REPORT], [{ id: "user-1", email: "reporter@example.com" }]);
    const rows = await loadProblemReportRows(db as never);
    expect(rows[0]!.reporter).not.toContain("reporter@");
    expect(rows[0]!.reporter).toContain("@example.com");
  });

  it("says 'unknown' rather than throwing when the address cannot be resolved", async () => {
    const db = client([REPORT], []);
    const rows = await loadProblemReportRows(db as never);
    expect(rows[0]!.reporter).toBe("unknown");
  });

  it("carries the build stamp, which is what the operator surface is for", async () => {
    const db = client([REPORT], [{ id: "user-1", email: "a@b.co" }]);
    const rows = await loadProblemReportRows(db as never);
    expect(rows[0]!.appVersion).toBe("0.6.1");
    expect(rows[0]!.schemaHead).toBe("0038_problem_reports.sql");
  });
});

describe("triage — source invariants", () => {
  const action = readFileSync(resolve(process.cwd(), "app/dashboard/report/triage/actions.ts"), "utf8");
  const page = readFileSync(resolve(process.cwd(), "app/dashboard/report/triage/page.tsx"), "utf8");
  const panel = readFileSync(resolve(process.cwd(), "components/dashboard/ProblemReportTriage.tsx"), "utf8");

  /**
   * A server action is a POST endpoint anyone who knows its id can call. The
   * page it is imported by is not a boundary, so the gate has to be inside.
   */
  it("re-checks the operator gate inside the write, not only on the page", () => {
    expect(page).toMatch(/betaOperatorGate\(\)/);
    expect(action).toMatch(/betaOperatorGate\(\)/);
    expect(action.indexOf("betaOperatorGate()")).toBeLessThan(action.indexOf(".update("));
  });

  it("audits the operator who decided, not the reporter who was reported", () => {
    expect(action).toMatch(/userId: gate\.user\.id/);
    expect(action).toMatch(/action: "problem\.triage"/);
  });

  it("closes the status vocabulary rather than writing what was posted", () => {
    expect(action).toMatch(/STATUSES as readonly string\[\]\)\.includes\(status\)/);
  });

  /**
   * A `javascript:` URI pasted into a report body must not become a live link
   * on an operator's authenticated page.
   */
  it("never puts report content into markup or a URL", () => {
    expect(panel).not.toMatch(/dangerouslySetInnerHTML/);
    expect(panel).not.toMatch(/href=\{[^}]*report\./);
    expect(panel).toMatch(/\{report\.message\}/);
  });
});
