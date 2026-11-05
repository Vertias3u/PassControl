// Cloud review 2026-11-03, A5: deleteAccount arms the tenant kill before erasing,
// and on a database failure it disarmed it to undo that. It never asked whether the
// kill was ALREADY armed. An operator who had hit the master kill (an agent leaking,
// say) and then tried to delete the account, with the RPC failing, found their
// emergency stop lifted by a button that only claimed to delete. A failed erasure
// now puts the kill back exactly as it found it, and leaves it armed when it cannot tell.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  observed: { platform: false as boolean | null, tenant: false as boolean | null },
  rpcError: null as { message: string } | null,
  arm: vi.fn(async (_userId: string, _on: boolean) => undefined),
}));

vi.mock("@/lib/mfa", () => ({ mfaAuthorizedUser: async () => ({ ok: true, user: { id: "user-1" } }) }));
vi.mock("@/lib/supabase/server", () => ({ userClient: async () => ({}) }));
vi.mock("@/lib/state/killswitch", () => ({
  armTenantKill: h.arm,
  observeKillState: async () => h.observed,
}));
vi.mock("@/lib/state/redis", () => ({ redis: () => ({}) }));
vi.mock("@/lib/account-lifecycle", () => ({ purgeAccountRuntimeState: async () => undefined }));
vi.mock("@/lib/observability", () => ({ captureError: async () => undefined }));
vi.mock("@/lib/supabase", () => ({
  serviceClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
    rpc: async () => ({ data: null, error: h.rpcError }),
  }),
}));

import { deleteAccount } from "@/app/dashboard/settings/account-actions";

beforeEach(() => {
  h.arm.mockClear();
  h.observed = { platform: false, tenant: false };
  h.rpcError = { message: "connection reset" };
});

const disarmed = () => h.arm.mock.calls.some(([, on]) => on === false);

describe("a failed account erasure leaves the kill switch as it found it (A5)", () => {
  it("leaves an already-armed master kill armed", async () => {
    h.observed = { platform: false, tenant: true };
    const res = await deleteAccount("DELETE MY ACCOUNT");
    expect(res).toMatchObject({ ok: false });
    expect(disarmed(), "the erasure lifted an emergency stop it did not arm").toBe(false);
  });

  it("leaves it armed when it could not tell whether it was armed", async () => {
    h.observed = { platform: false, tenant: null };
    await deleteAccount("DELETE MY ACCOUNT");
    expect(disarmed()).toBe(false);
  });

  it("still lifts the stop it armed itself when the kill was clear", async () => {
    await deleteAccount("DELETE MY ACCOUNT");
    expect(h.arm.mock.calls).toEqual([
      ["user-1", true],
      ["user-1", false],
    ]);
  });

  it("still arms before erasing, whatever it observed", async () => {
    h.observed = { platform: false, tenant: true };
    await deleteAccount("DELETE MY ACCOUNT");
    expect(h.arm.mock.calls[0]).toEqual(["user-1", true]);
  });
});
