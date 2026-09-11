// A failed activity-log read must stay unavailable all the way to the screen.
//
// The Control Tower loads `agent_logs` ONCE and fans that one array out to the
// fleet cards, the departures board, the spend chart, the forensic table, the
// activation rail and the support bundle. The page reads the error correctly —
// the operations appendix says "unavailable" — and then does `logs ?? []`, so
// every other consumer receives an empty array it cannot tell apart from a
// genuinely quiet workspace. During the exact database fault that makes audit
// evidence least trustworthy, the main surfaces said no activity occurred:
// 0 refused calls, "No governed calls yet", "No agent calls in this loaded
// window", "No governed calls recorded yet", and `recent_failures: []` inside
// the artifact an operator hands to support.
//
// These assertions are on RENDERED OUTPUT, deliberately. The defect is entirely
// a claim the DOM makes, and this repository has twice shipped a bug that a
// source-pattern assertion called green.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FleetOverviewCards } from "@/components/FleetOverviewCards";
import { DeparturesBoard } from "@/components/DeparturesBoard";
import { SpendChart } from "@/components/SpendChart";
import { AuditLogTable } from "@/components/AuditLogTable";
import { AgentFleetTable } from "@/components/AgentFleetTable";
import { FirstCallActivation } from "@/components/dashboard/FirstCallActivation";
import { buildCloudSupportBundle } from "@/lib/cloud-operations";
import { summariseFleetAttention } from "@/lib/dashboard-attention";
import type { DepartureRow } from "@/lib/departures";

/** Every empty-state sentence that is a factual claim about the workspace. */
const CENSUS_CLAIMS = [
  "No governed calls yet",
  "No agent calls in this loaded window",
  "No governed calls recorded yet",
  "No agent alerts",
];

const callContext = { shadowRevisions: {} };

function row(over: Partial<DepartureRow> = {}): DepartureRow {
  return {
    id: "log-1",
    agent_id: "agent-1",
    user_id: "user-1",
    created_at: "2026-09-10T10:00:00.000Z",
    passport_id: "cGFzc3BvcnQ",
    jti: "visa-1",
    auth_method: "passport",
    agent_access_key_id: null,
    credential_use_id: null,
    provider: "openai",
    model: "gpt-4o-mini",
    input_tokens: 10,
    output_tokens: 20,
    cost_microcents: 100,
    enforced_tokens: 30,
    enforced_microcents: 100,
    status: "ok",
    latency_ms: 120,
    receipt: null,
    policy_shadow_would: null,
    ...over,
  } as DepartureRow;
}

const agentRow = {
  id: "agent-1",
  name: "Reconciler",
  status: "active",
  last_seen_at: null,
  passport_pubkey: "cHVia2V5",
  budget_tokens: null,
  budget_cents: null,
  spent_tokens: 0,
  spent_microcents: 0,
  scope: [],
  created_at: "2026-09-01T00:00:00.000Z",
} as never;

describe("the fleet cards during an unreadable log read", () => {
  it("does not report zero refused calls it never counted", () => {
    const html = renderToStaticMarkup(
      <FleetOverviewCards
        activeAgents={3}
        totalAgents={3}
        spentMicrocents={12_300_000}
        blockedCalls={0}
        recentCalls={0}
        housekeepingCalls={0}
        attention={summariseFleetAttention([])}
        logsAvailable={false}
      />
    );

    expect(html).toContain('data-state="unavailable"');
    expect(html).not.toMatch(/Latest 0 agent calls/);
    for (const claim of CENSUS_CLAIMS) expect(html, claim).not.toContain(claim);
  });

  it("still counts a genuinely empty workspace as zero", () => {
    const html = renderToStaticMarkup(
      <FleetOverviewCards
        activeAgents={3}
        totalAgents={3}
        spentMicrocents={12_300_000}
        blockedCalls={0}
        recentCalls={0}
        housekeepingCalls={0}
        attention={summariseFleetAttention([])}
        logsAvailable
      />
    );

    expect(html).toContain("Latest 0 agent calls");
    expect(html).toContain("No agent alerts");
    expect(html).not.toContain('data-state="unavailable"');
  });

  // Agent-derived spend is a durable counter and survives a log outage. Blanking
  // it would be the opposite error — hiding a figure that is still true.
  it("keeps the figures that do not come from the log", () => {
    const html = renderToStaticMarkup(
      <FleetOverviewCards
        activeAgents={3}
        totalAgents={4}
        spentMicrocents={12_300_000}
        blockedCalls={0}
        recentCalls={0}
        housekeepingCalls={0}
        attention={summariseFleetAttention([])}
        logsAvailable={false}
      />
    );

    expect(html).toContain("$0.12");
    expect(html).toContain("of 4");
  });
});

