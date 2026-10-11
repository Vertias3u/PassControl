import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The kill switches survive losing Redis (0083, owner's option 1, 2026-10-10).
 *
 * Before this, a tenant's master kill, its per-service kills and its session
 * stops were Redis keys and nothing else: a lost Redis lifted them, silently,
 * and the next call went through (proved live). Now Postgres holds the record
 * and Redis the copy. A per-tenant "loaded" marker rides in the kill read; when
 * it is missing (Redis lost, or a tenant never loaded since this shipped), the
 * gateway reloads that tenant's stops from the record, writes them back, and
 * decides THIS call from what it loaded: the first call after a loss is the one
 * that used to get through.
 */
const { store, sets, redisMock, logFailOpenMock, record } = vi.hoisted(() => {
  const store = new Map<string, unknown>();
  const sets = new Map<string, Set<string>>();
  const redisMock = {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    mget: vi.fn(async (...ks: string[]) => ks.map((k) => store.get(k) ?? null)),
    set: vi.fn(async (k: string, v: unknown) => {
      store.set(k, v);
      return "OK";
    }),
    del: vi.fn(async (...ks: string[]) => {
      let n = 0;
      for (const k of ks) if (store.delete(k)) n++;
      return n;
    }),
    smembers: vi.fn(async (k: string) => [...(sets.get(k) ?? [])]),
  };
  const record = {
    rows: [] as Array<Record<string, string>>,
    loadKillRecords: vi.fn(),
    saveKillRecord: vi.fn(),
    deleteKillRecord: vi.fn(),
  };
  return { store, sets, redisMock, logFailOpenMock: vi.fn(), record };
});
vi.mock("../lib/state/redis", () => ({ redis: () => redisMock }));
vi.mock("../lib/observability", () => ({ logFailOpen: logFailOpenMock }));
vi.mock("../lib/state/kill-record", () => ({
  loadKillRecords: record.loadKillRecords,
  saveKillRecord: record.saveKillRecord,
  deleteKillRecord: record.deleteKillRecord,
}));

import {
  readKillState,
  isBlocked,
  observeKillState,
  observeServiceKill,
  ensureKillRecordLoaded,
  withRecordedSessionStop,
  setTenantKillDurably,
  setServiceKillDurably,
  armTenantKill,
  armServiceKill,
} from "../lib/state/killswitch";
import { sessionStopKey } from "../lib/state/kill-keys";

const U = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";
const LOADED = (u: string) => `killswitch:loaded:${u}`;

beforeEach(() => {
  store.clear();
  sets.clear();
  vi.clearAllMocks();
  delete process.env.KILL_SWITCH_FAIL_CLOSED;
  record.rows = [];
  record.loadKillRecords.mockImplementation(async (userId: string) =>
    userId === U ? record.rows : []
  );
  record.saveKillRecord.mockResolvedValue(true);
  record.deleteKillRecord.mockResolvedValue(true);
});

describe("after Redis loses its data, every recorded stop still holds", () => {
  it("the tenant's master kill refuses the very first call", async () => {
    record.rows = [{ kind: "tenant" }] as never;
    const state = await readKillState(U);
    expect(isBlocked(state, AGENT)).toBe(true);
    // Written back, so the next call reads it from Redis like before.
    expect(store.get(`killswitch:tenant:${U}`)).toBeTruthy();
    expect(store.get(LOADED(U))).toBeTruthy();
  });

  it("a per-service kill refuses the first call to that service, and only that service", async () => {
    record.rows = [{ kind: "service", service: "github" }] as never;
    expect((await readKillState(U, { service: "github" })).serviceKill).toBe(true);
    expect(store.get(`killswitch:tenant:${U}:svc:github`)).toBeTruthy();
    expect((await readKillState(U, { service: "notion" })).serviceKill).toBe(false);
  });

  it("a stopped session refuses the first call, even though the suspend read ran before the reload", async () => {
    record.rows = [{ kind: "session", agentId: AGENT, sessionId: "claude-code:s1" }] as never;
    const state = await readKillState(U);
    // The proxy reads suspension in parallel with the kill state; that read saw
    // an empty Redis and said "not stopped". The reload must overrule it.
    expect(withRecordedSessionStop(false, state, AGENT, "claude-code:s1")).toBe("session");
    expect(store.get(sessionStopKey(AGENT, "claude-code:s1"))).toBeTruthy();
    // Another session of the same agent, and a call with no session, run on.
    expect(withRecordedSessionStop(false, state, AGENT, "claude-code:s2")).toBe(false);
    expect(withRecordedSessionStop(false, state, AGENT, null)).toBe(false);
    // A suspended agent stays suspended: the reload never weakens a read.
    expect(withRecordedSessionStop(true, state, AGENT, "claude-code:s1")).toBe(true);
  });

  it("the operator's screen shows what the gateway will enforce, not the empty Redis", async () => {
    record.rows = [{ kind: "tenant" }, { kind: "service", service: "github" }] as never;
    expect((await observeKillState(U)).tenant).toBe(true);
    store.clear();
    expect(await observeServiceKill(U, "github")).toBe(true);
  });

  it("the sessions panel can load the record before it reads its stops", async () => {
    record.rows = [{ kind: "session", agentId: AGENT, sessionId: "s1" }] as never;
    expect(await ensureKillRecordLoaded(U)).toBe(true);
    expect(store.get(sessionStopKey(AGENT, "s1"))).toBeTruthy();
  });
});

describe("the reload's limits", () => {
  it("only ever ADDS stops: a stop in Redis with no record row is left armed", async () => {
    // A stop armed before 0083 has no row. A reload must not lift it.
    store.set(`killswitch:tenant:${U}`, 1);
    const state = await readKillState(U);
    expect(state.userKill).toBe(true);
    expect(store.get(`killswitch:tenant:${U}`)).toBeTruthy();
  });

  it("reads the record once per tenant, not once per call", async () => {
    await readKillState(U);
    await readKillState(U);
    await readKillState(U, { service: "github" });
    expect(record.loadKillRecords).toHaveBeenCalledTimes(1);
  });

  it("one call costs the same Redis commands as before: the marker rides in one MGET", async () => {
    store.set(LOADED(U), 1);
    await readKillState(U, { service: "github" });
    expect(redisMock.mget).toHaveBeenCalledTimes(1);
    expect(redisMock.get).not.toHaveBeenCalled();
  });

  it("the marker is per tenant: one tenant loading never marks another", async () => {
    await readKillState(U);
    expect(store.get(LOADED(OTHER))).toBeUndefined();
    await readKillState(OTHER);
    expect(record.loadKillRecords).toHaveBeenCalledWith(OTHER);
  });
});

describe("a record that cannot be read follows the kill switch's own fail posture", () => {
  beforeEach(() => {
    record.loadKillRecords.mockRejectedValue(new Error("db down"));
  });

  it("fails open by default, says so, and tries again on the next call", async () => {
    const state = await readKillState(U);
    expect(isBlocked(state, AGENT)).toBe(false);
    expect(logFailOpenMock).toHaveBeenCalledWith("kill_record_read");
    expect(store.get(LOADED(U))).toBeUndefined();
    await readKillState(U);
    expect(record.loadKillRecords).toHaveBeenCalledTimes(2);
  });

  it("still honours what Redis DID hold", async () => {
    store.set(`killswitch:tenant:${U}`, 1);
    expect((await readKillState(U)).userKill).toBe(true);
  });

  it("fails closed under KILL_SWITCH_FAIL_CLOSED=true (hosted Cloud)", async () => {
    process.env.KILL_SWITCH_FAIL_CLOSED = "true";
    expect(isBlocked(await readKillState(U), AGENT)).toBe(true);
  });

  it("the screen says it cannot tell, rather than 'clear'", async () => {
    expect((await observeKillState(U)).tenant).toBeNull();
    expect(await observeServiceKill(U, "github")).toBeNull();
    store.set(`killswitch:tenant:${U}`, 1);
    expect((await observeKillState(U)).tenant).toBe(true);
  });
});

describe("arming and disarming write the record", () => {
  it("arming the master kill writes Redis first (it takes effect at once), then the record", async () => {
    const order: string[] = [];
    redisMock.set.mockImplementationOnce(async (k: string, v: unknown) => {
      order.push("redis");
      store.set(k, v);
      return "OK";
    });
    record.saveKillRecord.mockImplementationOnce(async () => {
      order.push("record");
      return true;
    });
    expect(await setTenantKillDurably(U, true)).toEqual({ durable: true });
    expect(order).toEqual(["redis", "record"]);
    expect(record.saveKillRecord).toHaveBeenCalledWith(U, { kind: "tenant" });
  });

  it("an arm the record refused still stops calls, and says it was not saved", async () => {
    record.saveKillRecord.mockResolvedValueOnce(false);
    expect(await setTenantKillDurably(U, true)).toEqual({ durable: false });
    expect(store.get(`killswitch:tenant:${U}`)).toBeTruthy();
  });

  it("disarming clears the record FIRST, so a reload between the two can only re-arm", async () => {
    store.set(`killswitch:tenant:${U}`, 1);
    let redisAtDelete: unknown = "unread";
    record.deleteKillRecord.mockImplementationOnce(async () => {
      redisAtDelete = store.get(`killswitch:tenant:${U}`);
      return true;
    });
    expect(await setTenantKillDurably(U, false)).toEqual({ durable: true });
    expect(redisAtDelete).toBeTruthy();
    expect(store.has(`killswitch:tenant:${U}`)).toBe(false);
    expect(record.deleteKillRecord).toHaveBeenCalledWith(U, { kind: "tenant" });
  });

  it("a disarm whose record could not be cleared still disarms, and says it may come back", async () => {
    store.set(`killswitch:tenant:${U}`, 1);
    record.deleteKillRecord.mockResolvedValueOnce(false);
    expect(await setTenantKillDurably(U, false)).toEqual({ durable: false });
    expect(store.has(`killswitch:tenant:${U}`)).toBe(false);
  });

  it("a per-service kill is recorded and cleared the same way", async () => {
    expect(await setServiceKillDurably(U, "github", true)).toEqual({ durable: true });
    expect(record.saveKillRecord).toHaveBeenCalledWith(U, { kind: "service", service: "github" });
    expect(store.get(`killswitch:tenant:${U}:svc:github`)).toBeTruthy();
    expect(await setServiceKillDurably(U, "github", false)).toEqual({ durable: true });
    expect(record.deleteKillRecord).toHaveBeenCalledWith(U, { kind: "service", service: "github" });
    expect(store.has(`killswitch:tenant:${U}:svc:github`)).toBe(false);
  });

  it("a Redis failure on arm is still an error: nothing claims a stop that is not in force", async () => {
    redisMock.set.mockRejectedValueOnce(new Error("redis down"));
    await expect(setTenantKillDurably(U, true)).rejects.toThrow();
    expect(record.saveKillRecord).not.toHaveBeenCalled();
  });

  it("the demo's self-expiring kill and the bare Redis arms stay off the record", async () => {
    await armTenantKill(U, true, { ttlSeconds: 60 });
    await armTenantKill(U, true);
    await armTenantKill(U, false);
    await armServiceKill(U, "github", true);
    expect(record.saveKillRecord).not.toHaveBeenCalled();
    expect(record.deleteKillRecord).not.toHaveBeenCalled();
  });
});
