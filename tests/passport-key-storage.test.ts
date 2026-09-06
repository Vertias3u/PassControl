import { describe, expect, it, vi } from "vitest";

import {
  PASSPORT_KEY_STORAGE_TTL_SECONDS,
  parseKeyStorageDeclaration,
  readDeclaredKeyStorage,
  readDeclaredKeyStorageMany,
  recordDeclaredKeyStorage,
  storeTier,
  toDeclaredKeyStorageView,
} from "@/lib/passport-key-storage";

// The wire shape is a field inside the SIGNED challenge payload, so a
// declaration is attributable to whoever holds the passport key. It is still a
// self-report: the holder can lie, and nothing in the protocol makes it true.
describe("reading a declaration off the challenge payload", () => {
  it("accepts the two stores this build knows", () => {
    expect(parseKeyStorageDeclaration({ store: "file" })).toEqual({ store: "file", fallback: false });
    expect(parseKeyStorageDeclaration({ store: "os" })).toEqual({ store: "os", fallback: false });
  });

  it("keeps the fallback flag, which is the state worth seeing", () => {
    expect(parseKeyStorageDeclaration({ store: "file", fallback: true })).toEqual({
      store: "file",
      fallback: true,
    });
  });

  // A store name from a newer CLI must survive to the panel. Dropping it would
  // render an agent on a tier this build has never heard of as tier 0 — the
  // same class of lie the panel exists to prevent.
  it("keeps a store name it does not recognise", () => {
    expect(parseKeyStorageDeclaration({ store: "enclave" })).toEqual({
      store: "enclave",
      fallback: false,
    });
  });

  // Client-controlled text that reaches a dashboard. Bound it hard at the door
  // rather than at the render.
  it("refuses anything that is not a short lowercase token", () => {
    expect(parseKeyStorageDeclaration({ store: "OS" })).toBeNull();
    expect(parseKeyStorageDeclaration({ store: "os keychain" })).toBeNull();
    expect(parseKeyStorageDeclaration({ store: "<script>" })).toBeNull();
    expect(parseKeyStorageDeclaration({ store: "x".repeat(33) })).toBeNull();
    expect(parseKeyStorageDeclaration({ store: "" })).toBeNull();
    expect(parseKeyStorageDeclaration({ store: 1 })).toBeNull();
    expect(parseKeyStorageDeclaration("os")).toBeNull();
    expect(parseKeyStorageDeclaration(null)).toBeNull();
    expect(parseKeyStorageDeclaration(undefined)).toBeNull();
  });
});

function fakeRedis() {
  const store = new Map<string, string>();
  const ttl = new Map<string, number>();
  return {
    store,
    ttl,
    async set(key: string, value: string, options?: { ex?: number }) {
      store.set(key, value);
      if (options?.ex) ttl.set(key, options.ex);
      return "OK";
    },
    async get(key: string) {
      const raw = store.get(key);
      // The Upstash client JSON.parses every response, so a value written as
      // JSON text comes back as an object. Reproduce that, not a nicer world.
      return raw === undefined ? null : JSON.parse(raw);
    },
  };
}

