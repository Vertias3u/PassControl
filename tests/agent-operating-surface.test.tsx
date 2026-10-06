// v1 playbook Session 05 — the operating surface says what is true, including
// "could not read", and never turns an unavailable read into a green claim.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/app/dashboard/actions-client", () => ({
  setAgentSuspended: vi.fn(),
  observeAgentControl: vi.fn(),
  setMasterKill: vi.fn(),
  observeMasterKill: vi.fn(),
  updateAgentBudgets: vi.fn(),
  updateAgentScopes: vi.fn(),
}));

const { GlobalKillSwitchBar, killSwitchPhase, killSwitchPresentation } = await import("@/components/GlobalKillSwitchBar");
const { AgentOperatingHeader } = await import("@/components/AgentOperatingHeader");
const { AgentFleetTable } = await import("@/components/AgentFleetTable");

describe("fleet kill switch observation", () => {
  it("never shows an unreadable switch as operational, and says what the gateway does about it", () => {
    const closed = renderToStaticMarkup(<GlobalKillSwitchBar initial={{ tenant: null, platform: null }} failClosed />);
    expect(closed).toContain('data-state="unknown"');
    expect(closed).toMatch(/refuses every call until it can/);
    expect(closed).not.toMatch(/Fleet operational/);
    expect(closed).toContain('data-control="refresh-kill"');
    const open = renderToStaticMarkup(<GlobalKillSwitchBar initial={{ tenant: null, platform: null }} failClosed={false} />);
    expect(open).toMatch(/lets calls through while it cannot/);
  });

  it("shows PassControl's platform stop separately, as something this switch cannot lift", () => {
    const html = renderToStaticMarkup(<GlobalKillSwitchBar initial={{ tenant: false, platform: true }} failClosed={false} />);
    expect(html).toContain('data-kill-layer="platform"');
    expect(html).toMatch(/cannot override it/);
  });

  it("shows a readable, clear switch as disarmed", () => {
    const html = renderToStaticMarkup(<GlobalKillSwitchBar initial={{ tenant: false, platform: false }} failClosed />);
    expect(html).toContain('data-state="disarmed"');
    expect(html).not.toContain('data-kill-layer="platform"');
  });

  // Session 07, step 9: an arm whose response was lost DID apply (calls were
  // refused), while the bar kept its pre-action "DISARMED · Fleet operational"
  // beside a "may or may not have applied" alert. The last observation is
  // stale once a change may have landed; the bar must stop asserting it.
  it("does not keep asserting the pre-action state once a change's response is lost", () => {
    const lostArm = killSwitchPhase({ busy: null, tenant: false, lost: true });
    expect(lostArm).toBe("unconfirmed");
    const lostDisarm = killSwitchPhase({ busy: null, tenant: true, lost: true });
    expect(lostDisarm).toBe("unconfirmed");
    const shown = killSwitchPresentation("unconfirmed", true);
    expect(shown.label).not.toMatch(/DISARMED|ARMED/);
    expect(shown.desc).not.toMatch(/operational|refused tenant-wide/);
    expect(shown.desc).toMatch(/may or may not have applied/);
  });

  it("shows a returned readback as the truth, even when it is not what was asked for", () => {
    expect(killSwitchPhase({ busy: null, tenant: false, lost: false })).toBe("disarmed");
    expect(killSwitchPhase({ busy: null, tenant: true, lost: false })).toBe("armed");
    expect(killSwitchPhase({ busy: null, tenant: null, lost: false })).toBe("unknown");
  });

  // Final-pass finding (2026-09-26): on a PRODUCTION build, a transition started
  // on /dashboard never commits — router.refresh() and a server action's
  // revalidated tree both stay pending (reproduced on main 04a8086 and this
  // branch; `next dev` is unaffected, which is why Sessions 05/07 passed). With
  // the kill switch's state updates inside useTransition, the bar sat on
  // ARMING…/DISARMING… although the switch had applied. The readback must commit
  // on its own, as AgentSuspendControl's does, not ride the router commit.
  it("commits its readback outside a transition", () => {
    const source = readFileSync("components/GlobalKillSwitchBar.tsx", "utf8");
    expect(source).not.toMatch(/\buseTransition\b/);
    expect(source).not.toMatch(/\bstartTransition\b/);
  });

  it("names what is in progress from the intent, not from the possibly stale observation", () => {
    // A retried arm after a lost response: the old observation says disarmed
    // or armed; the bar says what is being done, not the reverse of it.
    expect(killSwitchPhase({ busy: { kind: "apply", next: true }, tenant: true, lost: true })).toBe("arming");
    expect(killSwitchPhase({ busy: { kind: "apply", next: false }, tenant: false, lost: true })).toBe("disarming");
    // Refreshing an unreadable switch is a read, not an arm.
    expect(killSwitchPhase({ busy: { kind: "refresh" }, tenant: null, lost: false })).toBe("checking");
  });
});

