// Arming the per-service kill from the dashboard. A stop, so it needs only a
// signed-in operator, never a step-up (every credential keeps a stop reachable
// without one, as the master kill does). Every arm and disarm is audited and
// alerted, and the answer is what Redis OBSERVED afterwards, not what was asked.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  getUser: vi.fn(),
  arm: vi.fn(),
  observe: vi.fn(),
  audit: vi.fn(),
  alert: vi.fn(),
  seclog: vi.fn(),
  gate: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ userClient: async () => ({ auth: { getUser: h.getUser } }) }));
vi.mock("@/lib/mfa", () => ({ mfaAuthorizedUser: (...a: unknown[]) => h.gate(...a) }));
vi.mock("@/lib/audit", () => ({ recordAdminAction: (...a: unknown[]) => h.audit(...a) }));
vi.mock("@/lib/alert", () => ({ dispatchSecurityAlert: (...a: unknown[]) => h.alert(...a) }));
vi.mock("@/lib/seclog", () => ({ logSecurityEvent: (...a: unknown[]) => h.seclog(...a) }));
vi.mock("@/lib/supabase", () => ({ serviceClient: () => ({}) }));
vi.mock("@/lib/state/killswitch", () => ({
  armServiceKill: (...a: unknown[]) => h.arm(...a),
  observeServiceKill: (...a: unknown[]) => h.observe(...a),
}));

import { observeServiceKillAction, setServiceKill } from "@/app/dashboard/service-actions";

beforeEach(() => {
  vi.clearAllMocks();
  h.getUser.mockResolvedValue({ data: { user: { id: "tenant-a" } } });
  h.arm.mockResolvedValue(undefined);
  h.observe.mockResolvedValue(true);
  h.gate.mockResolvedValue({ ok: false, reason: "step_up_required" });
});

describe("setServiceKill", () => {
  it("arms this tenant's stop for the service, audits and alerts, and reports what it observed", async () => {
    const result = await setServiceKill("github", true);
    expect(h.arm).toHaveBeenCalledWith("tenant-a", "github", true);
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "tenant-a", action: "killswitch.service", metadata: { service: "github", on: true } })
    );
    expect(h.alert).toHaveBeenCalled();
    expect(result).toEqual({ requested: true, armed: true, confirmed: true });
  });

  it("needs no two-factor step-up: a stop is always reachable", async () => {
    await setServiceKill("github", true);
    expect(h.gate).not.toHaveBeenCalled();
    expect(h.arm).toHaveBeenCalled();
  });

  it("says it could not confirm when the read-back fails or disagrees", async () => {
    h.observe.mockResolvedValue(null);
    expect(await setServiceKill("github", true)).toEqual({ requested: true, armed: null, confirmed: false });
    h.observe.mockResolvedValue(false);
    expect(await setServiceKill("github", true)).toMatchObject({ confirmed: false });
  });

  it("reports a failed write through the read-back, and audits nothing it did not do", async () => {
    h.arm.mockRejectedValue(new Error("redis down"));
    h.observe.mockResolvedValue(null);
    const result = await setServiceKill("github", true);
    expect(result).toMatchObject({ confirmed: false });
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("refuses an unknown service and a signed-out caller, touching nothing", async () => {
    expect(await setServiceKill("slack", true)).toHaveProperty("error");
    h.getUser.mockResolvedValue({ data: { user: null } });
    expect(await setServiceKill("github", true)).toHaveProperty("error");
    expect(h.arm).not.toHaveBeenCalled();
  });

  it("re-checks without changing anything", async () => {
    h.observe.mockResolvedValue(false);
    expect(await observeServiceKillAction("github", false)).toEqual({ requested: false, armed: false, confirmed: true });
    expect(h.arm).not.toHaveBeenCalled();
  });
});
