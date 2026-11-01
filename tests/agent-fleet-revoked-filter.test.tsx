import { beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { setImmediate } from "node:timers/promises";

// A controlled hook store lets the real click handler render before a deferred
// action settles, following the existing suspend-feedback tests.
const h = vi.hoisted(() => ({ states: [] as unknown[], cursor: 0, apply: vi.fn(), refresh: vi.fn() }));
vi.mock("react", async () => ({
  ...await vi.importActual<typeof import("react")>("react"),
  useEffect: () => {},
  useMemo: (fn: () => unknown) => fn(),
  
  useState: (initial: unknown) => {
    const index = h.cursor++;
    if (!(index in h.states)) h.states[index] = initial;
    return [h.states[index], (value: unknown) => { h.states[index] = typeof value === "function" ? value(h.states[index]) : value; }];
  },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: h.refresh }) }));
vi.mock("@/app/dashboard/actions-client", () => ({ revokeAgent: (...args: unknown[]) => h.apply(...args) }));
vi.mock("@/components/dashboard/DashboardTime", () => ({ useDashboardTime: () => ({ format: () => "time" }) }));
import { AgentFleetTable } from "@/components/AgentFleetTable";
beforeEach(() => { vi.clearAllMocks(); h.states.length = 0; h.cursor = 0; });
function ui() {
  h.cursor = 0;
  return AgentFleetTable({ agentsAvailable: true, logsAvailable: true, visaTtlSeconds: 300,
    agents: ["active", "suspended", "revoked"].map(status => ({ id: status, name: `agent-${status}`, status, passport_pubkey: null, budget_tokens: null, budget_cents: null, spent_tokens: 0, spent_microcents: 0, last_seen_at: null, allowed_scopes: [] })) });
}
function statusSelect(node: any): any {
  if (!node || typeof node !== "object") return null;
  if (node.type === "select" && node.props.children.some((c: any) => c?.props?.value === "revoked")) return node;
  const children = node.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) { const found = statusSelect(child); if (found) return found; }
  return null;
}
it("hides revoked agents by default and lists them in the Revoked filter", () => {
  const tree = ui();
  const html = renderToStaticMarkup(tree);
  expect(html).toContain("agent-active");
  expect(html).toContain("agent-suspended");
  expect(html).not.toContain("agent-revoked");
  statusSelect(tree).props.onChange({ target: { value: "revoked" } });
  const revoked = renderToStaticMarkup(ui());
  expect(revoked).toContain("agent-revoked");
  expect(revoked).not.toContain("agent-active");
  expect(revoked).not.toContain("agent-suspended");
});
