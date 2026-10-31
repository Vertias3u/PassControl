// Injection guard Phase 2: the owner's Clear on the agent page (owner, 2026-10-30).
//
// The taint key is per agent (lib/state/taint.ts), so the TENANT boundary is here: the
// action finds the agent through the caller's own session and its user id, and clears
// nothing for anyone else's agent. Clearing ends the hold now; a NEW hostile block
// taints again, and the blocks that caused it never do (their rows remember them).
import { beforeEach, describe, expect, it, vi } from "vitest";

const AGENT = "11111111-1111-4111-8111-111111111111";
const TENANT = "tenant-a";

const h = vi.hoisted(() => ({
  user: { value: { id: "tenant-a" } as { id: string } | null },
  row: { value: null as Record<string, unknown> | null },
  filters: [] as [string, unknown][],
  clear: vi.fn(async (..._a: unknown[]): Promise<boolean> => true),
  audit: vi.fn(async (..._a: unknown[]) => undefined),
  revalidate: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => h.revalidate(...a) }));
vi.mock("@/lib/audit", () => ({ recordAdminAction: (...a: unknown[]) => h.audit(...a) }));
vi.mock("@/lib/state/taint", () => ({ clearTaint: (...a: unknown[]) => h.clear(...a) }));
vi.mock("@/lib/supabase/server", () => ({
  userClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.user.value } }) },
    from: () => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (column: string, value: unknown) => (h.filters.push([column, value]), chain),
        maybeSingle: async () => ({
          data: h.filters.some(([c, v]) => c === "user_id" && v === "tenant-a") ? h.row.value : null,
          error: null,
        }),
      };
      return chain;
    },
  }),
}));

import { clearInjectionTaint } from "@/app/dashboard/agents/[id]/injection-actions";

beforeEach(() => {
  vi.clearAllMocks();
  h.filters.length = 0;
  h.user.value = { id: TENANT };
  h.row.value = { id: AGENT };
  h.clear.mockResolvedValue(true);
});

describe("clearInjectionTaint", () => {
  it("clears the caller's own agent, audits it, and refreshes the page", async () => {
    expect(await clearInjectionTaint(AGENT)).toEqual({ ok: true, cleared: true });
    expect(h.filters).toContainEqual(["user_id", TENANT]);
    expect(h.filters).toContainEqual(["id", AGENT]);
    expect(h.clear).toHaveBeenCalledWith(AGENT);
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ userId: TENANT, action: "agent.injection_clear", targetType: "agent", targetId: AGENT, metadata: { cleared: true } })
    );
    expect(h.revalidate).toHaveBeenCalledWith(`/dashboard/agents/${AGENT}`);
  });

  it("says when there was nothing to clear", async () => {
    h.clear.mockResolvedValue(false);
    expect(await clearInjectionTaint(AGENT)).toEqual({ ok: true, cleared: false });
  });

  it("clears nothing for an agent that is not the caller's", async () => {
    h.user.value = { id: "tenant-b" };
    expect(await clearInjectionTaint(AGENT)).toEqual({ error: "This agent is unavailable." });
    expect(h.clear).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("refuses without a session, and a malformed id", async () => {
    h.user.value = null;
    expect((await clearInjectionTaint(AGENT)).error).toMatch(/Sign in/);
    h.user.value = { id: TENANT };
    expect(await clearInjectionTaint("not-a-uuid")).toEqual({ error: "This agent is unavailable." });
    expect(h.clear).not.toHaveBeenCalled();
  });

  it("says so when Redis cannot clear it, and audits nothing", async () => {
    h.clear.mockRejectedValue(new Error("redis down"));
    expect((await clearInjectionTaint(AGENT)).error).toMatch(/could not clear/);
    expect(h.audit).not.toHaveBeenCalled();
  });
});
