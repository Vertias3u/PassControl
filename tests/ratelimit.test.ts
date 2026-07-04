import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Upstash client with an in-memory INCR/EXPIRE so we can test the
// limiter's behavior without a real Redis.
const { store, redisMock } = vi.hoisted(() => {
  const store = new Map<string, number>();
  const redisMock = {
    incr: vi.fn(async (k: string) => {
      const n = (store.get(k) ?? 0) + 1;
      store.set(k, n);
      return n;
    }),
    expire: vi.fn(async () => 1),
  };
  return { store, redisMock };
});
vi.mock("../lib/state/redis", () => ({ redis: () => redisMock }));

import { rateLimit } from "../lib/ratelimit";

beforeEach(() => {
  store.clear();
  redisMock.incr.mockClear();
  redisMock.expire.mockClear();
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

  it("sets the window TTL only on the first hit in the window", async () => {
    await rateLimit("k", 5, 60);
    await rateLimit("k", 5, 60);
    expect(redisMock.expire).toHaveBeenCalledTimes(1);
  });
});
