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

  it("resolves the guide's dismissal on the server, not in an effect", () => {
    // This replaced an assertion that pinned the opposite and was wrong for it.
    //
    // Dismissal used to be read from localStorage in an effect, with the guard
    // treating "not yet known" as "hide". That deadlocks: the server renders
    // null, so the client component never mounts, so the effect never runs.
    // Every dismissible stage was invisible on a cold load, in production, and
    // the old source-grep could not see it because the source looked correct.
    // The behavioural check lives in tests/first-call-steps-rendering.test.tsx;
    // this one keeps the two halves of the cookie from drifting apart.
    expect(firstCall).toContain("if (dismissible && dismissed) return null;");
    // The prose above the guard explains why localStorage was abandoned, so
    // match on use, not on the word.
    expect(firstCall).not.toMatch(/localStorage\s*\.\s*(get|set|remove)Item/);
    expect(dashboard).toContain("FIRST_CALL_DISMISSED_COOKIE");
    expect(dashboard).toContain("?.value === user.id");

    // The cookie name is declared in the plain shared module, NOT in the client
    // component, and importing it from the client component is the bug this
    // pins. A `"use client"` export reaches a server component as a client
    // reference rather than the string, so `cookies().get(NAME)` returned null
    // while `getAll()` listed the cookie and the guide would not stay dismissed.
    // Type-checks fine; invisible to every source-grep that does not look here.
    expect(read("lib/first-call-activation.ts")).toContain(
      'export const FIRST_CALL_DISMISSED_COOKIE = "pc-first-call-dismissed"'
    );
    expect(firstCall).not.toMatch(/export const FIRST_CALL_DISMISSED_COOKIE/);
    const dashboardImports = dashboard.slice(0, dashboard.indexOf("export const dynamic"));
    expect(dashboardImports).toMatch(
      /import \{[^}]*FIRST_CALL_DISMISSED_COOKIE[^}]*\} from "@\/lib\/first-call-activation"/
    );

    const dismissible = firstCall.slice(firstCall.indexOf("const dismissible ="));
    const line = dismissible.slice(0, dismissible.indexOf(";"));
    expect(line).toContain('state.stage === "complete"');
    expect(line).toContain('state.stage === "verify"');
  });

  it("declares the dismissal cookie in the cookie notice", () => {
    // An identity product that sets an undeclared client-visible cookie is a
    // compliance defect, not a styling one. The notice enumerates storage by
    // name, so a new cookie has to arrive there in the same change.
    expect(read("app/legal/cookies/page.tsx")).toContain("pc-first-call-dismissed");
  });

  it("derives the last activation step from audit rows it already fetched", () => {
    // A rail most tenants have dismissed must not cost a round trip. admin_audit
    // is loaded once, for ActivityWorkspace, and step 4 reads the same rows.
    expect(dashboard).toContain("hasExercisedControls(adminAudit ?? [])");
    expect(dashboard).toContain("controlsExercised={controlsExercised}");
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
