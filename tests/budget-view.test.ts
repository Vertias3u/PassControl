// What an agent's limits look like from the inside (1.4.0 candidate 2): one helper
// that turns the counters the gate compares into "limit, used, remaining", shared by
// `GET /api/v1/self` and the decision trace, so the two can never disagree. If an
// agent is told it has $0.30 left and is then refused, the number was a lie.
//
// Two rules, both from how the gate counts:
//   * used = spent + reserved. A call in flight holds budget, and the next call is
//     compared against both (lib/state/holds.ts).
//   * an unreadable count is null, never 0. "Unknown" read as "nothing spent" is
//     the most expensive misreading a budget display can make.
import { describe, expect, it } from "vitest";
import { budgetView } from "@/lib/budget-view";

const SNAP = { reservedTokens: 100, spentTokens: 900, reservedMicrocents: 5_000, spentMicrocents: 40_000 };
const NONE = { mode: "none" } as const;
const base = { capTokens: null, capMicrocents: null, snapshot: SNAP, mirror: null, period: NONE, nowMs: Date.UTC(2026, 9, 8, 12) };

describe("budgetView", () => {
  it("reports no limit as null, not as zero remaining", () => {
    expect(budgetView(base)).toEqual({ tokens: null, cost: null, period: null });
  });

  it("counts reserved as used, as the gate does", () => {
    const v = budgetView({ ...base, capTokens: 2_000, capMicrocents: 100_000 });
    expect(v.tokens).toEqual({ limit: 2_000, used: 1_000, remaining: 1_000 });
    expect(v.cost).toEqual({ limit_microcents: 100_000, used_microcents: 45_000, remaining_microcents: 55_000 });
  });

  it("never reports a negative remainder", () => {
    expect(budgetView({ ...base, capTokens: 500 }).tokens).toEqual({ limit: 500, used: 1_000, remaining: 0 });
  });

  it("falls back to the database mirror when the counter is missing, as the trace does", () => {
    const v = budgetView({
      ...base,
      capTokens: 2_000,
      snapshot: { ...SNAP, spentTokens: null },
      mirror: { spentTokens: 300, spentMicrocents: 0 },
    });
    expect(v.tokens?.used).toBe(400);
  });

  it("says unknown when neither the counter nor the mirror can be read", () => {
    const v = budgetView({ ...base, capTokens: 2_000, capMicrocents: 100_000, snapshot: null, mirror: null });
    expect(v.tokens).toEqual({ limit: 2_000, used: null, remaining: null });
    expect(v.cost).toEqual({ limit_microcents: 100_000, used_microcents: null, remaining_microcents: null });
  });

  it("reports a daily limit with what it has counted and when it resets", () => {
    const v = budgetView({ ...base, period: { mode: "set", kind: "day", capMicrocents: 200_000_000, counted: 42_000_000 } });
    expect(v.period).toEqual({
      kind: "day",
      limit_microcents: 200_000_000,
      used_microcents: 42_000_000,
      remaining_microcents: 158_000_000,
      resets_in_seconds: 12 * 3600,
    });
  });

  it("an unreadable period count is null, never zero", () => {
    const v = budgetView({ ...base, period: { mode: "set", kind: "day", capMicrocents: 200_000_000, counted: null } });
    expect(v.period).toMatchObject({ used_microcents: null, remaining_microcents: null });
  });

  it("an unreadable period LIMIT says so rather than claiming there is none", () => {
    expect(budgetView({ ...base, period: { mode: "unknown" } }).period).toEqual({ unknown: true });
  });
});

describe("one helper for both readers", () => {
  // The trace's headroom and the agent's own `remaining` once drifted the way the
  // trace's demo price did (lib/pricing.ts DEMO_MICROCENTS_PER_TOKEN). Both call
  // the one function, and this fails the day either stops.
  it.each(["app/api/v1/self/route.ts", "app/api/control/v1/agents/[id]/trace/decision-trace.ts"])("%s uses budgetView", async (file) => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(file, "utf8")).toMatch(/import \{[^}]*\bbudgetView\b[^}]*\} from "@\/lib\/budget-view"/);
  });
});
