import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory Redis stand-in supporting the subset lockout.ts uses
// (exists/incr/expire/set/del). `setCalls` records every set() so we can assert
// the escalating cooldown durations without a real clock.
const { store, setCalls, redisMock } = vi.hoisted(() => {
  const store = new Map<string, number>();
  const setCalls: { key: string; ex?: number }[] = [];
  const redisMock = {
    exists: vi.fn(async (k: string) => (store.has(k) ? 1 : 0)),
    incr: vi.fn(async (k: string) => {
      const n = (store.get(k) ?? 0) + 1;
      store.set(k, n);
      return n;
    }),
    expire: vi.fn(async () => 1),
    set: vi.fn(async (k: string, v: number, opts?: { ex?: number }) => {
      store.set(k, v);
      setCalls.push({ key: k, ex: opts?.ex });
      return "OK";
    }),
    del: vi.fn(async (...keys: string[]) => {
      let n = 0;
      for (const k of keys) if (store.delete(k)) n++;
      return n;
    }),
  };
  return { store, setCalls, redisMock };
});
vi.mock("@/lib/state/redis", () => ({ redis: () => redisMock }));

import {
  isLockedOut,
  recordLoginFailure,
  clearLoginFailures,
} from "../lib/auth/lockout";

const EMAIL = "agent@example.com";

beforeEach(() => {
  store.clear();
  setCalls.length = 0;
  vi.clearAllMocks();
});

describe("account lockout — brute-force defense (security #4)", () => {
  it("is not locked out before any failures", async () => {
    expect(await isLockedOut(EMAIL)).toBe(false);
  });

  it("does not lock before the 5th consecutive failure", async () => {
    for (let i = 0; i < 4; i++) await recordLoginFailure(EMAIL);
    expect(await isLockedOut(EMAIL)).toBe(false);
  });

  it("locks the account on the 5th failure", async () => {
    for (let i = 0; i < 5; i++) await recordLoginFailure(EMAIL);
    expect(await isLockedOut(EMAIL)).toBe(true);
  });

  it("escalates the cooldown on each subsequent lockout (60s → 300s → 900s)", async () => {
    const lockExs = () =>
      setCalls.filter((c) => c.key === `lockout:${EMAIL}`).map((c) => c.ex);
    // First lockout
    for (let i = 0; i < 5; i++) await recordLoginFailure(EMAIL);
    // Second lockout — fail counter was reset on lock, so 5 more fails re-trigger.
    for (let i = 0; i < 5; i++) await recordLoginFailure(EMAIL);
    // Third lockout
    for (let i = 0; i < 5; i++) await recordLoginFailure(EMAIL);
    expect(lockExs()).toEqual([60, 300, 900]);
  });

  it("clearLoginFailures lifts the lock and resets the counter", async () => {
    for (let i = 0; i < 5; i++) await recordLoginFailure(EMAIL);
    expect(await isLockedOut(EMAIL)).toBe(true);
    await clearLoginFailures(EMAIL);
    expect(await isLockedOut(EMAIL)).toBe(false);
    // Counter reset: a single post-clear failure must not immediately re-lock.
    await recordLoginFailure(EMAIL);
    expect(await isLockedOut(EMAIL)).toBe(false);
  });

  it("is keyed on the normalized email — a different account is unaffected", async () => {
    for (let i = 0; i < 5; i++) await recordLoginFailure(EMAIL);
    expect(await isLockedOut("someone-else@example.com")).toBe(false);
  });

  it("treats an empty email as never-locked (guards the caller's fallback)", async () => {
    expect(await isLockedOut("")).toBe(false);
    await recordLoginFailure(""); // no-op, must not throw
    expect(redisMock.incr).not.toHaveBeenCalled();
  });
});