describe("recording and reading a declaration", () => {
  it("stores the declaration under one bounded TTL and reads it back", async () => {
    const r = fakeRedis();
    await recordDeclaredKeyStorage(r as never, "agent-1", { store: "os", fallback: false }, 1_000);
    expect(r.ttl.get("keystorage:agent-1")).toBe(PASSPORT_KEY_STORAGE_TTL_SECONDS);
    expect(await readDeclaredKeyStorage(r as never, "agent-1")).toEqual({
      store: "os",
      fallback: false,
      declaredAt: new Date(1_000).toISOString(),
    });
  });

  it("reads null when nothing was ever declared", async () => {
    const r = fakeRedis();
    expect(await readDeclaredKeyStorage(r as never, "agent-1")).toBeNull();
  });

  // Eviction on a free-tier Redis, a half-written value, a shape from a build
  // that has been rolled back: none of them is "this key sits in a file".
  it("reads null rather than throwing on a value it cannot parse", async () => {
    const r = fakeRedis();
    r.store.set("keystorage:agent-1", JSON.stringify({ store: "OS", at: "yesterday" }));
    expect(await readDeclaredKeyStorage(r as never, "agent-1")).toBeNull();
    r.store.set("keystorage:agent-2", JSON.stringify("os"));
    expect(await readDeclaredKeyStorage(r as never, "agent-2")).toBeNull();
  });

  it("never lets an unreachable Redis reach the caller", async () => {
    const broken = {
      get: vi.fn(async () => {
        throw new Error("redis down");
      }),
    };
    await expect(readDeclaredKeyStorage(broken as never, "agent-1")).resolves.toBeNull();
  });
});

describe("what the dashboard is allowed to say", () => {
  const at = "2026-09-01T10:00:00.000Z";

  it("names the tier for a store it knows, and never claims it was checked", () => {
    const view = toDeclaredKeyStorageView(
      { store: "os", fallback: false, declaredAt: at },
      null
    );
    expect(view).toMatchObject({ state: "declared", store: "os", tier: 1, verified: false });
    expect(view.dataState).toBe("os");
  });

  it("gives tier 0 its own state rather than folding it in with silence", () => {
    const view = toDeclaredKeyStorageView(
      { store: "file", fallback: false, declaredAt: at },
      null
    );
    expect(view).toMatchObject({ state: "declared", store: "file", tier: 0 });
    expect(view.dataState).toBe("file");
  });

  // The operator believes they are on tier 1 and they are not. This is the one
  // state here worth an alert.
  it("surfaces a silent fall back to the file", () => {
    const view = toDeclaredKeyStorageView(
      { store: "file", fallback: true, declaredAt: at },
      null
    );
    expect(view).toMatchObject({ state: "declared", store: "file", tier: 0, fellBack: true });
  });

  it("reports an unrecognised store as unrecognised, with no tier", () => {
    const view = toDeclaredKeyStorageView(
      { store: "enclave", fallback: false, declaredAt: at },
      null
    );
    expect(view).toMatchObject({ state: "unrecognised", store: "enclave" });
    expect(view.dataState).toBe("unknown");
    expect(view).not.toHaveProperty("tier");
  });

  // Absence has four causes and none of them is tier 0. Rendering silence as a
  // file key would be this panel telling the exact lie it was built to stop.
  it("refuses to read absence as a file key", () => {
    const view = toDeclaredKeyStorageView(null, null);
    expect(view.state).toBe("undeclared");
    expect(view.dataState).toBe("undeclared");
    expect(view).not.toHaveProperty("tier");
  });

  // A declaration is only as fresh as the mint that carried it. An agent that
  // has authenticated since without declaring must not keep showing a stale
  // tier as if it were current.
  it("marks a declaration older than the agent's latest activity", () => {
    const stale = toDeclaredKeyStorageView(
      { store: "os", fallback: false, declaredAt: at },
      "2026-09-01T14:00:00.000Z"
    );
    expect(stale).toMatchObject({ state: "declared", supersededByLaterActivity: true });

    const fresh = toDeclaredKeyStorageView(
      { store: "os", fallback: false, declaredAt: at },
      "2026-09-01T10:20:00.000Z"
    );
    expect(fresh).toMatchObject({ supersededByLaterActivity: false });
  });

  // last_seen_at lags by up to a day behind the reconcile flush, so it can only
  // ever be older than the truth. That direction is safe — it under-reports
  // staleness — but activity BEFORE the declaration must never flag it.
  it("does not treat earlier activity as superseding", () => {
    expect(
      toDeclaredKeyStorageView(
        { store: "os", fallback: false, declaredAt: at },
        "2026-08-30T09:00:00.000Z"
      ).supersededByLaterActivity
    ).toBe(false);
  });
});

