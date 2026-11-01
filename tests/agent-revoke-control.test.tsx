import { beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { setImmediate } from "node:timers/promises";

// A controlled hook store lets the real click handler render before a deferred
// action settles, following the existing suspend-feedback tests.
const h = vi.hoisted(() => ({ states: [] as unknown[], cursor: 0, apply: vi.fn(), refresh: vi.fn() }));
vi.mock("react", async () => ({
  ...await vi.importActual<typeof import("react")>("react"),
  useEffect: () => {},
  useRef: () => { const index = h.cursor++; if (!(index in h.states)) h.states[index] = { current: false }; return h.states[index]; },
  useState: (initial: unknown) => {
    const index = h.cursor++;
    if (!(index in h.states)) h.states[index] = initial;
    return [h.states[index], (value: unknown) => { h.states[index] = typeof value === "function" ? value(h.states[index]) : value; }];
  },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: h.refresh }) }));
vi.mock("@/app/dashboard/actions-client", () => ({ revokeAgent: (...args: unknown[]) => h.apply(...args) }));
import { AgentRevokeControl } from "@/components/AgentRevokeControl";

beforeEach(() => { vi.clearAllMocks(); h.states.length = 0; h.cursor = 0; });
function ui(status = "active") {
  h.cursor = 0;
  const tree = AgentRevokeControl({ agentId: "a1", status });
  const buttons: Record<string, { onClick: () => unknown; disabled?: boolean }> = {};
  function visit(node: any) {
    if (!node || typeof node !== "object") return;
    if (node.props?.["data-action"]) buttons[node.props["data-action"]] = node.props;
    const children = node.props?.children;
    (Array.isArray(children) ? children : [children]).forEach(visit);
  }
  visit(tree);
  return { html: renderToStaticMarkup(tree), buttons };
}
it("asks inline first and Keep it cancels without calling the action", () => {
  ui().buttons["revoke-agent"]!.onClick();
  const confirm = ui();
  for (const copy of ["permanent", "passport", "Direct Agent Keys", "delegations", "history", "receipts", "creation limit"]) expect(confirm.html).toContain(copy);
  expect(confirm.html).toContain('data-state="confirm"');
  expect(h.apply).not.toHaveBeenCalled();
  confirm.buttons["cancel-revoke"]!.onClick();
  expect(ui().html).toContain('data-state="idle"');
  expect(h.apply).not.toHaveBeenCalled();
});
it("confirms once, disables pending clicks, then shows revoked and refreshes", async () => {
  let resolve!: (v: unknown) => void;
  h.apply.mockReturnValue(new Promise(yes => { resolve = yes; }));
  ui().buttons["revoke-agent"]!.onClick();
  const confirm = ui().buttons["confirm-revoke"]!;
  confirm.onClick();
  confirm.onClick();
  expect(ui().buttons["confirm-revoke"]!.disabled).toBe(true);
  expect(ui().html).toContain("Revoking…");
  expect(h.apply).toHaveBeenCalledExactlyOnceWith("a1");
  resolve({ id: "a1" });
  await setImmediate();
  expect(ui().html).toContain('data-state="revoked"');
  expect(Object.keys(ui().buttons)).toHaveLength(0);
  expect(h.refresh).toHaveBeenCalledOnce();
});
it("does not claim a lost reply means nothing changed", async () => {
  h.apply.mockRejectedValue(new Error("internal transport detail"));
  ui().buttons["revoke-agent"]!.onClick();
  ui().buttons["confirm-revoke"]!.onClick();
  await setImmediate();
  expect(ui().html).toContain("may or may not have applied");
  expect(ui().html).not.toContain("internal transport detail");
  expect(ui().buttons["confirm-revoke"]!.disabled).toBe(false);
});
it("offers no action for an already revoked agent", () => {
  expect(Object.keys(ui("revoked").buttons)).toHaveLength(0);
});
