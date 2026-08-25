// What the banner actually renders.
//
// CLAUDE.md's rule, learned from the receipt page: a green suite says nothing
// about the DOM. A forged receipt once displayed "Signature matches ✓" against
// a green rail while every test passed. So these assert on `data-*` and on the
// words an operator reads, not on the collector's return value — which
// tests/migration-banner.test.ts already covers.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { MigrationBanner } from "@/components/dashboard/MigrationBanner";
import type { SystemHealthSnapshot } from "@/lib/system-health";


type Migrations = SystemHealthSnapshot["migrations"];

const migrations = (over: Partial<Migrations> = {}): Migrations => ({
  state: "current",
  expected_head: "0036_system_health_snapshot.sql",
  applied_head: "0036_system_health_snapshot.sql",
  missing_count: 0,
  extra_count: 0,
  action: "Migration ledger matches this build.",
  ...over,
});

// renderToStaticMarkup, matching tests/system-health-ui.test.tsx — this repo has
// no @testing-library, and a static render is enough for a component with no
// state: the question is what the DOM says, not how it reacts.
const html = (m: Migrations) => renderToStaticMarkup(<MigrationBanner migrations={m} />);

describe("MigrationBanner", () => {
  it("renders NOTHING when the ledger matches", () => {
    // A banner that is always present is furniture, and furniture is ignored
    // on the day it finally means something.
    expect(html(migrations())).toBe("");
  });

  it("warns, with the count, when the database is behind", () => {
    const out = html(
      migrations({
        state: "behind",
        applied_head: "0026_agent_logs_identity_contract.sql",
        missing_count: 10,
      })
    );
    expect(out).toContain('data-migration-state="behind"');
    expect(out).toContain('data-state="attention"');
    expect(out).toContain("missing 10 migrations");
    expect(out).toContain("0026_agent_logs_identity_contract.sql");
  });

  it("says 'migration', singular, when exactly one is missing", () => {
    expect(html(migrations({ state: "behind", missing_count: 1 }))).toContain("missing 1 migration ");
  });

  it("tells ahead apart from behind, in words and not only in a state", () => {
    // The fix is the opposite one. A banner that said "apply your migrations"
    // here would send an operator the wrong way.
    const out = html(migrations({ state: "ahead", extra_count: 2 }));
    expect(out).toContain('data-migration-state="ahead"');
    expect(out).toContain("newer than the build");
    expect(out).toContain("rolled back");
    expect(out).not.toContain("missing");
  });

  it("shows incompatible as the loudest state", () => {
    const out = html(migrations({ state: "incompatible" }));
    expect(out).toContain('data-state="incompatible"');
    expect(out).toContain("do not match this build");
  });

  it("admits it does not know, rather than implying health", () => {
    const out = html(migrations({ state: "unknown", applied_head: null }));
    expect(out).toContain('data-migration-state="unknown"');
    expect(out).toContain("could not be read");
  });

  it("always offers the way to the detail", () => {
    expect(html(migrations({ state: "behind" }))).toContain('href="/dashboard/system"');
  });

  it("is announced to a screen reader without stealing focus", () => {
    const out = html(migrations({ state: "behind" }));
    expect(out).toContain('role="status"');
    expect(out).toContain('aria-live="polite"');
  });
});

describe("the shell only reads it for an operator", () => {
  // The privacy property, and the reason this is a source test: how far behind a
  // database is doubles as a list of the fixes it does not have. On Cloud that
  // must never reach a tenant, and it must not cost one a query either. Move the
  // call above the gate and both break silently — the banner would simply start
  // appearing for people it was never meant for.
  const shell = readFileSync(
    resolve(process.cwd(), "components/dashboard/DashboardShell.tsx"),
    "utf8"
  );

  it("guards the read on the operator check", () => {
    expect(shell).toMatch(/showSystemHealth[\s\S]*getCachedMigrationHealth\(\)[\s\S]*:\s*null/);
  });

  it("uses the detailed page's own migration verdict so refresh cannot contradict its banner", () => {
    expect(shell).toContain("migrationHealth");
    expect(shell).toMatch(/migrationHealth\s*!==\s*undefined[\s\S]*migrationHealth[\s\S]*getCachedMigrationHealth\(\)/);
  });

  it("computes the operator check before reading", () => {
    expect(shell.indexOf("const showSystemHealth")).toBeLessThan(
      shell.indexOf("getCachedMigrationHealth()")
    );
  });

  it("renders the banner only when there is a verdict", () => {
    expect(shell).toMatch(/migrations \? <MigrationBanner migrations=\{migrations\} \/> : null/);
  });
});
