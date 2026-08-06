// The Control Tower is a surface you WATCH. Setup panels that live on it push
// the fleet table below the fold and cost serial round trips on every load, so
// where each section lives is a decision worth pinning.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const dashboard = read("app/dashboard/page.tsx");
const settings = read("app/dashboard/settings/page.tsx");
const middleware = read("middleware.ts");

describe("settings is behind the same gates as the Control Tower", () => {
  it("is not a public path", () => {
    // The single most expensive mistake available here: this page renders the
    // provider-key manager. PUBLIC_PATHS matches on prefix, so `/dashboard`
    // appearing in it would expose every dashboard route.
    const list = middleware.slice(middleware.indexOf("const PUBLIC_PATHS"));
    const line = list.slice(0, list.indexOf("]"));
    expect(line).not.toMatch(/["']\/dashboard/);
  });

  it("redirects an anonymous visitor and enforces the MFA step-up", () => {
    expect(settings).toMatch(/if \(!user\) redirect\("\/login"\)/);
    expect(settings).toMatch(/needsMfaStepUp\(db\)\) redirect\("\/login\/verify"\)/);
  });
});

describe("setup panels left the Control Tower", () => {
  it.each(["MfaManager", "ProviderKeysManager", "ApiKeysManager"])(
    "%s renders on settings, not on the dashboard",
    (component) => {
      expect(settings).toContain(`<${component}`);
      expect(dashboard).not.toContain(`<${component}`);
    }
  );

  it("drops the two serial round trips those panels needed", () => {
    // They were awaited one after another AFTER the main Promise.all — pure
    // TTFB on every Control Tower load, for panels nobody was looking at.
    expect(dashboard).not.toMatch(/getMfaStatus\(\)/);
    expect(dashboard).not.toMatch(/from\("api_keys"\)/);
  });

  it("still gates the dashboard itself on MFA", () => {
    // Only the enrolment PANEL moved. The step-up gate is the security control
    // and must stay exactly where it was.
    expect(dashboard).toMatch(/needsMfaStepUp\(db\)\) redirect\("\/login\/verify"\)/);
  });

  it("leaves a way to reach what moved", () => {
    expect(dashboard).toMatch(/href="\/dashboard\/settings"/);
  });
});

describe("the key-import on-ramp is a first-run affordance", () => {
  it("renders only until the tenant holds a provider key", () => {
    // It never self-hid: 320 lines, the only accent-bordered section on the
    // page, permanently above the fleet table.
    expect(dashboard).toMatch(/\{needsFirstKey \? \(/);
    expect(dashboard).toMatch(/const needsFirstKey = \(providerKeys\.count \?\? 1\) === 0/);
  });

  it("counts with head:true and treats a failed count as set up", () => {
    // The card needs to know whether first run is over, not what the keys are —
    // and showing a getting-started card because a COUNT errored is the more
    // annoying way to be wrong.
    expect(dashboard).toMatch(/from\("provider_credentials"\)[\s\S]{0,120}head: true/);
    expect(dashboard).toMatch(/\?\? 1/);
  });

  it("joins the count into the existing Promise.all rather than awaiting after it", () => {
    const all = dashboard.slice(dashboard.indexOf("await Promise.all(["));
    expect(all.slice(0, all.indexOf("]);"))).toMatch(/provider_credentials/);
  });
});

describe("what the Control Tower is left showing", () => {
  it("puts the fleet above the audit tables and below the live surfaces", () => {
    const at = (needle: string) => dashboard.indexOf(needle);
    expect(at("<GlobalKillSwitchBar")).toBeLessThan(at("<DeparturesBoard"));
    expect(at("<DeparturesBoard")).toBeLessThan(at("<FleetOverviewCards"));
    expect(at("<AgentFleetTable")).toBeLessThan(at("<AuditLogTable"));
    expect(at("<AuditLogTable")).toBeLessThan(at("<AdminAuditTable"));
  });

  it("keeps exactly one agent_logs query — the board and the audit log share it", () => {
    // Pinned when the departures board shipped; restructuring the page is
    // exactly when a second query gets added by accident.
    expect(dashboard.match(/from\("agent_logs"\)/g) ?? []).toHaveLength(1);
  });
});
