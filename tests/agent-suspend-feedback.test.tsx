import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { setImmediate } from "node:timers/promises";

// A controlled hook store lets the real click handler render before a deferred
// action settles. Real React DOM interaction is also checked in the browser.
const h = vi.hoisted(() => ({ states: [] as unknown[], cursor: 0, apply: vi.fn(), refresh: vi.fn() }));
vi.mock("react", async () => ({
  ...await vi.importActual<typeof import("react")>("react"),
  useEffect: () => {},
  useState: (initial: unknown) => {
    const index = h.cursor++;
    if (!(index in h.states)) h.states[index] = initial;
    return [h.states[index], (value: unknown) => { h.states[index] = typeof value === "function" ? value(h.states[index]) : value; }];
  },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: h.refresh }) }));
vi.mock("@/app/dashboard/actions-client", () => ({ setAgentSuspended: (...args: unknown[]) => h.apply(...args), observeAgentControl: vi.fn() }));
import { AgentSuspendControl } from "@/components/AgentSuspendControl";

beforeEach(() => { vi.clearAllMocks(); h.states.length = 0; h.cursor = 0; });
const ui = (status = "active") => {
  h.cursor = 0;
  const tree = AgentSuspendControl({ agentId: "a1", agentName: "Scout", status });
  const button = tree.props.children[0];
  return { html: renderToStaticMarkup(tree), click: () => button.props.onClick(), disabled: button.props.disabled };
};
const deferred = () => {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const suspended = { agentId: "a1", requested: "suspended", database: "suspended", suspensionFlag: true, confirmed: true };

describe("instant suspend feedback", () => {
  it("shows and disables Suspending… while the server is still unanswered", async () => {
    const request = deferred();
    h.apply.mockReturnValue(request.promise);
    ui().click();
    const pending = ui();
    expect(pending.html).toContain("Suspending…");
    expect(pending.html).toContain('aria-busy="true"');
    expect(pending.disabled).toBe(true);
    expect(pending.html).toContain('data-agent-control="active"');
    expect(h.apply).toHaveBeenCalledExactlyOnceWith("a1", true);
    request.reject(new Error("lost"));
    await setImmediate();
    expect(ui().html).toContain("Suspend agent");
    expect(ui().html).toContain("may or may not have applied");
    expect(ui().disabled).toBe(false);
  });

  it("keeps the last observed state after a failed reactivation, even before refreshed props arrive", async () => {
    h.apply.mockResolvedValueOnce(suspended);
    ui().click();
    await setImmediate();
    expect(ui().html).toContain("Reactivate agent");
    const request = deferred();
    h.apply.mockReturnValueOnce(request.promise);
    ui().click();
    expect(ui().html).toContain("Reactivating…");
    expect(h.apply).toHaveBeenLastCalledWith("a1", false);
    request.reject(new Error("lost"));
    await setImmediate();
    const failed = ui();
    expect(failed.html).toContain("Reactivate agent");
    expect(failed.html).toContain('data-agent-control="suspended"');
    expect(failed.html).toContain("Could not confirm");
    expect(failed.html).toContain("Nothing has been undone");
    expect(failed.disabled).toBe(false);
  });

  it("lets a newer server status replace an old observation, so a reactivation elsewhere is not shown as suspended", async () => {
    h.apply.mockResolvedValueOnce(suspended);
    ui().click();
    await setImmediate();
    expect(ui().html).toContain('data-agent-control="suspended"');
    // The refresh lands, then another tab or teammate reactivates the agent.
    expect(ui("suspended").html).toContain('data-agent-control="suspended"');
    const later = ui("active");
    expect(later.html).toContain('data-agent-control="active"');
    expect(later.html).toContain("Suspend agent");
  });
});
