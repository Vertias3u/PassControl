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

  it("resolves durable dismissal/completion on the server and stores completion from reality", () => {
    expect(dashboard).toContain('from("onboarding_state")');
    expect(dashboard).toContain('select("dismissed_at, completed_at")');
    expect(dashboard).toContain("onboardingStateHidden(onboardingState)");
    expect(firstCall).toContain("if (hidden) return null;");
    expect(firstCall).toContain('.rpc("complete_onboarding")');
    expect(firstCall).toContain('.rpc("dismiss_onboarding")');
    expect(firstCall).not.toMatch(/localStorage\s*\.\s*(get|set|remove)Item|document\.cookie/);
    expect(dashboard).not.toMatch(/cookies\(\)|FIRST_CALL_DISMISSED_COOKIE/);
  });

  it("removes the retired dismissal cookie from the storage notice", () => {
    expect(read("app/legal/cookies/page.tsx")).not.toContain("pc-first-call-dismissed");
  });

  it("derives the last activation step from audit rows it already fetched", () => {
    // A rail most tenants have dismissed must not cost a round trip. admin_audit
    // is loaded once, for ActivityWorkspace, and step 4 reads the same rows.
    expect(dashboard).toContain("latestControlExerciseAt(adminAudit ?? [])");
    expect(dashboard).toContain("controlExerciseAt={controlExerciseAt}");
    expect(dashboard.match(/from\("admin_audit"\)/g) ?? []).toHaveLength(1);
  });

  it("ends the guide on proving the fleet can be stopped, not on one admitted call", () => {
    expect(firstCall).toContain('"Verify controls"');
    expect(firstCall).toContain('data-activation-state="verify"');
    expect(firstCall).toContain('data-control="kill"');
    // Trust boundary 3 in copy: tenant kill is reversible and independent of
    // per-agent suspension, and it purges nothing. The bar next to it said
    // otherwise until this step was written; neither may say it again.
    expect(firstCall).not.toMatch(/purge/i);
    const bar = read("components/GlobalKillSwitchBar.tsx");
    expect(bar).not.toMatch(/purges cached/i);
    // The bar and its own confirm dialog described the same action two different
    // ways: the dialog claimed it suspends every agent, which is the per-agent
    // control this switch deliberately leaves alone. Neither surface may claim it.
    expect(bar).not.toMatch(/immediately suspends/i);
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
