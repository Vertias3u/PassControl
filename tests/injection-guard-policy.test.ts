// The injection guard's switch (plans/injection-guard.md §4): a policy key,
// `injection_guard: { mode: "monitor" }`, absent meaning off.
//
// "monitor" records (Phase 1). "hold" (Phase 2, opened once every surface enforced it)
// records and, after a strong finding, holds the agent's risky actions for the owner.
// Anything else is a document this build cannot honour: it reads as malformed and the
// policy step refuses the agent's calls (fail closed).
//
// Like `secret_guard`, it crosses a rollback line: code from before it reads the key (in
// either mode) as a malformed policy and refuses every call for that agent, and code
// from Phase 1 reads "hold" the same way.
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/app/dashboard/agents/[id]/shadow-actions", () => ({
  saveAgentPolicyShadow: async () => ({ ok: true }),
  promoteAgentPolicyShadow: async () => ({ ok: true }),
}));

import { agentPolicyForDisplay, injectionGuardMode, policyIsWellFormed } from "@/lib/scope";
import { InjectionGuardField, toDraft, toPolicy } from "@/components/PolicyShadowPanel";

describe("the policy key", () => {
  it("accepts monitor", () => {
    expect(policyIsWellFormed({ injection_guard: { mode: "monitor" } })).toBe(true);
    expect(injectionGuardMode({ injection_guard: { mode: "monitor" } })).toBe("monitor");
  });

  it("accepts hold", () => {
    expect(policyIsWellFormed({ injection_guard: { mode: "hold" } })).toBe(true);
    expect(injectionGuardMode({ injection_guard: { mode: "hold" } })).toBe("hold");
  });

  it("sits beside the secret guard", () => {
    const policy = { secret_guard: { mode: "redact" }, injection_guard: { mode: "monitor" } };
    expect(policyIsWellFormed(policy)).toBe(true);
    expect(injectionGuardMode(policy)).toBe("monitor");
  });

  it("absent means off", () => {
    expect(injectionGuardMode({})).toBeNull();
    expect(injectionGuardMode(null)).toBeNull();
  });

  it.each([
    ["a bare string", { injection_guard: "monitor" }],
    ["an unknown mode", { injection_guard: { mode: "block" } }],
    ["no mode", { injection_guard: {} }],
    ["an extra key", { injection_guard: { mode: "monitor", ttl_minutes: 30 } }],
  ])("refuses %s", (_name, policy) => {
    expect(policyIsWellFormed(policy)).toBe(false);
    expect(injectionGuardMode(policy)).toBeNull();
  });

  it("is shown in the owner-facing summary", () => {
    expect(agentPolicyForDisplay({ injection_guard: { mode: "monitor" } }).injectionGuard).toBe("monitor");
    expect(agentPolicyForDisplay({}).injectionGuard).toBeNull();
    expect(agentPolicyForDisplay({ injection_guard: { mode: "hold" } }).injectionGuard).toBe("hold");
  });
});

describe("the editor", () => {
  it("round-trips the mode", () => {
    expect(toPolicy(toDraft({ injection_guard: { mode: "monitor" } }))).toEqual({ injection_guard: { mode: "monitor" } });
    expect(toPolicy(toDraft({ secret_guard: { mode: "block" }, injection_guard: { mode: "monitor" } }))).toEqual({
      secret_guard: { mode: "block" },
      injection_guard: { mode: "monitor" },
    });
  });

  it("round-trips hold: saving an unrelated change never turns a hold off", () => {
    expect(toPolicy(toDraft({ injection_guard: { mode: "hold" } }))).toEqual({ injection_guard: { mode: "hold" } });
    expect(toPolicy({ ...toDraft({ injection_guard: { mode: "hold" } }), cap: "50" })).toEqual({
      max_requests_per_hour: 50,
      injection_guard: { mode: "hold" },
    });
  });

  it("off leaves the key out", () => {
    expect(toPolicy({ ...toDraft({ injection_guard: { mode: "monitor" } }), injectionGuard: "" })).toBeNull();
  });

  const html = renderToStaticMarkup(
    createElement(InjectionGuardField, { draft: toDraft({ injection_guard: { mode: "monitor" } }), setDraft: () => {}, pending: false })
  );

  it("offers off, record and hold, with record selected", () => {
    expect(html).toContain('data-policy-field="injection_guard"');
    expect(html).toMatch(/value="monitor"[^>]*checked|checked[^>]*value="monitor"/);
    expect(html).toContain('value="hold"');
  });

  it("says plainly that record refuses nothing and that no text is kept", () => {
    expect(html.toLowerCase()).toContain("nothing is refused");
    expect(html.toLowerCase()).toContain("never stored");
  });

  it("says which actions hold waits on, surface by surface, without promising Claude Code tools everywhere", () => {
    const hold = renderToStaticMarkup(
      createElement(InjectionGuardField, { draft: toDraft({ injection_guard: { mode: "hold" } }), setDraft: () => {}, pending: false })
    );
    expect(hold).toMatch(/value="hold"[^>]*checked|checked[^>]*value="hold"/);
    expect(hold).toMatch(/service writes/i);
    expect(hold).toMatch(/tool hook/i);
    expect(hold).toMatch(/30 minutes/);
  });
});
