// How an agent's limits read to a person (1.4.0 candidate 2): one formatter for the
// MCP `budget` tool and `passcontrol statusline`, fed by GET /api/v1/self.
//
// The rules a money display gets wrong first:
//   * unknown is "?", never "$0.00";
//   * no limit says "no limit", never "$0.00 of null";
//   * a real but tiny amount is "<$0.01", not "$0.00".
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM CLI module, no declaration file
import { budgetLines, formatUsd, statusLine } from "../cli/budget-format.mjs";

const USD = 100_000_000; // microcents per dollar
const self = (budget: Record<string, unknown>) => ({ agent_id: "a", auth: "passport", scope: [], as_of: "", budget });
const DAY = { kind: "day", limit_microcents: 2 * USD, used_microcents: 0.42 * USD, remaining_microcents: 1.58 * USD, resets_in_seconds: 11 * 3600 };

describe("formatUsd", () => {
  it.each([
    [0, "$0.00"],
    [42_000_000, "$0.42"],
    [2 * USD, "$2.00"],
    [123_456 * USD, "$123,456.00"],
    [1, "<$0.01"],
    [null, "?"],
  ])("%s µ¢ is %s", (value, text) => {
    expect(formatUsd(value)).toBe(text);
  });
});

describe("statusLine", () => {
  it("leads with today's spend against the daily limit", () => {
    expect(statusLine(self({ tokens: null, cost: null, period: DAY }))).toBe("PassControl · $0.42 of $2.00 today");
  });

  it("names a monthly limit as this month", () => {
    expect(statusLine(self({ tokens: null, cost: null, period: { ...DAY, kind: "month" } }))).toBe(
      "PassControl · $0.42 of $2.00 this month"
    );
  });

  it("falls back to the lifetime dollar cap, then the token cap", () => {
    const cost = { limit_microcents: 5 * USD, used_microcents: 1.2 * USD, remaining_microcents: 3.8 * USD };
    expect(statusLine(self({ tokens: null, cost, period: null }))).toBe("PassControl · $1.20 of $5.00 total");
    const tokens = { limit: 50_000, used: 12_300, remaining: 37_700 };
    expect(statusLine(self({ tokens, cost: null, period: null }))).toBe("PassControl · 12.3k of 50k tokens");
  });

  it("says no limit when there is none", () => {
    expect(statusLine(self({ tokens: null, cost: null, period: null }))).toBe("PassControl · no limit");
  });

  it("shows an unreadable count as ?, never $0.00", () => {
    const line = statusLine(self({ tokens: null, cost: null, period: { ...DAY, used_microcents: null, remaining_microcents: null } }));
    expect(line).toBe("PassControl · ? of $2.00 today");
  });

  it("says when the limit itself cannot be read", () => {
    expect(statusLine(self({ tokens: null, cost: null, period: { unknown: true } }))).toBe("PassControl · limit unknown");
  });
});

describe("budgetLines", () => {
  it("states every limit with what is left and when the period resets", () => {
    const cost = { limit_microcents: 5 * USD, used_microcents: 1.2 * USD, remaining_microcents: 3.8 * USD };
    const lines = budgetLines(self({ tokens: null, cost, period: DAY }));
    expect(lines).toEqual([
      "Today: $0.42 of $2.00 used, $1.58 left (resets in 11h).",
      "Lifetime: $1.20 of $5.00 used, $3.80 left.",
    ]);
  });

  it("says plainly when nothing limits the agent", () => {
    expect(budgetLines(self({ tokens: null, cost: null, period: null }))).toEqual(["No spending or token limit is set for this agent."]);
  });
});
