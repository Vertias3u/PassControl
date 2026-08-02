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
