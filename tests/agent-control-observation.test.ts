import { beforeEach, describe, expect, it, vi } from "vitest";

// v1 playbook Session 05 / Contract C: a stop control reports what it asked
// for and what it then OBSERVED — database status and the Redis suspension
// flag the gateway reads — never an assumption. A transport or partial failure
// is "could not confirm", not "nothing changed". Both actions stay on
// requireUser(): a stop must never need a step-up (credential-action-mfa).

const AGENT = "11111111-1111-4111-8111-111111111111";

const mocks = vi.hoisted(() => {
  const agentRow = { data: { status: "suspended" } as { status: string } | null, error: null as null | { code: string } };
  const agentQuery = {
    select: vi.fn(() => agentQuery),
    eq: vi.fn(() => agentQuery),
    maybeSingle: vi.fn(async () => ({ data: agentRow.data, error: agentRow.error })),
  };
  return {
    agentRow,
    agentQuery,
    db: {
      auth: { getUser: vi.fn(async () => ({ data: { user: { id: "tenant-a" } } })) },
      from: vi.fn((table: string) => {
        if (table !== "agents") throw new Error(`unexpected table ${table}`);
        return agentQuery;
      }),
    },
    fleetSetAgentSuspended: vi.fn(async () => ({ ok: true as const, value: { id: AGENT } })),
    setTenantKill: vi.fn(async () => undefined),
    observeKillState: vi.fn(async (): Promise<{ platform: boolean | null; tenant: boolean | null }> => ({ platform: false, tenant: true })),
    readSuspensionFlag: vi.fn(async (): Promise<boolean | null> => true),
    recordAdminAction: vi.fn(async () => undefined),
    mfaAuthorizedUser: vi.fn(),
  };
});

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock("@/lib/supabase/server", () => ({ userClient: async () => mocks.db }));
vi.mock("@/lib/supabase", () => ({ serviceClient: vi.fn(() => ({})) }));
vi.mock("@/lib/mfa", () => ({ mfaAuthorizedUser: mocks.mfaAuthorizedUser }));
vi.mock("@/lib/fleet", () => ({ setAgentSuspended: mocks.fleetSetAgentSuspended, setTenantKill: mocks.setTenantKill }));
vi.mock("@/lib/state/killswitch", () => ({ observeKillState: mocks.observeKillState }));
vi.mock("@/lib/state/redis", () => ({
  readSuspensionFlag: mocks.readSuspensionFlag,
  purgeAgentCaches: vi.fn(),
  purgeAgentFallbacks: vi.fn(),
  purgeProviderKeysCache: vi.fn(),
  stashKeyImport: vi.fn(),
  takeKeyImport: vi.fn(),
}));
vi.mock("@/lib/audit", () => ({ recordAdminAction: mocks.recordAdminAction }));
vi.mock("@/lib/seclog", () => ({ logSecurityEvent: vi.fn() }));
vi.mock("@/lib/alert", () => ({ dispatchSecurityAlert: vi.fn() }));
vi.mock("@/lib/apikeys", () => ({ generateApiKey: vi.fn() }));

import { observeAgentControl, observeMasterKill, setAgentSuspended, setMasterKill } from "@/app/dashboard/actions";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.agentRow.data = { status: "suspended" };
  mocks.agentRow.error = null;
  mocks.readSuspensionFlag.mockResolvedValue(true);
  mocks.fleetSetAgentSuspended.mockResolvedValue({ ok: true, value: { id: AGENT } });
  mocks.setTenantKill.mockResolvedValue(undefined);
  mocks.observeKillState.mockResolvedValue({ platform: false, tenant: true });
});