describe("the departures board during an unreadable log read", () => {
  it("says the window is unavailable instead of saying there are no calls", () => {
    const html = renderToStaticMarkup(
      <DeparturesBoard userId="user-1" initialRows={[]} callContext={callContext} logsAvailable={false} />
    );

    expect(html).toContain('data-state="unavailable"');
    expect(html).not.toContain("No governed calls yet");
  });

  it("keeps the real empty state for a workspace that genuinely has no calls", () => {
    const html = renderToStaticMarkup(
      <DeparturesBoard userId="user-1" initialRows={[]} callContext={callContext} logsAvailable />
    );

    expect(html).toContain("No governed calls yet");
    expect(html).not.toContain('data-state="unavailable"');
  });

  // The half a static empty-state fix would miss. These boards subscribe to
  // `agent_logs` inserts, so the first call to arrive after a failed load turns
  // an empty board into a one-row board — which reads as a complete window
  // containing one call. That is worse than the zero: it looks like data.
  it("still says so once realtime has delivered rows into the gap", () => {
    const html = renderToStaticMarkup(
      <DeparturesBoard
        userId="user-1"
        initialRows={[row()]}
        callContext={callContext}
        logsAvailable={false}
      />
    );

    expect(html).toContain('data-state="unavailable"');
    expect(html).toMatch(/since this page loaded/i);
  });
});

describe("the spend chart during an unreadable log read", () => {
  it("does not claim there were no agent calls", () => {
    const html = renderToStaticMarkup(
      <SpendChart userId="user-1" initialLogs={[]} logsAvailable={false} />
    );

    expect(html).toContain('data-state="unavailable"');
    expect(html).not.toContain("No agent calls in this loaded window");
  });

  it("keeps its empty copy when the read succeeded and returned nothing", () => {
    const html = renderToStaticMarkup(<SpendChart userId="user-1" initialLogs={[]} logsAvailable />);

    expect(html).toContain("No agent calls in this loaded window");
    expect(html).not.toContain('data-state="unavailable"');
  });
});

describe("the forensic table during an unreadable log read", () => {
  it("does not state that no governed calls were recorded", () => {
    const html = renderToStaticMarkup(
      <AuditLogTable logs={[]} callContext={callContext} logsAvailable={false} />
    );

    expect(html).toContain('data-state="unavailable"');
    expect(html).not.toContain("No governed calls recorded yet");
  });

  it("keeps its empty copy for a genuinely empty history", () => {
    const html = renderToStaticMarkup(<AuditLogTable logs={[]} callContext={callContext} logsAvailable />);

    expect(html).toContain("No governed calls recorded yet");
    expect(html).toContain('data-state="empty"');
  });
});

describe("the fleet table's last-seen column", () => {
  // "never" is a real answer and the file says so. It is only a real answer when
  // the scan that would have contradicted it actually ran: with the log read
  // failed AND the stored column null, there is no evidence in either place.
  it("does not say never when the scan that would prove otherwise failed", () => {
    const html = renderToStaticMarkup(
      <AgentFleetTable
        agents={[agentRow]}
        visaTtlSeconds={300}
        keyCustody={{}}
        keyCustodyExpectation={null}
        logsAvailable={false}
      />
    );

    expect(html).not.toContain("never");
    expect(html).toContain("unknown");
  });

  it("still says never for an agent that has genuinely never called", () => {
    const html = renderToStaticMarkup(
      <AgentFleetTable
        agents={[agentRow]}
        visaTtlSeconds={300}
        keyCustody={{}}
        keyCustodyExpectation={null}
        logsAvailable
      />
    );

    expect(html).toContain("never");
  });
});

