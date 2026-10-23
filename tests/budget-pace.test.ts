// When an agent will reach its budget at the rate it is spending (1.6.0, L1).
//
// One computation on the server, read by `/self`, so the agent's own note, the
// status line and the alerts all quote the same time. Two rules:
//   * no guess: too little time observed, or nothing readable, is `null`, which
//     readers show as no pace at all;
//   * "not before it resets" is a real answer (`reaches_limit_at: null`), distinct
//     from "unknown" (the whole pace is null).
import { describe, expect, it } from "vitest";
import { budgetPace, projectedDate } from "@/lib/budget-pace";
import type { BudgetView } from "@/lib/budget-view";

const NOW = Date.UTC(2026, 9, 22, 12); // noon UTC: half the day gone
const HOUR = 3_600_000;
const day = (limit: number, used: number | null): BudgetView["period"] => ({
  kind: "day",
  limit_microcents: limit,
  used_microcents: used,
  remaining_microcents: used === null ? null : Math.max(0, limit - used),
  resets_in_seconds: 12 * 3600,
});
const view = (over: Partial<BudgetView> = {}): BudgetView => ({ tokens: null, cost: null, period: null, ...over });

describe("budgetPace", () => {
  it("projects a daily limit from what this period has counted over the time it has run", () => {
    // $8 of $20 in 12 hours: $12 more needs 18 hours at that rate, past midnight.
    expect(budgetPace(view({ period: day(20e8, 8e8) }), null, NOW)).toEqual({
      reaches_limit_at: null,
      limit: "period",
      basis: "this_period",
    });
    // $15 of $20 in 12 hours: $5 more takes 4 hours, so 16:00.
    expect(budgetPace(view({ period: day(20e8, 15e8) }), null, NOW)).toEqual({
      reaches_limit_at: new Date(NOW + 4 * HOUR).toISOString(),
      limit: "period",
      basis: "this_period",
    });
  });

  it("says nothing in the first ten minutes of a period, when one call would set the rate", () => {
    const early = Date.UTC(2026, 9, 22, 0, 9);
    expect(budgetPace(view({ period: day(20e8, 1e8) }), null, early)).toBeNull();
  });

  it("an unreadable count, or an unknown limit, is no pace rather than a guess", () => {
    expect(budgetPace(view({ period: day(20e8, null) }), null, NOW)).toBeNull();
    expect(budgetPace(view({ period: { unknown: true } }), null, NOW)).toBeNull();
    expect(budgetPace(view(), null, NOW)).toBeNull();
  });

  it("an agent already at its limit reaches it now", () => {
    expect(budgetPace(view({ period: day(20e8, 21e8) }), null, NOW)?.reaches_limit_at).toBe(new Date(NOW).toISOString());
  });

  it("projects a limit with no period from the last 24 hours of spend", () => {
    const cost = { limit_microcents: 10e8, used_microcents: 4e8, remaining_microcents: 6e8 };
    // $2 a day, $6 left: three days.
    expect(budgetPace(view({ cost }), { tokens: 0, microcents: 2e8 }, NOW)).toEqual({
      reaches_limit_at: new Date(NOW + 72 * HOUR).toISOString(),
      limit: "cost",
      basis: "last_24h",
    });
    // Nothing spent in a day: it is not on its way to the limit.
    expect(budgetPace(view({ cost }), { tokens: 0, microcents: 0 }, NOW)).toEqual({
      reaches_limit_at: null,
      limit: "cost",
      basis: "last_24h",
    });
    // The last day unreadable: no pace.
    expect(budgetPace(view({ cost }), null, NOW)).toBeNull();
  });

  it("projects a token limit the same way", () => {
    const tokens = { limit: 1_000_000, used: 400_000, remaining: 600_000 };
    expect(budgetPace(view({ tokens }), { tokens: 300_000, microcents: 0 }, NOW)?.reaches_limit_at).toBe(
      new Date(NOW + 48 * HOUR).toISOString()
    );
  });

  it("names the limit reached first when several are on their way", () => {
    const cost = { limit_microcents: 10e8, used_microcents: 4e8, remaining_microcents: 6e8 }; // 3 days
    expect(budgetPace(view({ cost, period: day(20e8, 15e8) }), { tokens: 0, microcents: 2e8 }, NOW)).toMatchObject({
      limit: "period",
      reaches_limit_at: new Date(NOW + 4 * HOUR).toISOString(),
    });
    // When the period is safe, the lifetime limit is the one to name.
    expect(budgetPace(view({ cost, period: day(20e8, 1e8) }), { tokens: 0, microcents: 2e8 }, NOW)).toMatchObject({
      limit: "cost",
      basis: "last_24h",
    });
  });

  it("with nothing on its way, the period is the one named", () => {
    const cost = { limit_microcents: 10e8, used_microcents: 4e8, remaining_microcents: 6e8 };
    expect(budgetPace(view({ cost, period: day(20e8, 1e8) }), { tokens: 0, microcents: 0 }, NOW)).toEqual({
      reaches_limit_at: null,
      limit: "period",
      basis: "this_period",
    });
  });
});

describe("projectedDate", () => {
  it("is the dashboard's own projection, shared rather than copied", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync("lib/dashboard-attention.ts", "utf8")).toMatch(/import \{[^}]*\bprojectedDate\b[^}]*\} from "@\/lib\/budget-pace"/);
    expect(projectedDate(5, 10, 5, HOUR, NOW)).toBe(NOW + HOUR);
  });
});
