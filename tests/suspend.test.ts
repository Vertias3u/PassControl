import { beforeEach, describe, expect, it, vi } from "vitest";

const { redisMock, logFailOpenMock } = vi.hoisted(() => ({
  redisMock: {
    exists: vi.fn(),
  },
  logFailOpenMock: vi.fn(),
}));

vi.mock("@upstash/redis", () => ({
  Redis: {
    fromEnv: () => redisMock,
  },
}));
vi.mock("../lib/observability", () => ({ logFailOpen: logFailOpenMock }));

import { isSuspended } from "../lib/state/redis";

beforeEach(() => {
  redisMock.exists.mockReset();
  logFailOpenMock.mockClear();
  delete process.env.KILL_SWITCH_FAIL_CLOSED;
});

describe("isSuspended - Redis outage semantics", () => {
  it("fails open by default if Redis exists throws", async () => {
    redisMock.exists.mockRejectedValueOnce(new Error("redis down"));

    await expect(isSuspended("agent-1")).resolves.toBe(false);
    expect(logFailOpenMock).toHaveBeenCalledOnce();
    expect(logFailOpenMock).toHaveBeenCalledWith("suspend_read");
  });

  it("fails closed when KILL_SWITCH_FAIL_CLOSED=true", async () => {
    process.env.KILL_SWITCH_FAIL_CLOSED = "true";
    redisMock.exists.mockRejectedValueOnce(new Error("redis down"));

    await expect(isSuspended("agent-1")).resolves.toBe(true);
    expect(logFailOpenMock).toHaveBeenCalledOnce();
    expect(logFailOpenMock).toHaveBeenCalledWith("suspend_read");
  });
});
