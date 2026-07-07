import { beforeEach, describe, expect, it, vi } from "vitest";

const { redisMock } = vi.hoisted(() => ({
  redisMock: {
    exists: vi.fn(),
  },
}));

vi.mock("@upstash/redis", () => ({
  Redis: {
    fromEnv: () => redisMock,
  },
}));

import { isSuspended } from "../lib/state/redis";

beforeEach(() => {
  redisMock.exists.mockReset();
  delete process.env.KILL_SWITCH_FAIL_CLOSED;
});

describe("isSuspended - Redis outage semantics", () => {
  it("fails open by default if Redis exists throws", async () => {
    redisMock.exists.mockRejectedValueOnce(new Error("redis down"));

    await expect(isSuspended("agent-1")).resolves.toBe(false);
  });

  it("fails closed when KILL_SWITCH_FAIL_CLOSED=true", async () => {
    process.env.KILL_SWITCH_FAIL_CLOSED = "true";
    redisMock.exists.mockRejectedValueOnce(new Error("redis down"));

    await expect(isSuspended("agent-1")).resolves.toBe(true);
  });
});
