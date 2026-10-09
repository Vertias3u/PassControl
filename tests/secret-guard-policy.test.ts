// The secret guard's switch: a policy key, `secret_guard: { mode: "block" | "redact" }`,
// absent meaning off (owner, 2026-10-08). An object rather than a bare string so v2 can
// add personal data or "ask me first" without changing the format.
//
// It crosses the same rollback line as `subagent_models` in this release: code from
// before it reads the key as a malformed policy and refuses every call for that agent.
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/app/dashboard/agents/[id]/shadow-actions", () => ({
  saveAgentPolicyShadow: async () => ({ ok: true }),
  promoteAgentPolicyShadow: async () => ({ ok: true }),
}));

import { agentPolicyForDisplay, policyIsWellFormed, secretGuardMode } from "@/lib/scope";
import { SecretGuardField, toDraft, toPolicy } from "@/components/PolicyShadowPanel";

describe("the policy key", () => {
  it.each(["block", "redact"])("accepts mode %s", (mode) => {
    expect(policyIsWellFormed({ secret_guard: { mode } })).toBe(true);
    expect(secretGuardMode({ secret_guard: { mode } })).toBe(mode);
  });

  it("absent means off", () => {
    expect(secretGuardMode({})).toBeNull();
    expect(secretGuardMode(null)).toBeNull();
  });

  it.each([
    ["a bare string", { secret_guard: "block" }],
    ["an unknown mode", { secret_guard: { mode: "warn" } }],
    ["no mode", { secret_guard: {} }],
    ["an extra key", { secret_guard: { mode: "block", pii: true } }],
  ])("refuses %s", (_name, policy) => {
    expect(policyIsWellFormed(policy)).toBe(false);
    expect(secretGuardMode(policy)).toBeNull();
  });

  it("is shown in the owner-facing summary", () => {
    expect(agentPolicyForDisplay({ secret_guard: { mode: "redact" } }).secretGuard).toBe("redact");
    expect(agentPolicyForDisplay({}).secretGuard).toBeNull();
  });
});

describe("the editor", () => {
  it("round-trips the mode", () => {
    expect(toPolicy(toDraft({ secret_guard: { mode: "block" } }))).toEqual({ secret_guard: { mode: "block" } });
    expect(toPolicy(toDraft({ max_output_tokens: 10, secret_guard: { mode: "redact" } }))).toEqual({
      max_output_tokens: 10,
      secret_guard: { mode: "redact" },
    });
  });

  it("off leaves the key out", () => {
    expect(toPolicy({ ...toDraft({ secret_guard: { mode: "block" } }), secretGuard: "" })).toBeNull();
  });

  const html = renderToStaticMarkup(
    createElement(SecretGuardField, { draft: toDraft({ secret_guard: { mode: "redact" } }), setDraft: () => {}, pending: false })
  );

  it("offers off, redact and block, with redact selected", () => {
    expect(html).toContain('data-policy-field="secret_guard"');
    expect(html).toMatch(/value="redact"[^>]*checked|checked[^>]*value="redact"/);
    expect(html).toContain('value="block"');
  });

  it("says what each mode does to a coding session, in plain words", () => {
    expect(html).toContain("re-send the whole conversation");
    expect(html.toLowerCase()).toContain("placeholder");
  });
});
