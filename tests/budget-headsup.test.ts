// The heads-up before a limit (1.6.0, L8): one alert, a few hours before an agent
// reaches its daily or monthly limit (or the pause line drawn on it), at the rate it
// has spent this period. Sent once a period; after a pause or a switch it has
// nothing new to say.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/state/budget-notice", () => ({}));
vi.mock("@/lib/budget-view", () => ({}));
vi.mock("@/lib/alerts/workspace", () => ({}));

import { HEADSUP_WINDOW_MS, headsUp, noteHeadsUp } from "@/lib/budget-headsup";

const USD = 100_000_000;
// 12:00 UTC: half the day gone.
const NOW = Date.UTC(2026, 9, 22, 12, 0);

describe("headsUp", () => {
  const day = (used: number, over: Record<string, unknown> = {}) =>
    headsUp({ kind: "day", capMicrocents: 20 * USD, usedMicrocents: used, nowMs: NOW, pausePercent: null, switchModel: null, ...over });

  it("is said when the limit is reached within the window at this period's rate", () => {
    // $16 in 12 h is $1.33/h: $20 is reached at 15:00, three hours on.
    const h = day(16 * USD);
    expect(h).toEqual({ target: "limit", atMs: Date.UTC(2026, 9, 22, 15, 0), targetMicrocents: 20 * USD });
    expect(h!.atMs - NOW).toBeLessThanOrEqual(HEADSUP_WINDOW_MS);
  });

  it("is not said when the limit is further off than the window, or past the reset", () => {
    expect(day(10 * USD)).toBeNull(); // reached at 24:00, twelve hours on
    expect(day(0)).toBeNull();
  });

  it("is not said once the limit is reached: the refusal says that", () => {
    expect(day(20 * USD)).toBeNull();
  });

  it("is not said in a period too young to call a rate", () => {
    expect(headsUp({ kind: "day", capMicrocents: 20 * USD, usedMicrocents: 19 * USD, nowMs: Date.UTC(2026, 9, 22, 0, 5), pausePercent: null, switchModel: null })).toBeNull();
  });

  it("aims at the pause line when one is set, and names the switch when there is one", () => {
    // An 80% line on $20 is $16: at $13 by 12:00 it is reached at 14:46.
    const pause = day(13 * USD, { pausePercent: 80 });
    expect(pause).toMatchObject({ target: "pause", targetMicrocents: 16 * USD });
    expect(pause!.atMs).toBeGreaterThan(NOW);
    expect(day(13 * USD, { pausePercent: 80, switchModel: "gpt-5-mini" })).toMatchObject({ target: "switch", switchModel: "gpt-5-mini" });
    // Already past the line: the pause (or the switch) says it, not a heads-up.
    expect(day(17 * USD, { pausePercent: 80 })).toBeNull();
  });
});

describe("noteHeadsUp", () => {
  const deps = (over: Record<string, unknown> = {}) => ({
    sent: vi.fn(async () => false),
    claim: vi.fn(async () => true),
    readCounted: vi.fn(async () => 16 * USD),
    notify: vi.fn(async () => undefined),
    ...over,
  });
  const input = { userId: "u", agentId: "a", kind: "day" as const, capMicrocents: 20 * USD, pausePercent: null, switchModel: null, origin: "https://pc.test", nowMs: NOW };

  it("sends one alert with the time and the amounts", async () => {
    const d = deps();
    expect(await noteHeadsUp({ ...input, ...d })).toBe(true);
    expect(d.claim).toHaveBeenCalledWith("a", "headsup", "day", NOW);
    expect(d.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u",
        agentId: "a",
        type: "budget",
        status: "budget_headsup",
        headsUp: { target: "limit", at: new Date(Date.UTC(2026, 9, 22, 15, 0)).toISOString(), period: "day", spentMicrocents: 16 * USD, targetMicrocents: 20 * USD },
      })
    );
  });

  it("reads nothing more once this period's heads-up is spent: the usage read can reach Postgres", async () => {
    const d = deps({ sent: vi.fn(async () => true) });
    expect(await noteHeadsUp({ ...input, ...d })).toBe(false);
    expect(d.readCounted).not.toHaveBeenCalled();
    expect(d.notify).not.toHaveBeenCalled();
  });

  it("sends nothing when another call claimed it first, or the usage cannot be read, or it is not near", async () => {
    for (const over of [{ claim: vi.fn(async () => false) }, { readCounted: vi.fn(async () => null) }, { readCounted: vi.fn(async () => 2 * USD) }]) {
      const d = deps(over);
      expect(await noteHeadsUp({ ...input, ...d })).toBe(false);
      expect(d.notify).not.toHaveBeenCalled();
    }
  });

  it("never throws: it runs after the call was answered", async () => {
    const d = deps({ sent: vi.fn(async () => { throw new Error("redis down"); }) });
    expect(await noteHeadsUp({ ...input, ...d })).toBe(false);
  });
});
