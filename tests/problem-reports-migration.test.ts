/**
 * Asserted as text rather than executed, matching every other
 * *-migration.test.ts here: the claims are about what the file GRANTS, and a
 * grant that is wrong is wrong whether or not a database happens to be running.
 * The live-Postgres counterpart is db/tests/rls_invariants.sql, which proves the
 * same properties behave; this file is what fails in CI without a database.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(resolve(process.cwd(), "db/migrations/0038_problem_reports.sql"), "utf8");

describe("0038_problem_reports", () => {
  it("stores a report and its provenance, and collects nothing else", () => {
    expect(sql).toMatch(/create table if not exists public\.problem_reports/);
    for (const column of [
      "user_id",
      "kind",
      "message",
      "diagnostics",
      "app_version",
      "schema_head",
      "release_commit",
      "status",
    ]) {
      expect(sql).toContain(column);
    }
    // The reporter is the user_id and nothing more. An email, an IP or a user
    // agent copied in here would be collection the consent screen never named.
    // Scoped to the column list: the claim is about what the table STORES, and
    // matching the whole file would fail on the prose that explains it.
    // Scoped to the column definitions with comments stripped: the claim is
    // about what the table STORES, and the prose that explains a column is
    // free to use the same words the column list must not contain.
    const columns = sql
      .slice(
        sql.indexOf("create table if not exists public.problem_reports"),
        sql.indexOf("create index if not exists problem_reports_created_idx")
      )
      .replace(/--[^\n]*/g, "");
    expect(columns).not.toMatch(/\b(email|ip_address|user_agent|browser|session|prompt|response)\b/i);
  });

  it("bounds the free text and closes the kind and status vocabularies", () => {
    expect(sql).toMatch(/char_length\(message\) between 20 and 4000/);
    expect(sql).toMatch(/kind in \('bug', 'confusing', 'feature', 'security'\)/);
    expect(sql).toMatch(/status in \('open', 'acknowledged', 'resolved'\)/);
  });

  /**
   * The consent flag exists so the triage LIST can render "diagnostics
   * attached" without selecting up to 256 KB per row. A denormalised flag that
   * can disagree with the payload is worse than no flag — an operator would
   * read "none attached" on a report that carries one — so the disagreement is
   * made unrepresentable rather than merely unlikely.
   */
  it("cannot store a consent flag that disagrees with the payload", () => {
    expect(sql).toMatch(/diagnostics_attached boolean not null default false/);
    expect(sql).toMatch(/diagnostics_attached = \(diagnostics is not null\)/);
  });

  it("caps the artifact, because jsonb has no natural bound and this is a free tier", () => {
    expect(sql).toMatch(/octet_length\(diagnostics::text\) <= 262144/);
  });

  /**
   * The security argument for the whole table, in both directions.
   *
   * Write: an INSERT grant to the browser routes around lib/redact.ts and the
   * rate limiter in one step.
   *
   * Read: RLS filters rows, not columns — a table-level SELECT grant with an
   * owner policy would hand every tenant the `schema_head` and `app_version`
   * columns, which /dashboard/system deliberately restricts to named operators
   * with verified TOTP. So there is no grant and no policy at all.
   */
  it("is unreachable to the browser: no grant, no policy, RLS still on", () => {
    expect(sql).toMatch(/alter table public\.problem_reports enable row level security/);
    expect(sql).toMatch(/revoke all on public\.problem_reports from public, anon, authenticated/);
    expect(sql).toMatch(/grant select, insert, update, delete on public\.problem_reports to service_role/);
    expect(sql).not.toMatch(/grant[^;]*on public\.problem_reports to authenticated/i);
    expect(sql).not.toMatch(/grant[^;]*on public\.problem_reports to anon/i);
    expect(sql).not.toMatch(/create policy[^;]*on public\.problem_reports/i);
  });

  it("cascades on account deletion, so erasure reaches a report", () => {
    expect(sql).toMatch(/user_id\s+uuid not null references public\.users\(id\) on delete cascade/);
  });

  it("ages out resolved reports only — an unanswered one is never deleted", () => {
    const purge = sql.slice(sql.toLowerCase().indexOf("create or replace function public.purge_problem_reports"));
    expect(purge).toMatch(/security definer/);
    expect(purge).toMatch(/set search_path = ''/);
    expect(purge).toMatch(/where status = 'resolved'/);
    expect(purge).toMatch(/updated_at < now\(\) - interval '180 days'/);
    expect(purge).toMatch(/revoke all on function public\.purge_problem_reports\(\) from public, anon, authenticated/);
    expect(purge).toMatch(/grant execute on function public\.purge_problem_reports\(\) to service_role/);
    // Not executable by a browser session under any allowlist.
    expect(purge).not.toMatch(/grant execute[^;]*to authenticated/i);
  });

  it("indexes both read paths the product actually issues", () => {
    expect(sql).toMatch(/problem_reports_created_idx[\s\S]*created_at desc/);
    expect(sql).toMatch(/problem_reports_user_created_idx[\s\S]*\(user_id, created_at desc\)/);
  });
});
