// 1.9.0 per-session caps in the policy editor. The editor is the only browser route to the
// live policy, so `session_caps` must survive the round trip; each empty field means that
// cap is off, and a value the gateway would refuse is dropped rather than guessed at.
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/app/dashboard/agents/[id]/shadow-actions", () => ({
  saveAgentPolicyShadow: async () => ({ ok: true }),
  promoteAgentPolicyShadow: async () => ({ ok: true }),
}));

import { SessionCapsField, toDraft, toPolicy } from "@/components/PolicyShadowPanel";
import { policyIsWellFormed } from "@/lib/scope";

describe("the draft round trip", () => {
  it("carries all three caps through unchanged, the money one shown in dollars", () => {
    const draft = toDraft({ session_caps: { cents: 250, calls: 200, minutes: 30 } });
    expect(draft).toMatchObject({ sessionCapDollars: "2.50", sessionCapCalls: "200", sessionCapMinutes: "30" });
    const policy = toPolicy(draft);
    expect(policy).toEqual({ session_caps: { cents: 250, calls: 200, minutes: 30 } });
    expect(policyIsWellFormed(policy)).toBe(true);
  });

  it("writes only the caps that are filled in", () => {
    expect(toPolicy({ ...toDraft(null), sessionCapCalls: "50" })).toEqual({ session_caps: { calls: 50 } });
    expect(toPolicy({ ...toDraft(null), sessionCapDollars: "$3" })).toEqual({ session_caps: { cents: 300 } });
  });

  it("leaves the key out when every field is empty", () => {
    expect(toPolicy(toDraft(null))).toBeNull();
  });

  it.each([
    ["sessionCapDollars", "0"],
    ["sessionCapDollars", "1.234"],
    ["sessionCapCalls", "0"],
    ["sessionCapCalls", "2.5"],
    ["sessionCapMinutes", "1441"],
    ["sessionCapMinutes", "abc"],
  ])("drops %s = %j rather than guessing", (field, typed) => {
    expect(toPolicy({ ...toDraft(null), [field]: typed })).toBeNull();
  });
});

describe("the field", () => {
  it("says what each cap counts, that sessions are declared, and that the agent's own limits stay", () => {
    const html = renderToStaticMarkup(createElement(SessionCapsField, { draft: toDraft(null), setDraft: () => {}, pending: false }));
    expect(html).toContain('data-policy-field="session_caps"');
    expect(html).toMatch(/dollars/i);
    expect(html).toMatch(/calls/i);
    expect(html).toMatch(/minutes/i);
    expect(html).toMatch(/declared/i);
    expect(html).toMatch(/no session/i);
  });
});
