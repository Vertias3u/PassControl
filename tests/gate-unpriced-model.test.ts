// Under a dollar limit (a cost cap or a periodic limit), a model with no price
// row of its own is refused: its cost could only be the provider fallback, and
// a limit enforced with a number that is not the model's price does not hold.
// Owner decision 2026-09-27. Refused at the gate's endpoint step — before
// policy, the hourly counter and the hold — so the proxy, failover, shadow
// preview and the decision trace all give the same answer.
import { describe, expect, it } from "vitest";
import { evaluateGate, type GateInput } from "../lib/gate";

const base: GateInput = {
  agentId: "agent",
  killState: { platformKill: false, userKill: false, denylist: [] },
  suspended: false,
  scopes: [{ provider: "openai", models: ["*"] }, { provider: "gemini", models: ["*"] }, { provider: "demo", models: ["*"] }],
  provider: "openai",
  method: "POST",
  path: ["v1", "chat", "completions"],
  model: "gpt-5.4-codex",
};

const endpointStep = (g: ReturnType<typeof evaluateGate>) => g.steps.find((s) => s.name === "endpoint");

describe("an unpriced model under a dollar limit", () => {
  it("is refused at the endpoint step with 402 unpriced_model", () => {
    const g = evaluateGate({ ...base, dollarLimited: true });
    expect(g.deniedBy).toBe("endpoint");
    expect(endpointStep(g)).toMatchObject({ status: "fail", rule: "endpoint:unpriced_model", httpStatus: 402 });
  });

  it("is refused before policy, so it cannot consume the hourly counter", () => {
    const g = evaluateGate({ ...base, dollarLimited: true, policy: { kind: "value", value: { max_requests_per_hour: 5 } } });
    expect(g.deniedBy).toBe("endpoint");
    expect(g.policyRateLimitRequired).toBeNull();
  });

  it("is allowed without a dollar limit (a token cap or none)", () => {
    expect(evaluateGate({ ...base, dollarLimited: false }).deniedBy).toBeUndefined();
    expect(evaluateGate(base).deniedBy).toBeUndefined();
  });
});

describe("what the rule leaves alone", () => {
  it("a listed model under a dollar limit", () => {
    expect(evaluateGate({ ...base, dollarLimited: true, model: "gpt-5.4" }).deniedBy).toBeUndefined();
  });

  it("Gemini's models/ spelling of a listed model", () => {
    const g = evaluateGate({ ...base, dollarLimited: true, provider: "gemini", model: "models/gemini-2.5-flash", path: ["chat", "completions"] });
    expect(g.deniedBy).toBeUndefined();
  });

  it("a model listing, which has no model and costs nothing", () => {
    const g = evaluateGate({ ...base, dollarLimited: true, method: "GET", path: ["v1", "models"], model: "" });
    expect(g.deniedBy).toBeUndefined();
  });

  it("the demo provider, which is priced at its own flat rate", () => {
    const g = evaluateGate({ ...base, dollarLimited: true, provider: "demo", model: "demo-1", path: ["chat", "completions"] });
    expect(g.deniedBy).toBeUndefined();
  });

  it("an earlier refusal keeps its own reason (scope comes first)", () => {
    const g = evaluateGate({ ...base, dollarLimited: true, scopes: [{ provider: "openai", models: ["gpt-4o"] }] });
    expect(g.deniedBy).toBe("scope");
  });
});
