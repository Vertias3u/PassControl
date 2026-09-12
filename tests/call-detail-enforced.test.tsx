import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { DepartureRow } from "@/lib/departures";

// The zero that is not an observation.
//
// A `usage_unknown` row stores 0 input and 0 output tokens because no usage
// report ever arrived — NOT because the call was free. It is also the one row
// shape where the stored figures are not what moved money: the attempt was
// charged at max(observed, reserved), and only `enforced_*` says how much.
//
// Rendering the stored zeros bare is the failure this project has already been
// bitten by once, when a forged receipt displayed "Signature matches ✓" against
// a green rail with the whole suite passing. The DOM was the only place it
// showed. So these assertions read the rendered markup.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

const { CallDetailDrawer } = await import("@/components/dashboard/CallDetailDrawer");

const base: DepartureRow = {
  id: "row-1",
  agent_id: "7a000000-0000-4000-8000-0000000055a1",
  user_id: "u1",
  created_at: "2026-09-05T11:17:33.000Z",
  passport_id: "c3RhdHVzLWNoZWNr",
  jti: "jti-status",
  provider: "anthropic",
  model: "claude-opus-5",
  input_tokens: 0,
  output_tokens: 0,
  cost_microcents: null,
  status: "ok",
  latency_ms: 4310,
  receipt: null,
  policy_shadow_would: null,
};

const render = (row: DepartureRow) =>
  renderToStaticMarkup(
    <CallDetailDrawer row={row} open onOpenChange={() => {}} currentShadowRevision={null} />
  );

describe("what a usage_unknown row is allowed to claim", () => {
  it("marks the observed figures unconfirmed instead of showing a bare zero", () => {
    const html = render({ ...base, status: "usage_unknown" });
    expect(html).toContain("(unconfirmed)");
  });

  it("shows what the budget was actually charged, beside what was observed", () => {
    const html = render({
      ...base,
      status: "usage_unknown",
      enforced_tokens: 3400,
      enforced_microcents: 9100,
    });
    expect(html).toContain("<dt>Budget tokens</dt>");
    expect(html).toContain("3,400");
    expect(html).toContain("<dt>Budget charge</dt>");
    expect(html).toContain("$0.000091");
  });

  // The prose in STATUS used to promise "the enforced figures" while the drawer
  // rendered none of them — a sentence pointing at a number that is not on the
  // page, which is worse than no sentence. It is hedged now ("where the row
  // records them"), and a row that records neither must still render the zero
  // budget result rather than omitting the accounting dimension.
  it("renders an explicit zero budget charge when no enforced amount exists", () => {
    const html = render({ ...base, status: "usage_unknown" });
    expect(html).toContain("<dt>Budget tokens</dt><dd>0</dd>");
    expect(html).toContain("<dt>Budget charge</dt>");
    expect(html).toContain("$0.000000");
  });

  // An ordinary row is an observation. Nothing about it is hedged, and the
  // enforced rows must not appear — they would imply a discrepancy that the row
  // does not record.
  it("leaves an ordinary allowed call completely alone", () => {
    const html = render({ ...base, input_tokens: 120, output_tokens: 300, cost_microcents: 4200 });
    expect(html).not.toContain("(unconfirmed)");
    expect(html).toContain("<dt>Budget tokens</dt><dd>420</dd>");
    expect(html).toContain("420");
  });

  // Only ONE dimension recorded is a real shape: an unpriced provider charges
  // tokens against the cap with no cost figure at all. The half that exists
  // must still be shown rather than suppressed with its missing partner.
  it("shows the dimension it has when only one was enforced", () => {
    const html = render({ ...base, status: "usage_unknown", enforced_tokens: 3400 });
    expect(html).toContain("<dt>Budget tokens</dt>");
    expect(html).toContain("3,400");
    expect(html).toContain("<dt>Budget charge</dt>");
  });
});
