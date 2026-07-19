import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory Redis stand-in (get/set/del + set-type ops) so we can drive the
// kill switch without a real Redis. vi.hoisted keeps it reachable from the mock.
const { store, sets, redisMock, logFailOpenMock } = vi.hoisted(() => {
  const store = new Map<string, unknown>();
  const sets = new Map<string, Set<string>>();
  const redisMock = {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: unknown) => { store.set(k, v); return "OK"; }),
    del: vi.fn(async (...ks: string[]) => { let n = 0; for (const k of ks) if (store.delete(k)) n++; return n; }),
    smembers: vi.fn(async (k: string) => [...(sets.get(k) ?? [])]),
    sadd: vi.fn(async (k: string, ...m: string[]) => { const s = sets.get(k) ?? new Set(); m.forEach((x) => s.add(x)); sets.set(k, s); return m.length; }),
    srem: vi.fn(async (k: string, ...m: string[]) => { const s = sets.get(k) ?? new Set(); let n = 0; m.forEach((x) => { if (s.delete(x)) n++; }); return n; }),
  };
  return { store, sets, redisMock, logFailOpenMock: vi.fn() };
});
vi.mock("../lib/state/redis", () => ({ redis: () => redisMock }));
vi.mock("../lib/observability", () => ({ logFailOpen: logFailOpenMock }));

import {
  readKillState,
  isBlocked,
  armTenantKill,
  setPlatformKill,
  addToDenylist,
} from "../lib/state/killswitch";

beforeEach(() => {
  store.clear();
  sets.clear();
  vi.clearAllMocks();
  delete process.env.KILL_SWITCH_FAIL_CLOSED; // isolate the opt-in per test
});

describe("kill switch (Redis-backed)", () => {
  // THE regression guard for the cross-tenant bug (commit b7d8d5b). Pre-fix, the
  // switch was one shared global flag, so tenant A engaging it blocked tenant B
  // too. This asserts the opposite — it would FAIL against the old single-flag code.
  it("one tenant's kill switch does NOT block another tenant", async () => {
    await armTenantKill("userA", true); // A engages their own kill
    const a = await readKillState("userA");
    const b = await readKillState("userB");
    expect(isBlocked(a, "agentA")).toBe(true); // A blocked (their own)
    expect(isBlocked(b, "agentB")).toBe(false); // B untouched — the exploit guard
  });

  it("armTenantKill arms then disarms a tenant", async () => {
    await armTenantKill("userA", true);
    expect(isBlocked(await readKillState("userA"), "a")).toBe(true);
    await armTenantKill("userA", false);
    expect(isBlocked(await readKillState("userA"), "a")).toBe(false);
  });

  it("platformKill blocks every tenant (ops-only global flag)", async () => {
    await setPlatformKill(true);
    expect(isBlocked(await readKillState("anyUser"), "anyAgent")).toBe(true);
  });

  it("denylist blocks only the listed agent", async () => {
    await addToDenylist("agent-bad");
    const s = await readKillState("userA");
    expect(isBlocked(s, "agent-bad")).toBe(true);
    expect(isBlocked(s, "agent-ok")).toBe(false);
  });

  it("a clean state blocks nothing", async () => {
    expect(isBlocked(await readKillState("userA"), "agentA")).toBe(false);
  });

  it("fails open by default if Redis read throws (no block-everyone path)", async () => {
    redisMock.get.mockRejectedValueOnce(new Error("redis down"));
    const s = await readKillState("userA");
    expect(s).toEqual({ platformKill: false, userKill: false, denylist: [] });
    expect(isBlocked(s, "anyAgent")).toBe(false);
    expect(logFailOpenMock).toHaveBeenCalledOnce();
    expect(logFailOpenMock).toHaveBeenCalledWith("kill_read");
  });

  // Opt-in: an operator who wants the emergency stop to be strict can make a
  // kill-switch read failure BLOCK rather than pass through.
  it("fails CLOSED when KILL_SWITCH_FAIL_CLOSED=true (block on read failure)", async () => {
    process.env.KILL_SWITCH_FAIL_CLOSED = "true";
    redisMock.get.mockRejectedValueOnce(new Error("redis down"));
    const s = await readKillState("userA");
    expect(isBlocked(s, "anyAgent")).toBe(true); // read failure => blocked
    expect(logFailOpenMock).toHaveBeenCalledOnce();
    expect(logFailOpenMock).toHaveBeenCalledWith("kill_read");
  });
});
