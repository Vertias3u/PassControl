// The outcome line every suspend/reactivate surface shares (v1 playbook
// Contract C). Rendered, because the claims live in the words: a partial or
// lost result must never read as success, or as "nothing changed".
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/app/dashboard/actions-client", () => ({ setAgentSuspended: vi.fn(), observeAgentControl: vi.fn() }));

const { AgentControlResult, AgentSuspendControl, intentFor } = await import("@/components/AgentSuspendControl");

const obs = (overrides: Record<string, unknown>) => ({
  agentId: "a1",
  requested: "suspended" as const,
  database: "suspended" as const,
  suspensionFlag: true,
  confirmed: true,
  ...overrides,
});
const render = (result: Parameters<typeof AgentControlResult>[0]["result"]) =>
  renderToStaticMarkup(<AgentControlResult result={result} agentName="Scout" onRetry={() => {}} onRefresh={() => {}} />);

describe("AgentControlResult", () => {
  it("states a confirmed suspension, and that dispatched calls are not recalled", () => {
    const html = render({ phase: "observed", intent: "suspended", observation: obs({}), at: "2026-09-26T10:00:00Z" });
    expect(html).toContain('data-control-result="confirmed"');
    expect(html).toMatch(/next request is refused/);
    expect(html).toMatch(/not recalled/);
  });

  it("does not declare recovery when the database resumed but the gateway flag is still set", () => {
    const html = render({
      phase: "observed",
      intent: "active",
      observation: obs({ requested: "active", database: "active", suspensionFlag: true, confirmed: false }),
      at: "2026-09-26T10:00:00Z",
    });
    expect(html).toContain('data-control-result="unconfirmed"');
    expect(html).toMatch(/Could not confirm the reactivate/);
    expect(html).toMatch(/still refused/);
    expect(html).toContain("Retry reactivate");
    expect(html).not.toMatch(/active again/);
  });

  it("names an unreadable layer instead of guessing it", () => {
    const html = render({ phase: "observed", intent: "suspended", observation: obs({ suspensionFlag: null, confirmed: false }), at: "x" });
    expect(html).toMatch(/could not be read/);
  });

  it("says a lost response may have applied, and offers the same intent again", () => {
    const html = render({ phase: "lost", intent: "suspended", at: "x" });
    expect(html).toContain('data-control-result="lost"');
    expect(html).toMatch(/may or may not have applied/);
    expect(html).toMatch(/Nothing has been undone/);
    expect(html).toContain("Retry suspend");
    expect(html).not.toMatch(/did not change/i);
  });
});

describe("desired-state controls", () => {
  it("name and send the state they will produce", () => {
    expect(intentFor("active")).toBe("suspended");
    expect(intentFor("suspended")).toBe("active");
    const html = renderToStaticMarkup(<AgentSuspendControl agentId="a1" agentName="Scout" status="active" />);
    expect(html).toContain('data-control="suspend"');
    expect(html).toContain("Suspend agent");
  });

  it("never re-derive a retry by inverting state, in any surface", () => {
    const fleet = readFileSync("components/AgentFleetTable.tsx", "utf8");
    expect(fleet).not.toMatch(/setAgentSuspended\([^)]*!suspended/);
    expect(fleet).toMatch(/runControl\(a\.id, r\.intent\)/);
    const control = readFileSync("components/AgentSuspendControl.tsx", "utf8");
    expect(control).toMatch(/void run\(result\.intent\)/);
  });
});
