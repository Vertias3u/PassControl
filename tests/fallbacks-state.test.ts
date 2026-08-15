import { beforeEach, describe, expect, it, vi } from "vitest";

const { store, redisGet, redisSet } = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    redisGet: vi.fn(async (key: string) => store.get(key) ?? null),
    redisSet: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
  };
});

vi.mock("@vercel/functions", () => ({ waitUntil: (p: Promise<unknown>) => p }));
vi.mock("@/lib/state/redis", () => ({
  getCachedAgentFallbacks: (u: string, a: string) => redisGet(`fallbacks:${u}:${a}`),
  setCachedAgentFallbacks: (u: string, a: string, v: string) => redisSet(`fallbacks:${u}:${a}`, v),
}));

import { readCurrentAgentFallbacks } from "@/lib/state/fallbacks";

// The read only ever calls .from(…).select(…).eq(…).eq(…).maybeSingle(), so a
// chain stub is enough — and typing it as a real shape rather than `never` keeps
// `db.from` assertable below.
type StubDb = Parameters<typeof readCurrentAgentFallbacks>[0] & { from: ReturnType<typeof vi.fn> };

function dbReturning(result: { data?: unknown; error?: unknown }): { db: StubDb } {
  const maybeSingle = vi.fn(async () => ({ data: result.data ?? null, error: result.error ?? null }));
  const chain = { select: () => chain, eq: () => chain, maybeSingle };
  return { db: { from: vi.fn(() => chain) } as unknown as StubDb };
}

beforeEach(() => {
  store.clear();
  redisGet.mockClear();
  redisSet.mockClear();
});

describe("readCurrentAgentFallbacks", () => {
  it("reads the column and caches it", async () => {
    const { db } = dbReturning({ data: { fallbacks: [{ provider: "groq", model: "llama-3.3-70b" }] } });

    expect(await readCurrentAgentFallbacks(db, "tenant-a", "agent-1")).toEqual([
      { provider: "groq", model: "llama-3.3-70b" },
    ]);
    expect(store.get("fallbacks:tenant-a:agent-1")).toBeTruthy();
  });

  it("serves a second read from the cache without touching the database", async () => {
    const { db } = dbReturning({ data: { fallbacks: [{ provider: "groq", model: "llama-3.3-70b" }] } });
    await readCurrentAgentFallbacks(db, "tenant-a", "agent-1");
    db.from.mockClear();

    expect(await readCurrentAgentFallbacks(db, "tenant-a", "agent-1")).toEqual([
      { provider: "groq", model: "llama-3.3-70b" },
    ]);
    expect(db.from).not.toHaveBeenCalled();
  });

  // An agent with no failover is the common case; it must not cost a database
  // read on every failed upstream call.
  it("caches the empty result too", async () => {
    const { db } = dbReturning({ data: { fallbacks: [] } });
    await readCurrentAgentFallbacks(db, "tenant-a", "agent-1");
    expect(store.has("fallbacks:tenant-a:agent-1")).toBe(true);
  });

  // The opposite posture from policy, and the reason this file exists. Policy is
  // a restriction, so an unreadable one fails closed. A fallback list is an
  // enhancement, so an unreadable one degrades to "no failover" — the behaviour
  // the gateway had before the feature. A call must never fail because an
  // optional list could not be read.
  it("degrades to no failover on every failure mode", async () => {
    const cases = [
      dbReturning({ error: { message: "db down" } }).db,
      dbReturning({ data: null }).db,
      // A deployment that has not run migration 0018 has no such column.
      dbReturning({ data: {} }).db,
      { from: () => { throw new Error("boom"); } } as unknown as StubDb,
    ];
    for (const db of cases) {
      store.clear();
      expect(await readCurrentAgentFallbacks(db, "tenant-a", "agent-1")).toEqual([]);
    }
  });

  it("survives a cache read that throws", async () => {
    redisGet.mockRejectedValueOnce(new Error("redis down"));
    const { db } = dbReturning({ data: { fallbacks: [{ provider: "groq", model: "llama-3.3-70b" }] } });

    expect(await readCurrentAgentFallbacks(db, "tenant-a", "agent-1")).toEqual([
      { provider: "groq", model: "llama-3.3-70b" },
    ]);
  });

  // The column is writable by an authenticated tenant through PostgREST, so what
  // comes back here is untrusted. The parser is applied on the cache path too,
  // not only on the database path.
  it("applies the parser to a cached value, not just a fresh read", async () => {
    store.set("fallbacks:tenant-a:agent-1", JSON.stringify([{ provider: "nope", model: "x" }]));
    const { db } = dbReturning({ data: { fallbacks: [] } });

    expect(await readCurrentAgentFallbacks(db, "tenant-a", "agent-1")).toEqual([]);
  });
});
