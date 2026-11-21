// 1.9.0 loop breaker in the policy editor. The editor is the only browser route to the
// live policy (draft, then Promote), so `loop_breaker` must survive the round trip, and an
// empty field must mean "off", never a guessed count.
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/app/dashboard/agents/[id]/shadow-actions", () => ({
  saveAgentPolicyShadow: async () => ({ ok: true }),
  promoteAgentPolicyShadow: async () => ({ ok: true }),
}));

import { LoopBreakerField, toDraft, toPolicy } from "@/components/PolicyShadowPanel";
import { policyIsWellFormed } from "@/lib/scope";

describe("the draft round trip", () => {
  it("carries a repeat count through unchanged", () => {
    const draft = toDraft({ loop_breaker: { repeats: 8 } });
    expect(draft.loopRepeats).toBe("8");
    const policy = toPolicy(draft);
    expect(policy).toEqual({ loop_breaker: { repeats: 8 } });
    expect(policyIsWellFormed(policy)).toBe(true);
  });

  it("leaves the key out when the field is empty: off", () => {
    expect(toPolicy({ ...toDraft(null), loopRepeats: "" })).toBeNull();
  });

  it.each(["abc", "2", "101", "4.5", "-3"])("drops what the gateway would refuse rather than guessing (%j)", (typed) => {
    expect(toPolicy({ ...toDraft(null), loopRepeats: typed })).toBeNull();
  });
});

describe("the field", () => {
  it("says what trips it, what it pauses, and what it does not judge", () => {
    const html = renderToStaticMarkup(createElement(LoopBreakerField, { draft: toDraft(null), setDraft: () => {}, pending: false }));
    expect(html).toContain('data-policy-field="loop_breaker"');
    expect(html).toMatch(/same request/i);
    expect(html).toMatch(/10 minutes/);
    expect(html).toMatch(/15 minutes/);
    expect(html).toMatch(/lifts by itself/i);
    expect(html).toMatch(/eval/i);
  });
});
