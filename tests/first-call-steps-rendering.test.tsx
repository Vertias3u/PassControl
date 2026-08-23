// The stepper is the only part of the activation guide an operator reads before
// they understand the product, and `stepState` computes it from an index lookup
// into a list of stage names. That is quiet code with a loud failure mode: drop
// a name from the list and indexOf returns -1, so every earlier step falls
// through both branches and renders grey `upcoming`.
//
// The concrete regression this pins: a refused first call would visibly
// un-complete the provider key and the agent the operator had just finished
// creating, telling them their setup had come undone when only the call failed.
// Nothing in the derived state is wrong when that happens — the stage is still
// `diagnose` — so a logic-level test cannot see it. Only the markup can.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/lib/supabase/client", () => ({
  browserClient: () => ({
    channel: () => ({ on() { return this; }, subscribe() { return this; } }),
    removeChannel() {},
  }),
}));
vi.mock("@/components/KeyImportOnramp", () => ({ KeyImportOnramp: () => null }));
vi.mock("@/components/PassportIssuanceModal", () => ({ PassportIssuanceModal: () => null }));
vi.mock("@/components/DirectAgentConnect", () => ({ DirectAgentConnect: () => null }));

const { FirstCallActivation } = await import("@/components/dashboard/FirstCallActivation");

const agents = [
  { id: "agent-1", name: "Scout", status: "active", identityKind: "passport" as const },
];
const log = (status: string) => ({
  id: "l1",
  agent_id: "agent-1",
  provider: "openai",
  model: "gpt-5-mini",
  status,
  receipt: null,
  auth_method: "passport" as const,
  created_at: "2026-08-20T10:00:00.000Z",
});

const html = (initialLogs: ReturnType<typeof log>[]) =>
  renderToStaticMarkup(
    <FirstCallActivation
      userId="u1"
      providerConfigured
      controlsExercised={false}
      dismissed={false}
      agents={agents}
      initialLogs={initialLogs}
      integrations={["generic"]}
    />
  );

const steps = (markup: string) =>
  (markup.match(/<li data-state="([a-z]+)"/g) ?? []).map((li) => li.split('"')[1]);

describe("first-call stepper markup", () => {
  it("shows four steps, ending on proving the fleet can be stopped", () => {
    const out = html([]);
    expect(out).toContain("Verify controls");
    expect(steps(out)).toHaveLength(4);
  });

  it("marks the outstanding governed call as current", () => {
    expect(steps(html([]))).toEqual(["complete", "complete", "current", "upcoming"]);
  });

  // ── The regression that shipped, and the test that would have caught it ────
  //
  // Dismissal used to resolve in an effect, so the server rendered nothing and
  // the client never mounted to fix it. Every dismissible stage was invisible on
  // a cold load. `renderToStaticMarkup` IS the first paint, so asserting the
  // markup here is exactly the check that was missing — a source-grep for the
  // guard could never see it.
  it("renders the verified-call stage in the first paint, not after hydration", () => {
    const out = html([log("ok")]);
    expect(out).toContain('data-stage="verify"');
    expect(out).toContain('data-activation-state="verify"');
    expect(out).toContain('data-control="kill"');
    expect(out).toContain("Now close the path");
    // The kill switch is reversible and independent of per-agent suspension,
    // and it purges nothing. This copy sits beside the bar that said otherwise.
    expect(out).not.toMatch(/purge/i);
  });

  it("still hides a dismissed guide in the first paint", () => {
    const out = renderToStaticMarkup(
      <FirstCallActivation
        userId="u1"
        providerConfigured
        controlsExercised={false}
        dismissed
        agents={agents}
        initialLogs={[log("ok")]}
        integrations={["generic"]}
      />
    );
    expect(out).toBe("");
  });

  it("does not un-complete finished setup when a call is refused", () => {
    // `diagnose` is a stage with no step named after it. It must still hold its
    // position in the order, or steps 1 and 2 regress to grey here.
    const out = html([log("blocked_scope")]);
    expect(out).toContain('data-stage="diagnose"');
    expect(steps(out)).toEqual(["complete", "complete", "attention", "upcoming"]);
  });
});
