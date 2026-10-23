// The soft pause (1.6.0, L4): an agent stops at N % of its budget until the owner
// lets it go on, well before the hard limit refuses it.
//
// `pauseLine` decides from the same BudgetView `/self` shows, so the refusal and the
// status line quote the same figure. The rules:
//   * any limit past the line pauses, and the refusal names that one;
//   * a usage that cannot be read never pauses: the hard limit still decides, and it
//     fails closed on its own state, so the pause does not need to;
//   * the line is "at or past", so 80 % of $20 pauses at exactly $16.
import { describe, expect, it } from "vitest";
import { liftSeconds, pauseLine, pauseMessage } from "@/lib/budget-pause";
import type { BudgetView } from "@/lib/budget-view";

const USD = 100_000_000; // micro-cents per dollar
const NOW = Date.UTC(2026, 9, 22, 12);
const day = (limit: number, used: number | null): BudgetView["period"] => ({
  kind: "day",
  limit_microcents: limit,
  used_microcents: used,
  remaining_microcents: used === null ? null : Math.max(0, limit - used),
  resets_in_seconds: 12 * 3600,
});
const view = (over: Partial<BudgetView> = {}): BudgetView => ({ tokens: null, cost: null, period: null, ...over });

describe("pauseLine", () => {
  it("lets an agent below the line through", () => {
    expect(pauseLine(view({ period: day(20 * USD, 15.99 * USD) }), 80)).toBeNull();
  });

  it("pauses at the line, not only past it", () => {
    expect(pauseLine(view({ period: day(20 * USD, 16 * USD) }), 80)).toEqual({
      limit: "period",
      period: "day",
      percent: 80,
      usedPercent: 80,
      used: 16 * USD,
      cap: 20 * USD,
    });
  });

  it("never pauses on a usage it cannot read", () => {
    expect(pauseLine(view({ period: day(20 * USD, null) }), 80)).toBeNull();
    expect(pauseLine(view({ period: { unknown: true } }), 80)).toBeNull();
    expect(pauseLine(view({ cost: { limit_microcents: 10 * USD, used_microcents: null, remaining_microcents: null } }), 50)).toBeNull();
    expect(pauseLine(view(), 50)).toBeNull();
  });

  it("leaves a zero limit to the hard budget, which already refuses everything", () => {
    expect(pauseLine(view({ period: day(0, 0) }), 80)).toBeNull();
  });

  it("pauses on whichever limit is past the line, and names it", () => {
    const cost = { limit_microcents: 10 * USD, used_microcents: 9 * USD, remaining_microcents: 1 * USD };
    expect(pauseLine(view({ cost, period: day(20 * USD, 1 * USD) }), 80)).toMatchObject({ limit: "cost", usedPercent: 90 });
    const tokens = { limit: 1_000_000, used: 850_000, remaining: 150_000 };
    expect(pauseLine(view({ tokens }), 80)).toMatchObject({ limit: "tokens", usedPercent: 85 });
  });
});

describe("pauseMessage", () => {
  it("says what was reached, the line, and that the limit itself still applies", () => {
    const line = pauseLine(view({ period: day(20 * USD, 1_640_000_000) }), 80)!;
    expect(pauseMessage(line)).toBe(
      "PassControl paused this agent: today's spend is 82% of its limit ($16.40 of $20.00), past the 80% pause line. " +
        "Its owner can let it go on for an hour from the agent's page in the dashboard; the limit itself still applies."
    );
  });

  it("names a monthly, a total and a token limit for what they are", () => {
    const month: BudgetView["period"] = { ...(day(20 * USD, 18 * USD) as object), kind: "month" } as BudgetView["period"];
    expect(pauseMessage(pauseLine(view({ period: month }), 80)!)).toMatch(/^PassControl paused this agent: this month's spend is 90% of its limit \(\$18\.00 of \$20\.00\)/);
    const cost = { limit_microcents: 10 * USD, used_microcents: 9 * USD, remaining_microcents: USD };
    expect(pauseMessage(pauseLine(view({ cost }), 80)!)).toMatch(/: its total spend is 90% of its budget \(\$9\.00 of \$10\.00\)/);
    const tokens = { limit: 1_000_000, used: 850_000, remaining: 150_000 };
    expect(pauseMessage(pauseLine(view({ tokens }), 80)!)).toMatch(/: its token use is 85% of its limit \(850,000 of 1,000,000 tokens\)/);
  });
});

describe("liftSeconds", () => {
  it("is an hour, or less when the period resets sooner: a new period starts below the line anyway", () => {
    expect(liftSeconds("day", NOW)).toBe(3600);
    expect(liftSeconds("day", Date.UTC(2026, 9, 22, 23, 30))).toBe(1800);
    expect(liftSeconds(null, Date.UTC(2026, 9, 22, 23, 30))).toBe(3600);
  });
});
