// Stop one session, not the whole agent (sprint T8, owner D9: yes, fail-open like
// suspend). The stop is a Redis flag per (agent, declared session), read in the
// SAME round-trip as `suspended:<agid>`: one MGET instead of an EXISTS, so a call
// that declares a session costs no extra billed Redis command (Upstash is the
// measured free-tier ceiling, TEAMSHARE 2026-10-03).
//
// isSuspended(agentId, sessionId) answers true (the agent is suspended), false, or
// "session" (only this session is stopped). Agent-level suspension wins, so the
// opaque refusal for it is unchanged. A caller that treats the answer as a boolean
// reads "session" as truthy, i.e. refuses: the safe direction.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { redisMock, logFailOpenMock } = vi.hoisted(() => ({
  redisMock: { exists: vi.fn(), mget: vi.fn(), set: vi.fn(), del: vi.fn() },
  logFailOpenMock: vi.fn(),
}));

vi.mock("@upstash/redis", () => ({ Redis: { fromEnv: () => redisMock } }));
vi.mock("../lib/observability", () => ({ logFailOpen: logFailOpenMock }));

import { isSuspended, readSessionStops, resumeSession, stopSession } from "../lib/state/redis";

const AGENT = "11111111-2222-4333-8444-555555555555";

beforeEach(() => {
  for (const fn of Object.values(redisMock)) fn.mockReset();
  logFailOpenMock.mockClear();
  delete process.env.KILL_SWITCH_FAIL_CLOSED;
});

describe("isSuspended with a declared session", () => {
  it("reads the agent flag and the session flag in one MGET", async () => {
    redisMock.mget.mockResolvedValueOnce([null, null]);
    await expect(isSuspended(AGENT, "sess-1")).resolves.toBe(false);
    expect(redisMock.mget).toHaveBeenCalledWith(`suspended:${AGENT}`, `session_stop:${AGENT}:sess-1`);
    expect(redisMock.exists).not.toHaveBeenCalled();
  });

  it('answers "session" when only the session is stopped', async () => {
    redisMock.mget.mockResolvedValueOnce([null, "1"]);
    await expect(isSuspended(AGENT, "sess-1")).resolves.toBe("session");
  });

  it("lets agent-level suspension win over a session stop", async () => {
    redisMock.mget.mockResolvedValueOnce([1, "1"]);
    await expect(isSuspended(AGENT, "sess-1")).resolves.toBe(true);
  });

  it("keeps the old single EXISTS when no session is declared", async () => {
    redisMock.exists.mockResolvedValueOnce(0);
    await expect(isSuspended(AGENT)).resolves.toBe(false);
    await expect(isSuspended(AGENT, null)).resolves.toBe(false);
    expect(redisMock.mget).not.toHaveBeenCalled();
  });

  it("fails open by default when the read fails, like suspend", async () => {
    redisMock.mget.mockRejectedValueOnce(new Error("redis down"));
    await expect(isSuspended(AGENT, "sess-1")).resolves.toBe(false);
    expect(logFailOpenMock).toHaveBeenCalledWith("suspend_read");
  });

  it("fails closed under KILL_SWITCH_FAIL_CLOSED, refusing the whole agent", async () => {
    process.env.KILL_SWITCH_FAIL_CLOSED = "true";
    redisMock.mget.mockRejectedValueOnce(new Error("redis down"));
    await expect(isSuspended(AGENT, "sess-1")).resolves.toBe(true);
  });

  it.each(["", "a b", "x\r\nset suspended:other 1", "s".repeat(129), "ünï"])(
    "never builds a key from a session id the gateway would not accept (%j)",
    async (bad) => {
      redisMock.exists.mockResolvedValueOnce(0);
      await expect(isSuspended(AGENT, bad)).resolves.toBe(false);
      expect(redisMock.mget).not.toHaveBeenCalled();
    }
  );
});

describe("stopSession / resumeSession", () => {
  it("sets and deletes the session's flag, with no expiry", async () => {
    await stopSession(AGENT, "sess-1");
    expect(redisMock.set).toHaveBeenCalledWith(`session_stop:${AGENT}:sess-1`, 1);
    await resumeSession(AGENT, "sess-1");
    expect(redisMock.del).toHaveBeenCalledWith(`session_stop:${AGENT}:sess-1`);
  });

  // F4: the public demo's per-visitor stop expires on its own, like the demo's old
  // shared kill did, so abandoned stops never pile up in Redis.
  it("expires the flag when asked to, and only with a whole number of seconds", async () => {
    await stopSession(AGENT, "sess-1", { ttlSeconds: 600 });
    expect(redisMock.set).toHaveBeenCalledWith(`session_stop:${AGENT}:sess-1`, 1, { ex: 600 });
    for (const ttlSeconds of [0, -1, 1.5, Number.NaN]) {
      await expect(stopSession(AGENT, "sess-1", { ttlSeconds })).rejects.toThrow();
    }
    expect(redisMock.set).toHaveBeenCalledTimes(1);
  });

  it("refuses an id it would never read back", async () => {
    await expect(stopSession(AGENT, "a b")).rejects.toThrow();
    expect(redisMock.set).not.toHaveBeenCalled();
  });
});

describe("readSessionStops (for showing the state, not deciding a call)", () => {
  it("returns the stopped ones from one MGET", async () => {
    redisMock.mget.mockResolvedValueOnce(["1", null, "1"]);
    const stops = await readSessionStops(AGENT, ["a", "b", "c"]);
    expect(stops).toEqual(new Set(["a", "c"]));
    expect(redisMock.mget).toHaveBeenCalledWith(`session_stop:${AGENT}:a`, `session_stop:${AGENT}:b`, `session_stop:${AGENT}:c`);
  });

  it("returns null when the read fails, so the view can say it does not know", async () => {
    redisMock.mget.mockRejectedValueOnce(new Error("down"));
    await expect(readSessionStops(AGENT, ["a"])).resolves.toBeNull();
  });

  it("asks nothing for no sessions", async () => {
    await expect(readSessionStops(AGENT, [])).resolves.toEqual(new Set());
    expect(redisMock.mget).not.toHaveBeenCalled();
  });
});
