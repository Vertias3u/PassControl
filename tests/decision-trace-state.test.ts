import { beforeEach, describe, expect, it, vi } from "vitest";

const { redisMock, fromEnvMock, logFailOpenMock } = vi.hoisted(() => {
  const redisMock = {
    get: vi.fn(),
    mget: vi.fn(),
    eval: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
  };
  return {
    redisMock,
    fromEnvMock: vi.fn(() => redisMock),
    logFailOpenMock: vi.fn(),
  };
});

vi.mock("@upstash/redis", () => ({ Redis: { fromEnv: fromEnvMock } }));
vi.mock("@/lib/observability", () => ({ logFailOpen: logFailOpenMock }));

import { readBudgetSnapshot } from "@/lib/state/redis";
import { peekRateLimit } from "@/lib/ratelimit";

beforeEach(() => {
  redisMock.get.mockReset();
  redisMock.mget.mockReset();
  redisMock.eval.mockReset();
  redisMock.set.mockReset();
  redisMock.del.mockReset();
  logFailOpenMock.mockReset();
});

describe("decision-trace Redis reads", () => {
  it("reads all budget dimensions without mutating counters", async () => {
    redisMock.mget.mockResolvedValue([120, 30, 4_000, 500]);

    await expect(readBudgetSnapshot("agent-a")).resolves.toEqual({
      reservedTokens: 120,
      spentTokens: 30,
      reservedMicrocents: 4_000,
      spentMicrocents: 500,
    });
    expect(redisMock.mget).toHaveBeenCalledWith(
      "reserved:agent-a",
      "spent:agent-a",
      "reserved_cost:agent-a",
      "spent_cost:agent-a"
    );
    expect(redisMock.eval).not.toHaveBeenCalled();
    expect(redisMock.set).not.toHaveBeenCalled();
    expect(redisMock.del).not.toHaveBeenCalled();
  });

  it("peeks whether the next hourly request would pass without consuming it", async () => {
    redisMock.get.mockResolvedValue(4);

    await expect(peekRateLimit("policy-hour:u1:a1", 5)).resolves.toEqual({
      success: true,
      remaining: 0,
    });
    expect(redisMock.get).toHaveBeenCalledWith("ratelimit:policy-hour:u1:a1");
    expect(redisMock.eval).not.toHaveBeenCalled();
  });
});