// The fleet table needs a claim for every passport agent on the page. Doing
// that with one `get` per row would put a Redis round trip behind each line of
// a table that already exists to be scanned quickly, so it is one `mget`.
describe("reading every declaration for a page of agents", () => {
  function fakeMgetRedis(seed: Record<string, unknown>) {
    const calls: string[][] = [];
    return {
      calls,
      async mget(...keys: string[]) {
        calls.push(keys);
        // Upstash accepts a spread OR a single array, and JSON.parses each hit.
        const flat = keys.length === 1 && Array.isArray(keys[0]) ? (keys[0] as unknown as string[]) : keys;
        return flat.map((key) => (key in seed ? seed[key] : null));
      },
    };
  }

  it("fetches every agent in one round trip and keys the result by agent id", async () => {
    const r = fakeMgetRedis({
      "keystorage:a": { store: "os", fallback: false, at: "2026-09-01T10:00:00.000Z" },
      "keystorage:c": { store: "file", fallback: true, at: "2026-09-01T11:00:00.000Z" },
    });
    const found = await readDeclaredKeyStorageMany(r as never, ["a", "b", "c"]);
    expect(r.calls).toHaveLength(1);
    expect(found).toEqual({
      a: { store: "os", fallback: false, declaredAt: "2026-09-01T10:00:00.000Z" },
      c: { store: "file", fallback: true, declaredAt: "2026-09-01T11:00:00.000Z" },
    });
    // Absence from the map is the ONLY way an agent reads as undeclared. There
    // is no null entry to be mistaken for a declaration of nothing.
    expect("b" in found).toBe(false);
  });

  // Upstash throws on a zero-key MGET, and a workspace whose agents are all
  // Direct Agent Keys sends exactly that.
  it("never calls Redis for an empty list", async () => {
    const r = fakeMgetRedis({});
    expect(await readDeclaredKeyStorageMany(r as never, [])).toEqual({});
    expect(r.calls).toHaveLength(0);
  });

  it("asks for each agent once even if the caller repeats one", async () => {
    const r = fakeMgetRedis({});
    await readDeclaredKeyStorageMany(r as never, ["a", "a", "b"]);
    expect(r.calls[0]).toEqual(["keystorage:a", "keystorage:b"]);
  });

  // Same rule as the single read: a value this build cannot parse is silence,
  // never tier 0, and never an error on a page about somebody's fleet.
  it("drops what it cannot parse and survives an unreachable Redis", async () => {
    const r = fakeMgetRedis({
      "keystorage:a": { store: "OS", at: "yesterday" },
      "keystorage:b": { store: "os", fallback: false, at: "2026-09-01T10:00:00.000Z" },
    });
    expect(await readDeclaredKeyStorageMany(r as never, ["a", "b"])).toEqual({
      b: { store: "os", fallback: false, declaredAt: "2026-09-01T10:00:00.000Z" },
    });

    const broken = {
      mget: vi.fn(async () => {
        throw new Error("redis down");
      }),
    };
    await expect(readDeclaredKeyStorageMany(broken as never, ["a"])).resolves.toEqual({});
  });

  it("accepts a JSON string as readily as a parsed object", async () => {
    const r = fakeMgetRedis({
      "keystorage:a": JSON.stringify({ store: "os", fallback: false, at: "2026-09-01T10:00:00.000Z" }),
    });
    expect(await readDeclaredKeyStorageMany(r as never, ["a"])).toEqual({
      a: { store: "os", fallback: false, declaredAt: "2026-09-01T10:00:00.000Z" },
    });
  });
});

describe("naming the tier a store means", () => {
  it("answers for the stores this build knows and withholds an answer otherwise", () => {
    expect(storeTier("file")).toBe(0);
    expect(storeTier("os")).toBe(1);
    expect(storeTier("enclave")).toBeUndefined();
  });
});