describe("the activation rail during an unreadable log read", () => {
  // `deriveFirstCallActivation` reads absent rows as proof no call was made —
  // right for an empty log, meaningless for a failed one. The rail would tell an
  // established operator to make their first call in the middle of the outage.
  it("renders nothing rather than guessing a stage", () => {
    const html = renderToStaticMarkup(
      <FirstCallActivation
        userId="user-1"
        providerConfigured
        controlExerciseAt={null}
        initiallyHidden={false}
        agents={[{ id: "agent-1", name: "Reconciler", status: "active", identityKind: "passport" }]}
        initialLogs={[]}
        integrations={["generic"]}
        logsAvailable={false}
      />
    );

    expect(html).toBe("");
  });

  it("still renders the guide when the read succeeded and found nothing", () => {
    const html = renderToStaticMarkup(
      <FirstCallActivation
        userId="user-1"
        providerConfigured
        controlExerciseAt={null}
        initiallyHidden={false}
        agents={[{ id: "agent-1", name: "Reconciler", status: "active", identityKind: "passport" }]}
        initialLogs={[]}
        integrations={["generic"]}
        logsAvailable
      />
    );

    expect(html).not.toBe("");
  });

  // The guard sits below the hooks, next to `hidden`. Above them it would change
  // the hook count between renders the first time this prop flips — which is a
  // crash, not a blank rail, and only on the second render.
  it("declares every hook before it decides not to render", () => {
    const source = readFileSync(resolve(process.cwd(), "components/dashboard/FirstCallActivation.tsx"), "utf8");
    const guard = source.indexOf("if (!logsAvailable || hidden) return null;");
    expect(guard).toBeGreaterThan(-1);
    expect(source.lastIndexOf("useEffect(")).toBeLessThan(guard);
    expect(source.lastIndexOf("useState")).toBeLessThan(guard);
  });
});

// Markup is not the deliverable — a visible difference is. A brand-new class
// with no rule renders as unstyled text, which looks like ordinary quiet copy
// and is exactly the state an operator must not skim past. This repository has
// shipped correct-markup-no-colour twice (the Tailwind untracked-file trap and
// the stale .next trap), so the stylesheet is asserted rather than assumed.
describe("the unavailable states are actually visible", () => {
  const css = readFileSync(resolve(process.cwd(), "app/globals.css"), "utf8");

  it.each([
    ".pc-live-calls__unavailable",
    ".pc-spend-view__unavailable",
    '.pc-metric-card[data-state="unavailable"]',
    '.pc-table-empty[data-state="unavailable"]',
    '.pc-live-calls__empty[data-state="unavailable"]',
    '.pc-spend-chart__empty[data-state="unavailable"]',
    '.pc-last-seen[data-state="unavailable"]',
  ])("styles %s", (selector) => {
    expect(css).toContain(selector);
  });
});

describe("the support bundle during an unreadable log read", () => {
  const bundle = (logsAvailable: boolean) =>
    buildCloudSupportBundle({
      generatedAt: "2026-09-10T12:00:00.000Z",
      quota: null,
      signals: {
        providerCredentials: "configured",
        receiptSigning: "configured",
        observability: "configured",
        agentRegistry: "available",
        activityLog: logsAvailable ? "available" : "unavailable",
      },
      controls: { workspaceKillArmed: false, platformKillArmed: false },
      agents: [],
      logs: [],
    });

  // An empty array beside `activity_log: "unavailable"` is the bundle giving two
  // answers at once, and a reader takes the concrete one.
  it("does not ship an empty failure list as if it were a census", () => {
    const out = bundle(false) as Record<string, unknown>;
    expect(out.recent_failures).toBeUndefined();
    expect(out.recent_failures_unavailable).toBe(true);
  });

  it("still ships an empty list when the read succeeded", () => {
    const out = bundle(true) as Record<string, unknown>;
    expect(out.recent_failures).toEqual([]);
    expect(out.recent_failures_unavailable).toBeUndefined();
  });
});
