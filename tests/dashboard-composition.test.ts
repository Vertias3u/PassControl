// The Control Tower is a surface you WATCH. Setup panels that live on it push
// the fleet table below the fold and cost serial round trips on every load, so
// where each section lives is a decision worth pinning.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const dashboard = read("app/dashboard/page.tsx");
const settings = read("app/dashboard/settings/page.tsx");
const shell = read("components/dashboard/DashboardShell.tsx");
const middleware = read("middleware.ts");
const firstCall = read("components/dashboard/FirstCallActivation.tsx");

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
    expect(dashboard).toMatch(/<DashboardShell/);
    expect(shell).toMatch(/href: "\/dashboard\/settings"/);
  });
});

describe("the first-call guide reuses the first-run provider read", () => {
  it("threads provider readiness into the activation state without a new query", () => {
    expect(dashboard).toContain("<FirstCallActivation");
    expect(dashboard).toMatch(/providerConfigured=\{!needsFirstKey\}/);
    expect(dashboard).toMatch(/const needsFirstKey = \(providerKeys\.count \?\? 1\) === 0/);
  });

  it("reads only bounded provider labels and treats a failed count as set up", () => {
    // The first agent form needs the provider family but never a Vault id or
    // secret. Showing setup because a COUNT errored is still the more annoying
    // way to be wrong.
    expect(dashboard).toMatch(/from\("provider_credentials"\)[\s\S]{0,160}select\("provider"[\s\S]{0,80}limit\(6\)/);
    expect(dashboard).not.toMatch(/from\("provider_credentials"\)[\s\S]{0,120}vault_secret_id/);
    expect(dashboard).toMatch(/\?\? 1/);
  });

  it("joins the count into the existing Promise.all rather than awaiting after it", () => {
    const all = dashboard.slice(dashboard.indexOf("await Promise.all(["));
    expect(all.slice(0, all.indexOf("]);"))).toMatch(/provider_credentials/);
  });

  it("does not flash a dismissed completion card before localStorage resolves", () => {
    expect(firstCall).toContain('state.stage === "complete" && dismissed !== false');
  });
});

describe("what the Control Tower is left showing", () => {
  it("puts state before live activity, then fleet before forensic history", () => {
    const at = (needle: string) => dashboard.indexOf(needle);
    expect(at("<GlobalKillSwitchBar")).toBeLessThan(at("<FirstCallActivation"));
    expect(at("<FirstCallActivation")).toBeLessThan(at("<FleetOverviewCards"));
    expect(at("<FleetOverviewCards")).toBeLessThan(at("<DeparturesBoard"));
    expect(at("<DeparturesBoard")).toBeLessThan(at("<SpendChart"));
    expect(at("<SpendChart")).toBeLessThan(at("<AgentFleetTable"));
    expect(at("<AgentFleetTable")).toBeLessThan(at("<ActivityWorkspace"));
    expect(at("<ActivityWorkspace")).toBeLessThan(at("<CloudBetaOperations"));
    expect(read("components/FleetOverviewCards.tsx")).toContain("pc-overview-status-rail");
  });

  it("keeps exactly one agent_logs query — the board and the audit log share it", () => {
    // Pinned when the departures board shipped; restructuring the page is
    // exactly when a second query gets added by accident.
    expect(dashboard.match(/from\("agent_logs"\)/g) ?? []).toHaveLength(1);
  });
});
