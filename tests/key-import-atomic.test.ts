// The key-import handoff must redeem EXACTLY once — and until this file existed,
// nothing checked that it did.
//
// `tests/key-import.test.ts` covers the on-ramp thoroughly, but it replaces
// `takeKeyImport` with an in-test stub, so the real implementation in
// lib/state/redis.ts was never executed by the suite. Its docstring claimed
// "Redeem a handoff EXACTLY once" while the body did `get` and then `del` as two
// separate round trips.
//
// What that costs: the handoff holds an already-SEALED provider key. Two
// concurrent redemptions of one captured id both read before either deletes, so
// both callers walk away with the ciphertext — and `completeKeyImport` opens it
// and stores the provider secret under whichever tenant asked. The id is
// short-lived and unguessable, so this is a narrow window rather than an open
// door, but "exactly once" was written down as a property and was not one.
//
// Found while building the device flow, whose grant redemption faces the same
// choice — see the note in lib/state/device-auth.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { store, calls, fakeRedis } = vi.hoisted(() => {
  const values = new Map<string, string>();
  const log: string[] = [];
  const client = {
    async set(key: string, value: unknown) {
      log.push(`set ${key}`);
      values.set(key, typeof value === "string" ? value : JSON.stringify(value));
      return "OK";
    },
    // Async on purpose, with a real yield to the event loop. This is what makes
    // the race below REPRODUCIBLE: a get/del pair lets a second caller read
    // during the await, before the first caller's delete lands. A synchronous
    // fake would hide the very defect this file exists to catch.
    async get(key: string) {
      log.push(`get ${key}`);
      await Promise.resolve();
      const raw = values.get(key);
      if (raw === undefined) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    },
    async del(key: string) {
      log.push(`del ${key}`);
      await Promise.resolve();
      return values.delete(key) ? 1 : 0;
    },
    // Read-and-delete decided in ONE call, with no await between the two halves
    // — which is exactly what the real GETDEL gives us, server-side.
    async getdel(key: string) {
      log.push(`getdel ${key}`);
      const raw = values.get(key);
      values.delete(key);
      await Promise.resolve();
      if (raw === undefined) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    },
  };
  return { store: values, calls: log, fakeRedis: client };
});

vi.mock("@upstash/redis", () => ({ Redis: { fromEnv: () => fakeRedis } }));

import { stashKeyImport, takeKeyImport } from "../lib/state/redis";

const USER = "user-1";
const ID = "handoff-abc";
const SEALED = "sealed-provider-key-ciphertext";

beforeEach(() => {
  store.clear();
  calls.length = 0;
});

describe("the key-import handoff redeems exactly once", () => {
  it("hands the ciphertext to ONE of two concurrent redeemers", async () => {
    await stashKeyImport(USER, ID, SEALED, 120);
    // Both in flight before either completes. With get-then-del they both read
    // before either deletes, and both succeed.
    const [a, b] = await Promise.all([takeKeyImport(USER, ID), takeKeyImport(USER, ID)]);
    const winners = [a, b].filter((v) => v !== null);
    expect(winners, "exactly one caller may receive the sealed key").toEqual([SEALED]);
  });

  it("survives a wider stampede", async () => {
    await stashKeyImport(USER, ID, SEALED, 120);
    const results = await Promise.all(Array.from({ length: 8 }, () => takeKeyImport(USER, ID)));
    expect(results.filter((v) => v !== null)).toHaveLength(1);
  });

  it("is empty on every attempt after the first", async () => {
    await stashKeyImport(USER, ID, SEALED, 120);
    expect(await takeKeyImport(USER, ID)).toBe(SEALED);
    expect(await takeKeyImport(USER, ID)).toBeNull();
    expect(await takeKeyImport(USER, ID)).toBeNull();
  });

  it("resolves it in a single round trip", async () => {
    // Names the mechanism, so a future refactor back to a get/del pair fails
    // here even if some fake happened to hide the race above.
    await stashKeyImport(USER, ID, SEALED, 120);
    calls.length = 0;
    await takeKeyImport(USER, ID);
    expect(calls).toEqual([`getdel keyimport:${USER}:${ID}`]);
  });
});

describe("the handoff stays bound to its tenant", () => {
  it("cannot be redeemed by another user with the same id", async () => {
    // The tenant is baked into the Redis key, so a guessed id is not enough.
    await stashKeyImport(USER, ID, SEALED, 120);
    expect(await takeKeyImport("user-2", ID)).toBeNull();
    // …and the rightful owner's handoff is untouched by the failed attempt.
    expect(await takeKeyImport(USER, ID)).toBe(SEALED);
  });
});

describe("a Redis fault fails CLOSED", () => {
  it("throws rather than reporting an empty handoff", async () => {
    // An unreadable store must not look like "no such handoff", which the caller
    // reports as an expired import. Throwing is what keeps a transient outage
    // from being indistinguishable from a replayed id.
    const spy = vi.spyOn(fakeRedis, "getdel").mockRejectedValue(new Error("redis down"));
    await expect(takeKeyImport(USER, ID)).rejects.toThrow();
    spy.mockRestore();
  });
});
