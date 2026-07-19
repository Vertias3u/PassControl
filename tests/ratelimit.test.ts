import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Upstash client with an in-memory EVAL/Lua-shaped operation so we can
// test the limiter's behavior without a real Redis.
const { store, ttls, redisMock, logFailOpenMock } = vi.hoisted(() => {
  const store = new Map<string, number>();
  const ttls = new Map<string, number>();
  const redisMock = {
    incr: vi.fn(async (k: string) => {
      const n = (store.get(k) ?? 0) + 1;
      store.set(k, n);
      return n;
    }),
    expire: vi.fn(async (k: string, seconds: number) => {
      ttls.set(k, seconds);
      return 1;
    }),
    ttl: vi.fn(async (k: string) => ttls.get(k) ?? -1),
    eval: vi.fn(async (_script: string, keys: string[], args: string[]) => {
      const key = keys[0]!;
      const windowSeconds = Number(args[0]);
      const n = (store.get(key) ?? 0) + 1;
      store.set(key, n);
      if (n === 1 || (ttls.get(key) ?? -1) < 0) ttls.set(key, windowSeconds);
      return n;
    }),
  };
  return { store, ttls, redisMock, logFailOpenMock: vi.fn() };
});
vi.mock("../lib/state/redis", () => ({ redis: () => redisMock }));
vi.mock("../lib/observability", () => ({ logFailOpen: logFailOpenMock }));

import { rateLimit } from "../lib/ratelimit";

beforeEach(() => {
  store.clear();
  ttls.clear();
  redisMock.incr.mockClear();
  redisMock.expire.mockClear();
  redisMock.ttl.mockClear();
  redisMock.eval.mockClear();
  logFailOpenMock.mockClear();
});

describe("rate limiter — /api/auth/challenge brute-force guard", () => {
  // THE exploit guard: pre-fix the challenge endpoint accepted unlimited hits.
  // This asserts the (limit+1)th request from one client is rejected.
  it("allows up to the limit, then blocks", async () => {
    const LIMIT = 5;
    for (let i = 0; i < LIMIT; i++) {
      expect((await rateLimit("1.2.3.4", LIMIT, 60)).success).toBe(true);
    }
    expect((await rateLimit("1.2.3.4", LIMIT, 60)).success).toBe(false);
  });

  it("is per-key — one client cannot exhaust another's quota", async () => {
    const LIMIT = 3;
    for (let i = 0; i < LIMIT; i++) await rateLimit("attacker", LIMIT, 60);
    expect((await rateLimit("victim", LIMIT, 60)).success).toBe(true);
  });

  it("reports remaining quota", async () => {
    const r1 = await rateLimit("k", 3, 60);
    expect(r1.remaining).toBe(2);
    const r2 = await rateLimit("k", 3, 60);
    expect(r2.remaining).toBe(1);
  });

  it("uses one atomic operation while keeping the window TTL", async () => {
    await rateLimit("k", 5, 60);
    await rateLimit("k", 5, 60);
    expect(redisMock.eval).toHaveBeenCalledTimes(2);
    expect(await redisMock.ttl("ratelimit:k")).toBe(60);
  });

  it("repairs a counter that has no TTL so it never wedges forever", async () => {
    store.set("ratelimit:wedged", 7);
    expect(await redisMock.ttl("ratelimit:wedged")).toBe(-1);

    await rateLimit("wedged", 10, 60);

    expect(redisMock.eval).toHaveBeenCalledTimes(1);
    expect(await redisMock.ttl("ratelimit:wedged")).toBe(60);
  });

  it("fails open and logs a sanitized warning when Redis throws", async () => {
    redisMock.eval.mockRejectedValueOnce(new Error("redis down"));

    await expect(rateLimit("client", 5, 60)).resolves.toEqual({
      success: true,
      remaining: 5,
    });
    expect(logFailOpenMock).toHaveBeenCalledOnce();
    expect(logFailOpenMock).toHaveBeenCalledWith("ratelimit");
  });
});
