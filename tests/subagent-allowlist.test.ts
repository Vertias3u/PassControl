// Sub-agent model allowlist (sprint Bet C(a), D5(a)): an owner can say "sub-agents
// of this agent may only use these models". A policy key, `subagent_models`, in the
// scope-entry shape; enforced at the scope step when the call's DECLARED lineage
// names a sub-agent (lib/client-lineage.ts). No money code is touched.
//
// It is a guard rail against a misbehaving model, not a security boundary: any
// local process can leave out the sub-agent header and be treated as the main
// agent. That is the honest consequence of a declared signal.
import { describe, expect, it } from "vitest";

import { evaluateGate, type GateInput } from "@/lib/gate";
import { POLICY_LIMITS, agentPolicyForDisplay, policyIsWellFormed, subagentAllowlist } from "@/lib/scope";

const HAIKU_ONLY = [{ provider: "anthropic", models: ["claude-haiku-*"] }];

describe("parsing subagent_models", () => {
  it("accepts an allowlist in the scope-entry shape", () => {
    expect(policyIsWellFormed({ subagent_models: HAIKU_ONLY })).toBe(true);
    expect(subagentAllowlist({ subagent_models: HAIKU_ONLY })).toEqual(HAIKU_ONLY);
  });

  it("keeps absent and empty apart: absent restricts nothing, [] allows sub-agents no model", () => {
    expect(subagentAllowlist({})).toBeNull();
    expect(subagentAllowlist(null)).toBeNull();
    expect(subagentAllowlist({ subagent_models: [] })).toEqual([]);
  });

  it.each([
    ["not an array", { subagent_models: "anthropic" }],
    ["an extra key in an entry", { subagent_models: [{ provider: "anthropic", models: ["x"], extra: 1 }] }],
    ["an empty provider", { subagent_models: [{ provider: "", models: ["x"] }] }],
    ["an unusable pattern", { subagent_models: [{ provider: "anthropic", models: ["*a*b*c*d*e*"] }] }],
    ["models not an array", { subagent_models: [{ provider: "anthropic", models: "x" }] }],
    ["too many entries", { subagent_models: Array.from({ length: POLICY_LIMITS.denyRules + 1 }, () => ({ provider: "p", models: ["m"] })) }],
  ])("refuses %s", (_name, policy) => {
    expect(policyIsWellFormed(policy)).toBe(false);
    expect(subagentAllowlist(policy)).toBeNull();
  });

  it("draws on the same pattern budget as deny rules, so the per-request worst case does not grow", () => {
    const rules = (n: number) => [{ provider: "anthropic", models: Array.from({ length: n }, (_, i) => `m${i}`) }];
    const half = POLICY_LIMITS.denyPatterns / 2;
    expect(policyIsWellFormed({ deny: rules(half), subagent_models: rules(half) })).toBe(true);
    expect(policyIsWellFormed({ deny: rules(half), subagent_models: rules(half + 1) })).toBe(false);
  });

  it("is shown in the owner-facing summary", () => {
    expect(agentPolicyForDisplay({ subagent_models: HAIKU_ONLY }).subagentModels).toEqual(HAIKU_ONLY);
    expect(agentPolicyForDisplay({}).subagentModels).toBeNull();
  });
});

const base: GateInput = {
  agentId: "agent-1",
  killState: { platformKill: false, userKill: false, denylist: [] },
  suspended: false,
  scopes: [{ provider: "anthropic", models: ["claude-*"] }],
  provider: "anthropic",
  method: "POST",
  path: ["v1", "messages"],
  model: "claude-sonnet-5",
};
const scopeStep = (input: GateInput) => evaluateGate(input).steps.find((s) => s.name === "scope")!;

describe("the scope step with a sub-agent allowlist", () => {
  it("refuses a sub-agent asking for a model the list does not hold, and says it is the sub-agent rule", () => {
    const step = scopeStep({ ...base, subagent: { agent: "a1", allow: HAIKU_ONLY } });
    expect(step).toMatchObject({ status: "fail", rule: "scope:subagent_no_match", httpStatus: 403 });
    expect(step.reason).toContain("Sub-agent a1");
    expect(step.reason).toContain("anthropic/claude-sonnet-5");
  });

  it("admits a sub-agent asking for a listed model", () => {
    expect(scopeStep({ ...base, model: "claude-haiku-4-5", subagent: { agent: "a1", allow: HAIKU_ONLY } }).status).toBe("pass");
  });

  it("leaves the main agent alone: no declared sub-agent, no narrowing", () => {
    expect(scopeStep(base).status).toBe("pass");
  });

  it("narrows nothing when the policy sets no list", () => {
    expect(scopeStep({ ...base, subagent: { agent: "a1", allow: null } }).status).toBe("pass");
  });

  it("refuses every sub-agent call under an explicit empty list", () => {
    expect(scopeStep({ ...base, model: "claude-haiku-4-5", subagent: { agent: "a1", allow: [] } }).rule).toBe("scope:subagent_no_match");
  });

  it("can only narrow: a listed model outside the agent's own scope is still refused by the scope", () => {
    const step = scopeStep({ ...base, provider: "openai", model: "gpt-5-mini", subagent: { agent: "a1", allow: [{ provider: "openai", models: ["gpt-5-mini"] }] } });
    expect(step.rule).toBe("scope:no_match");
  });

  it("does not govern a model listing, which names no model", () => {
    expect(scopeStep({ ...base, method: "GET", path: ["v1", "models"], model: "", subagent: { agent: "a1", allow: [] } }).status).toBe("skipped");
  });

  it("refuses at the scope step, before the policy and the budget are consulted", () => {
    const gate = evaluateGate({ ...base, subagent: { agent: "a1", allow: HAIKU_ONLY }, policy: { kind: "value", value: null } });
    expect(gate.deniedBy).toBe("scope");
  });
});
