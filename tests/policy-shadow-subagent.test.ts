// The policy editor's sub-agent model field (sprint Q8, C(a)). The editor is the
// only browser route to the live policy (draft, then Promote), so it must carry
// `subagent_models` through unchanged, and keep the two meanings apart:
//   absent  → sub-agents are not restricted
//   []      → sub-agents may call no model at all
// A cleared field must never quietly become the second.
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/app/dashboard/agents/[id]/shadow-actions", () => ({
  saveAgentPolicyShadow: async () => ({ ok: true }),
  promoteAgentPolicyShadow: async () => ({ ok: true }),
}));

import { SubagentModelsField, toDraft, toPolicy } from "@/components/PolicyShadowPanel";
import { policyIsWellFormed } from "@/lib/scope";

const LIST = [{ provider: "anthropic", models: ["claude-haiku-*", "claude-sonnet-5"] }];

describe("the draft round trip", () => {
  it("carries a sub-agent list through unchanged", () => {
    const policy = toPolicy(toDraft({ subagent_models: LIST }));
    expect(policy).toEqual({ subagent_models: LIST });
    expect(policyIsWellFormed(policy)).toBe(true);
  });

  it("carries an explicit empty list as 'no model at all'", () => {
    const draft = toDraft({ subagent_models: [] });
    expect(draft.subagentNone).toBe(true);
    expect(toPolicy(draft)).toEqual({ subagent_models: [] });
  });

  it("leaves the key out when the field is empty: no restriction", () => {
    expect(toPolicy(toDraft({ max_output_tokens: 1000 }))).toEqual({ max_output_tokens: 1000 });
  });

  it("a cleared field means no restriction, never 'no model at all'", () => {
    const draft = toDraft({ subagent_models: LIST });
    const cleared = { ...draft, subagentRules: [{ provider: "", models: "" }] };
    expect(toPolicy(cleared)).toBeNull();
  });

  it("the explicit choice wins over leftover rows", () => {
    const draft = { ...toDraft({ subagent_models: LIST }), subagentNone: true };
    expect(toPolicy(draft)).toEqual({ subagent_models: [] });
  });

  it("keeps the other fields alongside it", () => {
    const doc = { deny: [{ provider: "openai", models: ["*"] }], max_output_tokens: 4096, subagent_models: LIST };
    expect(toPolicy(toDraft(doc))).toEqual(doc);
  });
});

describe("the field on the panel", () => {
  // The form opens on a click, which a static render cannot make; the field is
  // rendered on its own with the draft the form would hand it.
  const html = renderToStaticMarkup(
    createElement(SubagentModelsField, { draft: toDraft({ subagent_models: LIST }), setDraft: () => {}, pending: false })
  );

  it("is present and pre-filled from the draft", () => {
    expect(html).toContain('data-policy-field="subagent_models"');
    expect(html).toContain("claude-haiku-*, claude-sonnet-5");
  });

  it("says what it is: a guard rail on declared sub-agents, not a security boundary", () => {
    expect(html).toContain("declared");
    expect(html).toContain("not a security boundary");
  });
});
