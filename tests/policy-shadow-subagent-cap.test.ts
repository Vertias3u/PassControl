// The policy editor's sub-agent session cap (C(b), 2026-10-10). The editor is the only
// browser route to the live policy (draft, then Promote), so it must carry
// `subagent_session_cap_cents` through unchanged. The owner types dollars, the policy
// stores whole cents, and an empty field means "no cap", never "$0".
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/app/dashboard/agents/[id]/shadow-actions", () => ({
  saveAgentPolicyShadow: async () => ({ ok: true }),
  promoteAgentPolicyShadow: async () => ({ ok: true }),
}));

import { SubagentCapField, toDraft, toPolicy } from "@/components/PolicyShadowPanel";
import { policyIsWellFormed } from "@/lib/scope";

describe("the draft round trip", () => {
  it("carries a cap through unchanged, shown in dollars", () => {
    const draft = toDraft({ subagent_session_cap_cents: 250 });
    expect(draft.subagentCap).toBe("2.50");
    const policy = toPolicy(draft);
    expect(policy).toEqual({ subagent_session_cap_cents: 250 });
    expect(policyIsWellFormed(policy)).toBe(true);
  });

  it.each([["2", 200], ["0.5", 50], ["0", 0], [" 1.99 ", 199], ["$3", 300]])("stores %j as %s cents", (typed, cents) => {
    expect(toPolicy({ ...toDraft(null), subagentCap: typed })).toEqual({ subagent_session_cap_cents: cents });
  });

  it("leaves the key out when the field is empty: no cap", () => {
    expect(toPolicy({ ...toDraft(null), subagentCap: "" })).toBeNull();
    expect(toPolicy(toDraft({ max_output_tokens: 1000 }))).toEqual({ max_output_tokens: 1000 });
  });

  it.each(["abc", "-1", "1.234", "100001"])("drops what is not a cap rather than guessing (%j)", (typed) => {
    expect(toPolicy({ ...toDraft(null), subagentCap: typed })).toBeNull();
  });
});

describe("the field", () => {
  it("says what the cap does and what it cannot do", () => {
    const html = renderToStaticMarkup(createElement(SubagentCapField, { draft: toDraft(null), setDraft: () => {}, pending: false }));
    expect(html).toContain('data-policy-field="subagent_session_cap_cents"');
    expect(html).toMatch(/per session/i);
    expect(html).toMatch(/declared/i);
    expect(html).toMatch(/shadow/i);
  });
});
