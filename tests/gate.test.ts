import { describe, expect, it } from "vitest";
import {
  POLICY_UNREADABLE,
  evaluateGate,
  type GateInput,
  type GateStepName,
} from "@/lib/gate";

const MONDAY_MORNING = new Date("2026-07-27T10:00:00.000Z");

function allowedInput(overrides: Partial<GateInput> = {}): GateInput {
  return {
    agentId: "agent-a",
    killState: { platformKill: false, userKill: false, denylist: [] },
    suspended: false,
    scopes: [{ provider: "openai", models: ["gpt-4*"] }],
    provider: "openai",
    method: "POST",
    path: ["chat", "completions"],
    model: "gpt-4.1",
    policy: { kind: "value", value: {} },
    policyFailClosed: false,
    now: MONDAY_MORNING,
    budget: {
      ok: true,
      estimateTokens: 1_025,
      estimateMicrocents: 8_000,
      reservedTokens: 1_025,
      reservedMicrocents: 8_000,
      source: "atomic_reserve",
    },
    ...overrides,
  };
}

function statusByStep(input: GateInput): Record<GateStepName, string> {
  return Object.fromEntries(
    evaluateGate(input).steps.map((step) => [step.name, step.status])
  ) as Record<GateStepName, string>;
}

describe("shared ordered gate evaluator", () => {
  it.each([
    [
      "kill",
      allowedInput({
        killState: { platformKill: false, userKill: true, denylist: [] },
      }),
      "kill",
    ],
    ["suspend", allowedInput({ suspended: true }), "suspend"],
    ["scope", allowedInput({ scopes: [{ provider: "openai", models: ["gpt-3*"] }] }), "scope"],
    ["endpoint", allowedInput({ path: ["files"] }), "endpoint"],
    [
      "policy",
      allowedInput({
        policy: {
          kind: "value",
          value: { deny: [{ provider: "openai", models: ["gpt-4*"] }] },
        },
      }),
      "policy",
    ],
    [
      "budget",
      allowedInput({
        budget: {
          ok: false,
          reason: "tokens",
          estimateTokens: 1_025,
          estimateMicrocents: 8_000,
          source: "atomic_reserve",
        },
      }),
      "budget",
    ],
    ["fully allowed", allowedInput(), undefined],
  ])("matches the proxy verdict for %s", (_label, input, deniedBy) => {
    const result = evaluateGate(input);
    expect(result.complete).toBe(true);
    expect(result.verdict).toBe(deniedBy ? "deny" : "allow");
    expect(result.deniedBy).toBe(deniedBy);
  });

  it("short-circuits in order and marks every later step skipped", () => {
    expect(
      statusByStep(
        allowedInput({ scopes: [{ provider: "openai", models: ["gpt-3*"] }] })
      )
    ).toEqual({
      kill: "pass",
      suspend: "pass",
      scope: "fail",
      endpoint: "skipped",
      policy: "skipped",
      budget: "skipped",
    });
  });

  it("names the exact scope and policy rules that matched", () => {
    const allowed = evaluateGate(allowedInput());
    expect(allowed.steps.find((step) => step.name === "scope")?.rule).toBe(
      "scope:openai:gpt-4*"
    );

    const denied = evaluateGate(
      allowedInput({
        policy: {
          kind: "value",
          value: { deny: [{ provider: "openai", models: ["gpt-4*"] }] },
        },
      })
    );
    expect(denied.steps.find((step) => step.name === "policy")?.rule).toBe(
      "deny[0]:openai:gpt-4*"
    );
  });

  it("reuses the injected clock for deterministic policy-window traces", () => {
    const policy = {
      kind: "value" as const,
      value: { windows: [{ days: ["mon"], start: "09:00", end: "18:00", tz: "UTC" }] },
    };
    expect(evaluateGate(allowedInput({ policy })).verdict).toBe("allow");
    expect(
      evaluateGate(allowedInput({ policy, now: new Date("2026-07-27T20:00:00.000Z") }))
        .deniedBy
    ).toBe("policy");
  });

  it("represents unreadable policy explicitly under both operator postures", () => {
    const failOpen = evaluateGate(
      allowedInput({ policy: { kind: POLICY_UNREADABLE }, policyFailClosed: false })
    );
    const openStep = failOpen.steps.find((step) => step.name === "policy");
    expect(failOpen.verdict).toBe("allow");
    expect(failOpen.policy).toEqual({ outcome: "unreadable", posture: "fail_open" });
    expect(openStep).toMatchObject({ status: "pass", presentation: "warning" });
    expect(openStep?.reason).toMatch(/unreadable.*fail-open/i);

    const failClosed = evaluateGate(
      allowedInput({ policy: { kind: POLICY_UNREADABLE }, policyFailClosed: true })
    );
    const closedStep = failClosed.steps.find((step) => step.name === "policy");
    expect(failClosed.verdict).toBe("deny");
    expect(failClosed.policy).toEqual({ outcome: "unreadable", posture: "fail_closed" });
    expect(closedStep).toMatchObject({ status: "fail", presentation: "warning" });
    expect(closedStep?.reason).toMatch(/unreadable.*fail-closed/i);
  });

  it("does not claim completion before the route supplies its atomic reserve result", () => {
    const input = allowedInput();
    delete input.budget;
    const result = evaluateGate(input);
    expect(result.complete).toBe(false);
    expect(result.steps.find((step) => step.name === "budget")).toMatchObject({
      status: "skipped",
    });
  });
});
