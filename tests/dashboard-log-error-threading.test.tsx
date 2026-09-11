// The Control Tower itself, rendered with the `agent_logs` read FAILING.
//
// The component-level guarantees live in tests/dashboard-log-unavailable.test.tsx.
// This file proves the other half: that the PAGE actually tells them. That is
// where the defect was — one `logs ?? []` discarding an error the page had
// already correctly read for the operations appendix, so the page said
// "activity log unavailable" and "0 refused calls" in the same viewport.
//
// Every child is replaced with a prop recorder. The page's own query handling —
// the destructuring, the error check, the fan-out — is the real thing.
import { describe, expect, it, vi, beforeEach } from "vitest";

const recorded = new Map<string, Record<string, unknown>>();
const recorder = (name: string) => (props: Record<string, unknown>) => {
  recorded.set(name, props);
  return null;
};

const logQuery = { error: null as unknown, data: [] as unknown[] };

vi.mock("@/lib/supabase/server", () => ({
  userClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1", email: "op@example.test" } } }) },
    from: (table: string) => {
      const result =
        table === "agent_logs"
          ? { data: logQuery.error ? null : logQuery.data, error: logQuery.error, count: null }
          : { data: [], error: null, count: 0 };
      const chain: Record<string, unknown> = {};
      for (const method of ["select", "eq", "is", "gte", "lte", "in", "not", "order", "limit", "range"]) {
        chain[method] = () => chain;
      }
      chain.maybeSingle = async () => result;
      // Awaiting the builder is what the page does for the list reads.
      (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => resolve(result);
      return chain;
    },
  }),
}));

// Next injects this marker package at build time; there is no npm package to
// resolve under vitest, and the module it guards is not on this path.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/mfa", () => ({ needsMfaStepUp: async () => false }));
vi.mock("@/lib/state/killswitch", () => ({
  readKillState: async () => ({ userKill: false, platformKill: false }),
}));
vi.mock("@/lib/state/redis", () => ({ redis: () => ({}) }));
vi.mock("@/lib/key-storage", () => ({ readDeclaredKeyStorageMany: async () => ({}) }));

// The frame and the panels that do not read the log. DashboardShell renders its
// children, which is what makes the recorders below run at all.
vi.mock("@/components/dashboard/DashboardShell", () => ({
  DashboardShell: ({ children }: { children: unknown }) => children,
}));
vi.mock("@/components/dashboard/SectionHeader", () => ({ SectionHeader: () => null }));
vi.mock("@/components/GlobalKillSwitchBar", () => ({ GlobalKillSwitchBar: () => null }));
vi.mock("@/components/DirectAgentConnect", () => ({ DirectAgentConnect: () => null }));
vi.mock("@/components/PassportIssuanceModal", () => ({ PassportIssuanceModal: () => null }));
vi.mock("@/components/dashboard/FleetAttentionQueue", () => ({ FleetAttentionQueue: () => null }));
vi.mock("@/components/FleetOverviewCards", () => ({ FleetOverviewCards: recorder("cards") }));
vi.mock("@/components/DeparturesBoard", () => ({ DeparturesBoard: recorder("departures") }));
vi.mock("@/components/SpendChart", () => ({ SpendChart: recorder("spend") }));
vi.mock("@/components/AgentFleetTable", () => ({ AgentFleetTable: recorder("fleet") }));
vi.mock("@/components/dashboard/ActivityWorkspace", () => ({
  ActivityWorkspace: recorder("activity"),
}));
vi.mock("@/components/dashboard/FirstCallActivation", () => ({
  FirstCallActivation: recorder("activation"),
}));
vi.mock("@/components/dashboard/OperationsPanel", () => ({ OperationsPanel: recorder("operations") }));

const CONSUMERS = ["cards", "departures", "spend", "fleet", "activity", "activation"] as const;

async function renderPage() {
  recorded.clear();
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { default: ControlTowerPage } = await import("@/app/dashboard/page");
  renderToStaticMarkup(await ControlTowerPage());
}

beforeEach(() => {
  logQuery.error = null;
  logQuery.data = [];
});

describe("a failed agent_logs read reaches every consumer of it", () => {
  it("marks all six log-derived surfaces unavailable", async () => {
    // The shape PostgREST returns when a selected column does not exist — the
    // deterministic version of this fault, produced by deploying code before
    // its migration. It rejects the whole select rather than returning partial
    // rows, so one unknown column blanks the entire window.
    logQuery.error = { code: "42703", message: 'column "x" does not exist' };
    await renderPage();

    for (const consumer of CONSUMERS) {
      expect(recorded.get(consumer), consumer).toBeDefined();
      expect(recorded.get(consumer)?.logsAvailable, consumer).toBe(false);
    }
  });

  it("still reports the read as unavailable in the operations appendix", async () => {
    // The one signal that was always right. It has to stay right — the fix is
    // to make the rest of the page agree with it, not to move the disagreement.
    logQuery.error = { code: "42703", message: "boom" };
    await renderPage();

    const signals = recorded.get("operations")?.signals as Record<string, string>;
    expect(signals.activityLog).toBe("unavailable");
  });

  it("marks the support bundle's failure sample unavailable rather than empty", async () => {
    logQuery.error = { code: "42703", message: "boom" };
    await renderPage();

    const bundle = recorded.get("operations")?.supportBundle as Record<string, unknown>;
    expect(bundle.recent_failures).toBeUndefined();
    expect(bundle.recent_failures_unavailable).toBe(true);
  });

  it("says available — for all six — when the read succeeds and returns nothing", async () => {
    await renderPage();

    for (const consumer of CONSUMERS) {
      expect(recorded.get(consumer)?.logsAvailable, consumer).toBe(true);
    }
    const bundle = recorded.get("operations")?.supportBundle as Record<string, unknown>;
    expect(bundle.recent_failures).toEqual([]);
  });
});
