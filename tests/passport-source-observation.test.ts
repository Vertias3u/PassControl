import { beforeAll, describe, expect, it } from "vitest";

import {
  MAX_PASSPORT_SOURCE_FINGERPRINTS,
  PASSPORT_SOURCE_STATE_TTL_SECONDS,
  PASSPORT_SOURCE_STABILITY_SECONDS,
  observePassportSource,
  readPassportSourceSignals,
} from "@/lib/passport-source-observation";
import {
  AUTH_HMAC_LABELS,
  createAuthHmacKeyDeriver,
} from "@/lib/crypto/derived-auth-hmac";

type SortedSet = Map<string, number>;

function fakeRedis() {
  const sorted = new Map<string, SortedSet>();
  const lists = new Map<string, string[]>();
  const expiries = new Map<string, number>();
  const operations: unknown[] = [];

  const setFor = (key: string) => {
    let value = sorted.get(key);
    if (!value) {
      value = new Map();
      sorted.set(key, value);
    }
    return value;
  };

  const pipeline = () => {
    const commands: Array<() => unknown> = [];
    const p = {
      zadd: (key: string, arg1: unknown, arg2?: { score: number; member: string }) => {
        const options = arg2 ? arg1 as { nx?: true } : {};
        const pair = (arg2 ?? arg1) as { score: number; member: string };
        operations.push(["zadd", key, options, pair]);
        commands.push(() => {
          const set = setFor(key);
          if (options.nx && set.has(pair.member)) return 0;
          const added = set.has(pair.member) ? 0 : 1;
          set.set(pair.member, pair.score);
          return added;
        });
        return p;
      },
      zrange: (key: string, min: number, max: number | string, options?: { byScore?: true; withScores?: boolean }) => {
        operations.push(["zrange", key, min, max, options]);
        commands.push(() => {
          const entries = [...setFor(key).entries()].sort((a, b) => a[1] - b[1]);
          const selected = options?.byScore
            ? entries.filter(([, score]) => score >= min && (max === "+inf" || score <= Number(max)))
            : entries.slice(min, max === -1 ? undefined : Number(max) + 1);
          return options?.withScores
            ? selected.map(([member, score]) => ({ member, score }))
            : selected.map(([member]) => member);
        });
        return p;
      },
      zrem: (key: string, ...members: string[]) => {
        operations.push(["zrem", key, members]);
        commands.push(() => {
          let removed = 0;
          for (const member of members) removed += setFor(key).delete(member) ? 1 : 0;
          return removed;
        });
        return p;
      },
      expire: (key: string, seconds: number) => {
        operations.push(["expire", key, seconds]);
        commands.push(() => {
          expiries.set(key, seconds);
          return 1;
        });
        return p;
      },
      lpush: (key: string, value: string) => {
        operations.push(["lpush", key, value]);
        commands.push(() => {
          const next = [value, ...(lists.get(key) ?? [])];
          lists.set(key, next);
          return next.length;
        });
        return p;
      },
      ltrim: (key: string, start: number, stop: number) => {
        operations.push(["ltrim", key, start, stop]);
        commands.push(() => {
          const list = lists.get(key) ?? [];
          lists.set(key, list.slice(start, stop + 1));
          return "OK";
        });
        return p;
      },
      exec: async () => commands.map((command) => command()),
    };
    return p;
  };

  return {
    r: {
      pipeline,
      lrange: async (key: string, start: number, stop: number) =>
        (lists.get(key) ?? []).slice(start, stop + 1),
    },
    sorted,
    lists,
    expiries,
    operations,
  };
}

const base = {
  agentId: "33333333-3333-4333-8333-333333333333",
  visaTtlSeconds: 300,
  hashKey: null as unknown as CryptoKey,
};

beforeAll(async () => {
  base.hashKey = await createAuthHmacKeyDeriver("v".repeat(48))
    .key(AUTH_HMAC_LABELS.passportSourceFingerprint);
});

describe("passport source observation", () => {
  it("ignores distinct IPs in one country inside the overlap window", async () => {
    const f = fakeRedis();
    const at = Date.UTC(2026, 7, 31, 10, 0, 0);

    expect(await observePassportSource(f.r as never, { ...base, ip: "198.51.100.10", country: "US", observedAt: at })).toBeNull();
    expect(await observePassportSource(f.r as never, { ...base, ip: "198.51.100.11", country: "US", observedAt: at + 30_000 })).toBeNull();
    expect(await readPassportSourceSignals(f.r as never, base.agentId)).toEqual([]);
  });

  it("raises a strong signal for overlapping use from two countries", async () => {
    const f = fakeRedis();
    const at = Date.UTC(2026, 7, 31, 10, 0, 0);
    await observePassportSource(f.r as never, { ...base, ip: "198.51.100.10", country: "US", observedAt: at });

    const signal = await observePassportSource(f.r as never, {
      ...base,
      ip: "203.0.113.20",
      country: "DE",
      observedAt: at + 30_000,
    });

    expect(signal).toMatchObject({ strength: "strong", countries: ["DE", "US"] });
    expect(await readPassportSourceSignals(f.r as never, base.agentId)).toEqual([signal]);
  });

  it("does not signal on the first-ever source for a new agent", async () => {
    const f = fakeRedis();
    const signal = await observePassportSource(f.r as never, {
      ...base,
      ip: "192.0.2.44",
      country: "FR",
      observedAt: Date.UTC(2026, 7, 31, 10, 0, 0),
    });
    expect(signal).toBeNull();
  });

  it("ranks a genuinely new source after a stable run as medium", async () => {
    const f = fakeRedis();
    const at = Date.UTC(2026, 7, 1, 10, 0, 0);
    await observePassportSource(f.r as never, { ...base, ip: "198.51.100.10", country: "US", observedAt: at });
    await observePassportSource(f.r as never, { ...base, ip: "198.51.100.10", country: "US", observedAt: at + PASSPORT_SOURCE_STABILITY_SECONDS * 1000 });

    const signal = await observePassportSource(f.r as never, {
      ...base,
      ip: "198.51.100.99",
      country: "US",
      observedAt: at + PASSPORT_SOURCE_STABILITY_SECONDS * 1000 + 1,
    });
    expect(signal).toMatchObject({ strength: "medium", countries: ["US"] });
  });

  it("stores only bounded, TTL'd keyed fingerprints and never the raw IP", async () => {
    const f = fakeRedis();
    const rawIp = "198.51.100.77";
    const at = Date.UTC(2026, 7, 31, 10, 0, 0);
    for (let index = 0; index < MAX_PASSPORT_SOURCE_FINGERPRINTS + 3; index++) {
      await observePassportSource(f.r as never, {
        ...base,
        ip: index === 0 ? rawIp : `198.51.100.${100 + index}`,
        country: "US",
        observedAt: at + index,
      });
    }

    for (const set of f.sorted.values()) {
      expect(set.size).toBeLessThanOrEqual(MAX_PASSPORT_SOURCE_FINGERPRINTS);
    }
    expect([...f.expiries.values()].every((ttl) => ttl === PASSPORT_SOURCE_STATE_TTL_SECONDS)).toBe(true);
    expect(JSON.stringify({ operations: f.operations, sorted: [...f.sorted] })).not.toContain(rawIp);
  });
});