describe("agent operating header", () => {
  const base = {
    agentId: "a1",
    agentName: "Scout",
    status: "active",
    scopes: [{ provider: "openai", models: ["gpt-5-mini"] }],
    budgets: { tokens: { spentTokens: 100, capTokens: null }, cost: { spentCents: 12, capCents: 500 } },
    visaTtlSeconds: 300,
  };

  it("puts state, access, caps and the stop control on the agent page", () => {
    const html = renderToStaticMarkup(<AgentOperatingHeader {...base} hasPassport={false} activeDirectKeys={1} />);
    expect(html).toContain('id="agent-operate"');
    expect(html).toContain('data-control="suspend"');
    expect(html).toContain("openai: gpt-5-mini");
    expect(html).toMatch(/No token cap/);
    expect(html).toMatch(/\$0\.12 of \$5\.00 cost used \(cumulative cap\)/);
    expect(html).toContain('href="#agent-setup"');
    expect(html).toContain('href="#agent-access"');
  });

  it("states scope timing for the credential actually in use", () => {
    const direct = renderToStaticMarkup(<AgentOperatingHeader {...base} hasPassport={false} activeDirectKeys={1} />);
    expect(direct).toMatch(/Direct Agent Key(&#x27;|')s next request/);
    expect(direct).not.toMatch(/work-visa/);
    const passport = renderToStaticMarkup(<AgentOperatingHeader {...base} hasPassport activeDirectKeys={0} />);
    expect(passport).toMatch(/work-visa already issued keeps the access it was issued with for up to 5 minutes/);
    expect(passport).not.toMatch(/Direct Agent Key(&#x27;|')s next request/);
    const both = renderToStaticMarkup(<AgentOperatingHeader {...base} hasPassport activeDirectKeys={2} />);
    expect(both).toMatch(/Direct Agent Key(&#x27;|')s next request/);
    expect(both).toMatch(/work-visa/);
  });

  it("tells the operator to rotate a passport whose private key the gateway saw", () => {
    const flagged = renderToStaticMarkup(
      <AgentOperatingHeader {...base} hasPassport activeDirectKeys={0} passportSecretExposedAt="2026-09-26T10:00:00.000Z" />
    );
    expect(flagged).toContain('data-passport-secret-exposed="2026-09-26T10:00:00.000Z"');
    expect(flagged).toMatch(/rotate it/);
    const clean = renderToStaticMarkup(<AgentOperatingHeader {...base} hasPassport activeDirectKeys={0} />);
    expect(clean).not.toContain("data-passport-secret-exposed");
  });

  it("tells the three stop actions apart and promises no recall", () => {
    const html = renderToStaticMarkup(<AgentOperatingHeader {...base} hasPassport={false} activeDirectKeys={1} />);
    expect(html).toMatch(/Revoking one installation key stops only that key/);
    expect(html).toMatch(/fleet kill switch stops every\s+agent/);
    expect(html).toMatch(/None of them recalls a call already sent/);
  });
});

describe("fleet table read failure", () => {
  it("says the list could not be read instead of 'No agents yet'", () => {
    const html = renderToStaticMarkup(
      <AgentFleetTable agents={[]} agentsAvailable={false} visaTtlSeconds={300} logsAvailable />
    );
    expect(html).toContain('data-state="unavailable"');
    expect(html).not.toMatch(/No agents yet/);
  });
});

describe("agent page wording", () => {
  it("does not title a Direct Agent Key agent as a passport, and names break glass plainly", () => {
    const page = readFileSync("app/dashboard/agents/[id]/page.tsx", "utf8");
    expect(page).not.toContain('title: "Agent Passport"');
    expect(page).toContain("Temporary access (break glass)");
    expect(page).not.toContain(">Emergency access<");
    const passport = readFileSync("components/AgentPassport.tsx", "utf8");
    expect(passport).toMatch(/passport\.agent\.passportId \? "Visas" : "Allowed models"/);
    const keys = readFileSync("components/DirectAgentKeyPanel.tsx", "utf8");
    expect(keys).toMatch(/Only this installation key/);
    const providers = readFileSync("components/ProviderKeysManager.tsx", "utf8");
    expect(providers).not.toMatch(/In effect immediately/);
    expect(providers).toMatch(/Every agent in this workspace that calls/);
  });
});

// Any-API slice B: an agent with no model access but service rules is not
// "allowed nothing", and saying so would send an operator the wrong way.
describe("the access summary with services", () => {
  const props = {
    agentId: "a1",
    agentName: "triage",
    status: "active",
    hasPassport: false,
    activeDirectKeys: 1,
    budgets: { tokens: { spentTokens: 0, capTokens: null }, cost: { spentCents: 0, capCents: null } },
    visaTtlSeconds: 900,
  };
  const access = (html: string) => html.match(/data-operate="access">([^<]*)</)?.[1];

  it("names service access when there is no model access", () => {
    const html = renderToStaticMarkup(
      <AgentOperatingHeader {...props} scopes={[]} serviceAccess={[{ label: "GitHub", rules: 3 }, { label: "Telegram", rules: 0 }]} />
    );
    expect(access(html)).toBe("No model access · GitHub: 3 rules");
  });

  it("still says nothing is allowed when there is neither", () => {
    const html = renderToStaticMarkup(<AgentOperatingHeader {...props} scopes={[]} serviceAccess={[{ label: "GitHub", rules: 0 }]} />);
    expect(access(html)).toBe("Nothing — no provider, model or service is allowed.");
  });

  it("adds services after models", () => {
    const html = renderToStaticMarkup(
      <AgentOperatingHeader {...props} scopes={[{ provider: "openai", models: ["gpt-4.1-mini"] }]} serviceAccess={[{ label: "GitHub", rules: 1 }]} />
    );
    expect(access(html)).toBe("openai: gpt-4.1-mini · GitHub: 1 rule");
  });
});
