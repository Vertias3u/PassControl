// The once-per-period budget notices (1.6.0, L7 and L8): one key per agent, notice
// and period, expiring when the period ends, so a notice is sent at most once in a
// period and comes back on its own in the next.
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, { v: string; ex: number }>();
vi.mock("@/lib/state/redis", () => ({
  redis: () => ({
    set: vi.fn(async (k: string, v: string, o: { ex: number; nx?: boolean }) => {
      if (o.nx && store.has(k)) return null;
      store.set(k, { v, ex: o.ex });
      return "OK";
    }),
  }),
}));

import { claimBudgetNotice, markBudgetNotice } from "@/lib/state/budget-notice";

const NOW = Date.UTC(2026, 9, 22, 21, 0);

describe("budget notices", () => {
  beforeEach(() => store.clear());

  it("is claimed once a day for a daily limit, and expires at midnight UTC", async () => {
    expect(await claimBudgetNotice("a1", "switched", "day", NOW)).toBe(true);
    expect(await claimBudgetNotice("a1", "switched", "day", NOW + 60_000)).toBe(false);
    expect([...store.keys()]).toEqual(["budget_notice:switched:a1:d:2026-10-22"]);
    expect(store.get("budget_notice:switched:a1:d:2026-10-22")!.ex).toBe(3 * 3600);
    expect(await claimBudgetNotice("a1", "switched", "day", Date.UTC(2026, 9, 23, 0, 1))).toBe(true);
  });

  it("is per agent and per notice, and a month is keyed by its month", async () => {
    expect(await claimBudgetNotice("a1", "switched", "month", NOW)).toBe(true);
    expect(await claimBudgetNotice("a2", "switched", "month", NOW)).toBe(true);
    expect(await claimBudgetNotice("a1", "headsup", "month", NOW)).toBe(true);
    expect(store.has("budget_notice:switched:a1:m:2026-10")).toBe(true);
  });

  it("a lifetime limit has one window, held for thirty days", async () => {
    expect(await claimBudgetNotice("a1", "headsup", null, NOW)).toBe(true);
    expect(store.get("budget_notice:headsup:a1:life")!.ex).toBe(30 * 86400);
  });

  it("marking a notice spends its slot, so a later claim in the period is refused", async () => {
    await markBudgetNotice("a1", "headsup", "day", NOW);
    expect(await claimBudgetNotice("a1", "headsup", "day", NOW)).toBe(false);
  });
});
