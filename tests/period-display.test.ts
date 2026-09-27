// K1 — the dashboard's wording for a periodic limit. Three states, and none of
// them may read as a confirmed $0.00 when the gateway has no figure.
import { describe, expect, it } from "vitest";
import { periodLimitSummary } from "@/lib/period-display";

const M = 1_000_000; // micro-cents per cent

describe("periodLimitSummary", () => {
  it("states tracked usage against the limit, per period", () => {
    const day = periodLimitSummary("day", 2500, { state: "tracked", usedMicrocents: 320 * M, heldMicrocents: 0, openHolds: 0 });
    expect(day).toMatchObject({ state: "tracked", text: "$3.20 of $25.00 used today (UTC)", countedCents: 320 });
    const month = periodLimitSummary("month", 90000, { state: "tracked", usedMicrocents: 0, heldMicrocents: 0, openHolds: 0 });
    expect(month.text).toBe("$0.00 of $900.00 used this month (UTC)");
  });

  it("keeps a fraction of a cent rather than rounding a partly used limit up to full", () => {
    const s = periodLimitSummary("day", 1, { state: "tracked", usedMicrocents: 750_501, heldMicrocents: 0, openHolds: 0 });
    expect(s.text).toBe("$0.0075 of $0.01 used today (UTC)");
    expect(s.countedCents).toBeCloseTo(0.750501);
  });

  it("names reservations still in flight, which count until they settle", () => {
    const s = periodLimitSummary("day", 2500, { state: "tracked", usedMicrocents: 100 * M, heldMicrocents: 250 * M, openHolds: 2 });
    expect(s.text).toBe("$1.00 of $25.00 used today (UTC), plus $2.50 held by 2 unfinished attempts");
    expect(s.countedCents).toBe(350);
  });

  it("does not print a zero it does not have", () => {
    const notStarted = periodLimitSummary("day", 2500, { state: "not_started", usedMicrocents: 0, heldMicrocents: 0, openHolds: 0 });
    expect(notStarted).toMatchObject({ state: "not_started", countedCents: null });
    expect(notStarted.text).not.toMatch(/\$0\.00 of/);
    const unavailable = periodLimitSummary("month", 2500, null);
    expect(unavailable).toMatchObject({ state: "unavailable", countedCents: null });
    expect(unavailable.text).toMatch(/unavailable/);
  });
});
