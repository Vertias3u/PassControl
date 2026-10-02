// The per-service kill switch (any-API phase 2, slice C): "stop all GitHub
// access, keep Claude".
//
// It is a kill switch, so it sits in invariant 3's kill column: read in the
// SAME Redis round trip as the tenant and platform kills, failing open by
// default and closed under KILL_SWITCH_FAIL_CLOSED (Cloud) — never a third
// posture. And it is per service and per tenant: arming GitHub for one tenant
// stops neither that tenant's model calls nor anyone else's GitHub calls.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { store, redisMock, failing } = vi.hoisted(() => {
  const store = new Map<string, unknown>();
  const failing = { on: false };
  const guard = <T>(fn: () => T) => (failing.on ? Promise.reject(new Error("redis down")) : Promise.resolve(fn()));
  const redisMock = {
    get: vi.fn((k: string) => guard(() => store.get(k) ?? null)),
    set: vi.fn((k: string, v: unknown, opts?: unknown) => guard(() => { store.set(k, v); return opts === undefined ? "OK" : "OK"; })),
    del: vi.fn((k: string) => guard(() => (store.delete(k) ? 1 : 0))),
    smembers: vi.fn(() => guard(() => [] as string[])),
  };
  return { store, redisMock, failing };
});
vi.mock("../lib/state/redis", () => ({ redis: () => redisMock }));
vi.mock("../lib/observability", () => ({ logFailOpen: vi.fn() }));

import {
  armServiceKill,
  blockedReason,
  isBlocked,
  observeServiceKill,
  readKillState,
} from "../lib/state/killswitch";

beforeEach(() => {
  store.clear();
  failing.on = false;
  vi.clearAllMocks();
  delete process.env.KILL_SWITCH_FAIL_CLOSED;
});

describe("the per-service kill switch", () => {
  it("is read with the other kills when a service is named, and only then", async () => {
    await armServiceKill("userA", "github", true);
    expect((await readKillState("userA", { service: "github" })).serviceKill).toBe(true);
    // The model route names no service, so it never sees this flag.
    const llm = await readKillState("userA");
    expect(llm.serviceKill ?? false).toBe(false);
    expect(redisMock.get).not.toHaveBeenCalledWith("killswitch:tenant:userA:svc:github", expect.anything());
  });

  it("stops that service for that tenant only", async () => {
    await armServiceKill("userA", "github", true);
    expect((await readKillState("userB", { service: "github" })).serviceKill).toBe(false);
  });

  it("never blocks a model call: isBlocked and blockedReason ignore it", async () => {
    await armServiceKill("userA", "github", true);
    const state = await readKillState("userA", { service: "github" });
    expect(isBlocked(state, "agent")).toBe(false);
    expect(blockedReason(state, "agent", false)).toBeNull();
  });

  it("arms permanently and disarms with a delete", async () => {
    await armServiceKill("userA", "github", true);
    expect(redisMock.set).toHaveBeenCalledWith("killswitch:tenant:userA:svc:github", "1");
    await armServiceKill("userA", "github", false);
    expect(redisMock.del).toHaveBeenCalledWith("killswitch:tenant:userA:svc:github");
    expect((await readKillState("userA", { service: "github" })).serviceKill).toBe(false);
  });

  it("fails OPEN by default when Redis is unreadable, like the other kills", async () => {
    failing.on = true;
    const state = await readKillState("userA", { service: "github" });
    expect(state.serviceKill).toBe(false);
    expect(state.platformKill).toBe(false);
  });

  it("fails CLOSED under KILL_SWITCH_FAIL_CLOSED, like the other kills", async () => {
    process.env.KILL_SWITCH_FAIL_CLOSED = "true";
    failing.on = true;
    const state = await readKillState("userA", { service: "github" });
    // The configured posture blocks everything, the service included.
    expect(isBlocked(state, "agent") || state.serviceKill === true).toBe(true);
  });

  it("observes as null when unreadable, never as armed or clear", async () => {
    await armServiceKill("userA", "github", true);
    expect(await observeServiceKill("userA", "github")).toBe(true);
    failing.on = true;
    expect(await observeServiceKill("userA", "github")).toBeNull();
  });
});
