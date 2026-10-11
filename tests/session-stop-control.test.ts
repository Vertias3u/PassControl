// Stopping one session from the dashboard (sprint T8). The owner's Stop/Resume
// reaches Redis only for an agent of THEIR OWN that is not revoked, and only for a
// session id the gateway would ever read back. The service-role client bypasses
// RLS, so the user_id filter here is the whole tenant boundary.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { stopSession, resumeSession, saveKillRecord, deleteKillRecord, order } = vi.hoisted(() => {
  const order: string[] = [];
  return {
    order,
    stopSession: vi.fn(async (..._a: unknown[]) => {
      order.push("redis.stop");
    }),
    resumeSession: vi.fn(async (..._a: unknown[]) => {
      order.push("redis.resume");
    }),
    saveKillRecord: vi.fn(async (..._a: unknown[]) => {
      order.push("record.save");
      return true;
    }),
    deleteKillRecord: vi.fn(async (..._a: unknown[]) => {
      order.push("record.delete");
      return true;
    }),
  };
});
vi.mock("@/lib/state/redis", () => ({
  stopSession,
  resumeSession,
  suspendAgent: vi.fn(),
  unsuspendAgent: vi.fn(),
  purgeAgentCaches: vi.fn(),
  purgeAgentPolicy: vi.fn(),
}));
vi.mock("@/lib/state/killswitch", () => ({ setTenantKillDurably: vi.fn() }));
vi.mock("@/lib/state/kill-record", () => ({ saveKillRecord, deleteKillRecord }));

import { setSessionStopped } from "@/lib/fleet";

const AGENT = "11111111-2222-4333-8444-555555555555";

function db(row: unknown, error: unknown = null) {
  const eq: [string, unknown][] = [];
  const b: Record<string, unknown> = {};
  Object.assign(b, {
    select: () => b,
    eq: (c: string, v: unknown) => (eq.push([c, v]), b),
    maybeSingle: async () => ({ data: row, error }),
  });
  return { client: { from: () => b } as never, eq };
}

beforeEach(() => {
  stopSession.mockClear();
  resumeSession.mockClear();
  saveKillRecord.mockClear();
  deleteKillRecord.mockClear();
  order.length = 0;
});

describe("setSessionStopped", () => {
  it("stops a session of the caller's own active agent", async () => {
    const d = db({ id: AGENT, status: "active" });
    await expect(setSessionStopped(d.client, "u1", AGENT, "sess-1", true)).resolves.toEqual({ ok: true, value: { id: AGENT, sessionId: "sess-1", stopped: true, durable: true } });
    expect(stopSession).toHaveBeenCalledWith(AGENT, "sess-1");
    expect(d.eq).toContainEqual(["user_id", "u1"]);
    expect(d.eq).toContainEqual(["id", AGENT]);
  });

  it("resumes it", async () => {
    await setSessionStopped(db({ id: AGENT, status: "active" }).client, "u1", AGENT, "sess-1", false);
    expect(resumeSession).toHaveBeenCalledWith(AGENT, "sess-1");
    expect(stopSession).not.toHaveBeenCalled();
  });

  // 0083: a stop survives Redis losing its data. In force first, then recorded;
  // a resume clears the record first, so a reload in between can only re-stop.
  it("records the stop after it is in force, and clears the record before a resume", async () => {
    await setSessionStopped(db({ id: AGENT, status: "active" }).client, "u1", AGENT, "sess-1", true);
    expect(saveKillRecord).toHaveBeenCalledWith("u1", { kind: "session", agentId: AGENT, sessionId: "sess-1" });
    await setSessionStopped(db({ id: AGENT, status: "active" }).client, "u1", AGENT, "sess-1", false);
    expect(deleteKillRecord).toHaveBeenCalledWith("u1", { kind: "session", agentId: AGENT, sessionId: "sess-1" });
    expect(order).toEqual(["redis.stop", "record.save", "record.delete", "redis.resume"]);
  });

  it("a stop the record refused is still in force, and says it was not saved", async () => {
    saveKillRecord.mockResolvedValueOnce(false);
    await expect(setSessionStopped(db({ id: AGENT, status: "active" }).client, "u1", AGENT, "sess-1", true)).resolves.toMatchObject({
      ok: true,
      value: { stopped: true, durable: false },
    });
    expect(stopSession).toHaveBeenCalled();
  });

  it("works for a suspended agent too, so a stop survives a later resume of the agent", async () => {
    await expect(setSessionStopped(db({ id: AGENT, status: "suspended" }).client, "u1", AGENT, "s", true)).resolves.toMatchObject({ ok: true });
  });

  it.each([
    ["another tenant's agent (no row for this user)", null],
    ["a revoked agent", { id: AGENT, status: "revoked" }],
  ])("refuses %s as not found, touching nothing", async (_label, row) => {
    await expect(setSessionStopped(db(row).client, "u1", AGENT, "sess-1", true)).resolves.toEqual({ ok: false, status: 404, code: "not_found" });
    expect(stopSession).not.toHaveBeenCalled();
  });

  it.each(["", "a b", "x\nset", "s".repeat(129), "ünï"])("refuses a session id the gateway would never read (%j)", async (bad) => {
    await expect(setSessionStopped(db({ id: AGENT, status: "active" }).client, "u1", AGENT, bad, true)).resolves.toEqual({ ok: false, status: 400, code: "invalid_session" });
    expect(stopSession).not.toHaveBeenCalled();
  });

  it("refuses a malformed agent id without a lookup", async () => {
    await expect(setSessionStopped(db(null).client, "u1", "not-a-uuid", "s", true)).resolves.toEqual({ ok: false, status: 404, code: "not_found" });
  });

  it("reports a failed lookup instead of guessing", async () => {
    await expect(setSessionStopped(db(null, { message: "x" }).client, "u1", AGENT, "s", true)).resolves.toEqual({ ok: false, status: 500, code: "query_failed" });
    expect(stopSession).not.toHaveBeenCalled();
  });

  it("surfaces a Redis failure to the caller", async () => {
    stopSession.mockRejectedValueOnce(new Error("redis unavailable"));
    await expect(setSessionStopped(db({ id: AGENT, status: "active" }).client, "u1", AGENT, "s", true)).rejects.toThrow("redis unavailable");
  });
});
