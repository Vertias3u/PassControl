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

  // v1 playbook Session 06: "Given a missing enforcement field on an old
  // record, then it says unavailable/legacy unknown rather than inferring
  // enforcement from observation." `enforced_*` is absent on rows written
  // before 0055 AND when a settlement was refused, so absence here is not
  // "charged the observed amount". This used to render "$0.000000" — a charge
  // of zero the row does not record.
  it("says the charge is not recorded when a usage_unknown row stores no enforced amount", () => {
    const html = render({ ...base, status: "usage_unknown" });
    expect(html).toContain('data-cap-charge="not_recorded"');
    expect(html).toContain("<dt>Budget tokens</dt><dd>Not recorded on this row</dd>");
    expect(html).not.toContain("$0.000000");
  });

  it("never shows a refused call's stored zeros as a measurement", () => {
    const html = render({ ...base, status: "blocked_scope", auth_method: "direct_key" });
    expect(html).toContain("Not sent — nothing to measure");
    expect(html).toContain("Not sent — no cost");
    expect(html).not.toMatch(/visa/i);
  });

  it("keeps a reported zero distinct from an unreported count", () => {
    const zero = render({ ...base, input_tokens: 0, output_tokens: 0, cost_microcents: 0 });
    expect(zero).toContain("<dt>Total tokens</dt><dd>0</dd>");
    const missing = render({ ...base, input_tokens: null, output_tokens: null, cost_microcents: null });
    expect(missing).toContain("<dt>Total tokens</dt><dd>Not reported</dd>");
    expect(missing).toContain("No recorded cost — unknown, not zero");
    const partial = render({ ...base, input_tokens: 120, output_tokens: null, cost_microcents: null });
    expect(partial).toContain("120 + not reported");
  });

  it("says a dispatch_unavailable reservation is still held rather than returned", () => {
    const html = render({ ...base, status: "dispatch_unavailable" });
    expect(html).toContain('data-cap-charge="held"');
    expect(html).toContain("Reservation still held");
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
