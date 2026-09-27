import { describe, expect, it } from "vitest";
import { evaluateAgentPolicy } from "@/lib/scope";

const MONDAY_MORNING = new Date("2026-07-27T10:00:00.000Z");
const MONDAY_EVENING = new Date("2026-07-27T20:00:00.000Z");

describe("agent policy evaluation", () => {
  it("lets a deny rule override an otherwise allowed provider and model", () => {
    expect(
      evaluateAgentPolicy(
        { deny: [{ provider: "openai", models: ["gpt-4*"] }] },
        "openai",
        "gpt-4.1",
        MONDAY_MORNING
      )
    ).toEqual({ allowed: false, reason: "deny", rule: "deny[0]:openai:gpt-4*" });
  });

  it("allows inside a UTC window and blocks outside it using an injected clock", () => {
    const policy = {
      windows: [
        {
          days: ["mon", "tue", "wed", "thu", "fri"],
          start: "09:00",
          end: "18:00",
          tz: "UTC",
        },
      ],
    };

    expect(evaluateAgentPolicy(policy, "openai", "gpt-4.1", MONDAY_MORNING)).toEqual({
      allowed: true,
      maxRequestsPerHour: null,
    });
    expect(evaluateAgentPolicy(policy, "openai", "gpt-4.1", MONDAY_EVENING)).toEqual({
      allowed: false,
      reason: "window",
      rule: "windows:no_match",
    });
  });

  it("pins null and empty policy to the legacy allow behavior", () => {
    const expected = { allowed: true, maxRequestsPerHour: null };
    expect(evaluateAgentPolicy(null, "openai", "gpt-4.1", MONDAY_MORNING)).toEqual(expected);
    expect(evaluateAgentPolicy({}, "openai", "gpt-4.1", MONDAY_MORNING)).toEqual(expected);
  });

  it.each([
    ["an array", []],
    ["an unknown key", { allow: [] }],
    ["a non-UTC timezone", { windows: [{ days: ["mon"], start: "09:00", end: "18:00", tz: "Europe/Sofia" }] }],
    ["an invalid time", { windows: [{ days: ["mon"], start: "9am", end: "18:00", tz: "UTC" }] }],
    ["an invalid limit", { max_requests_per_hour: 0 }],
  ])("fails closed for malformed policy: %s", (_label, policy) => {
    expect(evaluateAgentPolicy(policy, "openai", "gpt-4.1", MONDAY_MORNING)).toEqual({
      allowed: false,
      reason: "malformed",
      rule: "policy:malformed",
    });
  });

  it("returns a validated hourly limit for the route to enforce", () => {
    expect(
      evaluateAgentPolicy({ max_requests_per_hour: 100 }, "openai", "gpt-4.1", MONDAY_MORNING)
    ).toEqual({ allowed: true, maxRequestsPerHour: 100 });
  });
});

// K2 — the output ceiling. Refused, never rewritten: a request is admitted only
// if the limit it states for its own shape is at or under the ceiling.
describe("agent policy output ceiling (max_output_tokens)", () => {
  const policy = { max_output_tokens: 1000 };
  const stated = (tokens: number) => ({ kind: "stated" as const, tokens });

  it("admits a request at or under the ceiling", () => {
    expect(evaluateAgentPolicy(policy, "openai", "gpt-4.1", MONDAY_MORNING, stated(1000))).toEqual({
      allowed: true,
      maxRequestsPerHour: null,
    });
    expect(evaluateAgentPolicy(policy, "openai", "gpt-4.1", MONDAY_MORNING, stated(1))).toMatchObject({ allowed: true });
  });

  it("refuses a request over the ceiling, and names the ceiling", () => {
    expect(evaluateAgentPolicy(policy, "openai", "gpt-4.1", MONDAY_MORNING, stated(1001))).toEqual({
      allowed: false,
      reason: "output_limit",
      rule: "max_output_tokens:exceeded",
      limit: 1000,
    });
  });

  it("refuses a request that states no limit, or an unreadable one", () => {
    expect(evaluateAgentPolicy(policy, "openai", "gpt-4.1", MONDAY_MORNING, { kind: "absent" })).toMatchObject({
      allowed: false,
      rule: "max_output_tokens:missing",
    });
    expect(
      evaluateAgentPolicy(policy, "openai", "gpt-4.1", MONDAY_MORNING, { kind: "invalid", field: "max_tokens" })
    ).toMatchObject({ allowed: false, rule: "max_output_tokens:invalid" });
  });

  it("reads a caller that supplied no request facts as stating no limit, never as exempt", () => {
    expect(evaluateAgentPolicy(policy, "openai", "gpt-4.1", MONDAY_MORNING)).toMatchObject({
      allowed: false,
      rule: "max_output_tokens:missing",
    });
  });

  it("exempts a request that runs no inference (null facts)", () => {
    expect(evaluateAgentPolicy(policy, "openai", "", MONDAY_MORNING, null)).toMatchObject({ allowed: true });
  });

  it("leaves requests alone when no ceiling is configured, whatever they ask for", () => {
    expect(evaluateAgentPolicy({}, "openai", "gpt-4.1", MONDAY_MORNING, { kind: "absent" })).toMatchObject({
      allowed: true,
    });
    expect(evaluateAgentPolicy(null, "openai", "gpt-4.1", MONDAY_MORNING, stated(10_000_000))).toMatchObject({
      allowed: true,
    });
  });

  it("is decided after deny and windows, and before the hourly cap is even asked for", () => {
    const all = {
      deny: [{ provider: "openai", models: ["gpt-4*"] }],
      max_output_tokens: 10,
      max_requests_per_hour: 5,
    };
    expect(evaluateAgentPolicy(all, "openai", "gpt-4.1", MONDAY_MORNING, stated(99))).toMatchObject({ reason: "deny" });
    const windowed = {
      windows: [{ days: ["mon"], start: "09:00", end: "18:00", tz: "UTC" }],
      max_output_tokens: 10,
    };
    expect(evaluateAgentPolicy(windowed, "openai", "gpt-4.1", MONDAY_EVENING, stated(99))).toMatchObject({
      reason: "window",
    });
    // A refused ceiling returns no hourly requirement, so no counter is spent.
    const capped = { max_output_tokens: 10, max_requests_per_hour: 5 };
    const refused = evaluateAgentPolicy(capped, "openai", "gpt-4.1", MONDAY_MORNING, stated(99));
    expect(refused).not.toHaveProperty("maxRequestsPerHour");
    expect(evaluateAgentPolicy(capped, "openai", "gpt-4.1", MONDAY_MORNING, stated(10))).toEqual({
      allowed: true,
      maxRequestsPerHour: 5,
    });
  });

  it.each([0, -5, 1.5, "1000", 10_000_001, null])("reads a ceiling of %s as a malformed policy", (value) => {
    expect(
      evaluateAgentPolicy({ max_output_tokens: value }, "openai", "gpt-4.1", MONDAY_MORNING, stated(1))
    ).toEqual({ allowed: false, reason: "malformed", rule: "policy:malformed" });
  });
});