describe("setAgentSuspended reports what it observed", () => {
  it("confirms a suspension only when both the database and the gateway flag show it", async () => {
    const result = await setAgentSuspended(AGENT, true);
    expect(mocks.fleetSetAgentSuspended).toHaveBeenCalledWith(expect.anything(), "tenant-a", AGENT, true);
    expect(result).toEqual({
      agentId: AGENT,
      requested: "suspended",
      database: "suspended",
      suspensionFlag: true,
      confirmed: true,
    });
  });

  it("does not claim recovery when the database resumed but the gateway flag is still set", async () => {
    // fleet persists `active` first, then deletes the Redis flag; the delete failed.
    mocks.fleetSetAgentSuspended.mockRejectedValueOnce(new Error("redis unavailable"));
    mocks.agentRow.data = { status: "active" };
    mocks.readSuspensionFlag.mockResolvedValue(true);
    const result = await setAgentSuspended(AGENT, false);
    expect(result).toMatchObject({ requested: "active", database: "active", suspensionFlag: true, confirmed: false });
    // No audit row for an operation that did not finish.
    expect(mocks.recordAdminAction).not.toHaveBeenCalled();
  });

  it("converges when the same intent is retried", async () => {
    mocks.fleetSetAgentSuspended.mockRejectedValueOnce(new Error("redis unavailable"));
    mocks.agentRow.data = { status: "active" };
    mocks.readSuspensionFlag.mockResolvedValueOnce(true);
    expect((await setAgentSuspended(AGENT, false)).confirmed).toBe(false);
    mocks.readSuspensionFlag.mockResolvedValueOnce(false);
    const retried = await setAgentSuspended(AGENT, false);
    expect(mocks.fleetSetAgentSuspended).toHaveBeenLastCalledWith(expect.anything(), "tenant-a", AGENT, false);
    expect(retried.confirmed).toBe(true);
  });

  it("reports an unreadable layer as unknown, never as the requested state", async () => {
    mocks.readSuspensionFlag.mockResolvedValue(null);
    const result = await setAgentSuspended(AGENT, true);
    expect(result).toMatchObject({ suspensionFlag: null, confirmed: false });
    mocks.readSuspensionFlag.mockResolvedValue(true);
    mocks.agentRow.data = null;
    mocks.agentRow.error = { code: "57014" };
    expect(await setAgentSuspended(AGENT, true)).toMatchObject({ database: null, confirmed: false });
  });

  it("still refuses an agent the caller does not own", async () => {
    mocks.fleetSetAgentSuspended.mockResolvedValueOnce({ ok: false, status: 404, code: "not_found" } as never);
    await expect(setAgentSuspended(AGENT, true)).rejects.toThrow("not_authorized");
  });

  it("never needs a step-up", async () => {
    await setAgentSuspended(AGENT, true);
    await observeAgentControl(AGENT, "suspended");
    expect(mocks.mfaAuthorizedUser).not.toHaveBeenCalled();
  });
});

describe("observeAgentControl reads without changing anything", () => {
  it("reports both layers against the intent it is asked about", async () => {
    mocks.agentRow.data = { status: "active" };
    mocks.readSuspensionFlag.mockResolvedValue(false);
    expect(await observeAgentControl(AGENT, "active")).toMatchObject({ database: "active", suspensionFlag: false, confirmed: true });
    expect(mocks.fleetSetAgentSuspended).not.toHaveBeenCalled();
  });

  it("checks ownership through the tenant's own read before touching Redis", async () => {
    mocks.agentRow.data = null;
    await expect(observeAgentControl(AGENT, "suspended")).rejects.toThrow("not_authorized");
    expect(mocks.readSuspensionFlag).not.toHaveBeenCalled();
  });

  it("rejects a malformed agent id before any read", async () => {
    await expect(observeAgentControl("not-a-uuid", "active")).rejects.toThrow();
    expect(mocks.db.from).not.toHaveBeenCalled();
  });
});

describe("the fleet kill switch reports what it observed", () => {
  it("confirms arming only when the tenant flag reads armed", async () => {
    expect(await setMasterKill(true)).toEqual({ requested: true, tenant: true, platform: false, confirmed: true });
    expect(mocks.recordAdminAction).toHaveBeenCalledOnce();
  });

  it("reports a failed write through the readback, without an audit row", async () => {
    mocks.setTenantKill.mockRejectedValueOnce(new Error("redis unavailable"));
    mocks.observeKillState.mockResolvedValueOnce({ platform: null, tenant: null });
    expect(await setMasterKill(true)).toEqual({ requested: true, tenant: null, platform: null, confirmed: false });
    expect(mocks.recordAdminAction).not.toHaveBeenCalled();
  });

  it("does not confirm a disarm the flag does not show", async () => {
    mocks.observeKillState.mockResolvedValueOnce({ platform: false, tenant: true });
    expect((await setMasterKill(false)).confirmed).toBe(false);
  });

  it("re-reads without writing, and never needs a step-up", async () => {
    expect(await observeMasterKill(true)).toMatchObject({ tenant: true, confirmed: true });
    expect(mocks.setTenantKill).not.toHaveBeenCalled();
    expect(mocks.mfaAuthorizedUser).not.toHaveBeenCalled();
  });
});
