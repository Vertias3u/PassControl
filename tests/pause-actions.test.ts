// The soft pause's dashboard control (1.6.0, L4): "Let it go on for an hour" and
// "Keep paused".
//
// The lift key is per agent (lib/state/pause.ts), so the TENANT boundary is here:
// the action finds the agent through the caller's own session and its user id, and
// a lift for anyone else's agent is never written.
import { beforeEach, describe, expect, it, vi } from "vitest";

const AGENT = "11111111-1111-4111-8111-111111111111";
const TENANT = "tenant-a";

const h = vi.hoisted(() => ({
  user: { value: { id: "tenant-a" } as { id: string } | null },
  row: { value: null as Record<string, unknown> | null },
  filters: [] as [string, unknown][],
  lift: vi.fn(async (..._a: unknown[]) => undefined),
  end: vi.fn(async (..._a: unknown[]) => undefined),
  audit: vi.fn(async (..._a: unknown[]) => undefined),
  revalidate: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => h.revalidate(...a) }));
vi.mock("@/lib/audit", () => ({ recordAdminAction: (...a: unknown[]) => h.audit(...a) }));
vi.mock("@/lib/state/pause", () => ({
  liftPause: (...a: unknown[]) => h.lift(...a),
  endPauseLift: (...a: unknown[]) => h.end(...a),
}));
vi.mock("@/lib/supabase/server", () => ({
  userClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.user.value } }) },
    from: () => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (column: string, value: unknown) => (h.filters.push([column, value]), chain),
        // RLS and the explicit filter together: another tenant's agent is no row.
        maybeSingle: async () => ({
          // Every row here is tenant-a's.
          data: h.filters.some(([c, v]) => c === "user_id" && v === "tenant-a") ? h.row.value : null,
          error: null,
        }),
      };
      return chain;
    },
  }),
}));

import { setAgentPauseLift } from "@/app/dashboard/agents/[id]/pause-actions";

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  h.filters.length = 0;
  h.user.value = { id: TENANT };
  h.row.value = { id: AGENT, pause_percent: 80, budget_period: "day" };
});

describe("setAgentPauseLift", () => {
  it("lets the caller's own paused agent go on for an hour, and audits it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-22T12:00:00Z"));
    const r = await setAgentPauseLift(AGENT, true);
    expect(r).toEqual({ ok: true, until: "2026-10-22T13:00:00.000Z" });
    expect(h.lift).toHaveBeenCalledWith(AGENT, 3600);
    expect(h.filters).toContainEqual(["user_id", TENANT]);
    expect(h.filters).toContainEqual(["id", AGENT]);
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ userId: TENANT, action: "agent.pause_lift", targetId: AGENT, metadata: { lifted: true, seconds: 3600 } })
    );
  });

  it("ends a lift at a daily limit's reset, when that is sooner than an hour", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-22T23:30:00Z"));
    await setAgentPauseLift(AGENT, true);
    expect(h.lift).toHaveBeenCalledWith(AGENT, 1800);
  });

  it("never lifts another tenant's agent", async () => {
    h.user.value = { id: "tenant-b" };
    h.row.value = { id: AGENT, pause_percent: 80, budget_period: "day" }; // tenant-a's row
    const r = await setAgentPauseLift(AGENT, true);
    expect(r).toEqual({ error: "This agent is unavailable." });
    expect(h.lift).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("refuses with no session, a malformed id, or an agent with no pause line", async () => {
    h.user.value = null;
    expect((await setAgentPauseLift(AGENT, true)).error).toMatch(/sign in/i);
    h.user.value = { id: TENANT };
    expect((await setAgentPauseLift("not-a-uuid", true)).error).toBe("This agent is unavailable.");
    h.row.value = { id: AGENT, pause_percent: null, budget_period: null };
    expect((await setAgentPauseLift(AGENT, true)).error).toMatch(/no pause line/);
    expect(h.lift).not.toHaveBeenCalled();
  });

  it("Keep paused ends a lift early", async () => {
    const r = await setAgentPauseLift(AGENT, false);
    expect(r).toEqual({ ok: true });
    expect(h.end).toHaveBeenCalledWith(AGENT);
    expect(h.lift).not.toHaveBeenCalled();
  });

  it("says so when the lift cannot be written, rather than claiming it was", async () => {
    h.lift.mockRejectedValueOnce(new Error("redis down"));
    const r = await setAgentPauseLift(AGENT, true);
    expect(r.error).toMatch(/could not/i);
    expect(h.audit).not.toHaveBeenCalled();
  });
});
