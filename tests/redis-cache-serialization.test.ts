// What the Upstash client actually hands back, and why these getters must
// normalise it.
//
// `@upstash/redis` serialises a STRING by passing it through unchanged
// (`defaultSerializer`), then deserialises every response with `JSON.parse`
// (`parseRecursive`). So a value written as JSON text — which is every cache in
// lib/state/redis.ts that holds a structure — comes back as a PARSED OBJECT,
// not as the `string` the getters declare. `redis().get<string>(…)` is a type
// assertion, not a runtime coercion, so nothing catches the difference.
//
// Every consumer then does `JSON.parse(cached)`. Against an object that throws
// (`JSON.parse("[object Object]")`), and each consumer's catch branch treats the
// failure as "the cached value is malformed":
//
//   lib/state/policy.ts      → returns the {p,s} WRAPPER as the policy, which
//                              parsePolicy rejects → `policy:malformed` → the
//                              proxy fails closed → 403 blocked_policy
//   lib/state/fallbacks.ts   → []    (failover silently never fires)
//   lib/owner/current.ts     → null  (receipts lose the owner claim)
//   lib/providers/available  → []
//
// The proxy suites never saw this because they mock `getCachedAgentPolicy` as
// resolving a STRING — the same wrong assumption the type makes. So this test
// sits BELOW the getter and drives the real client through a stubbed REST
// endpoint. A mock at the getter seam would inherit the blind spot it exists to
// catch.
//
// Found in production on 2026-08-16: an agent with no policy configured at all
// was refused for the length of every 60-second cache window, clearing only on
// the miss that re-read Postgres.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@vercel/functions", () => ({ waitUntil: (p: unknown) => p }));

process.env.UPSTASH_REDIS_REST_URL = "https://stub.upstash.io";
process.env.UPSTASH_REDIS_REST_TOKEN = "stub-token";

/** Byte-for-byte what SET put on the wire, keyed as Redis would key it. */
const store = new Map<string, string>();

/**
 * A stand-in for the Upstash REST endpoint that stores exactly what it is sent
 * and returns exactly what it stored. It deliberately models nothing else: the
 * behaviour under test belongs to the client's serialise/deserialise pair, and
 * a fake that "helpfully" parsed or re-encoded would hide it.
 */
const stubFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
  const body: unknown = JSON.parse(String(init?.body ?? "[]"));
  const batched = Array.isArray(body) && Array.isArray(body[0]);
  const commands = (batched ? body : [body]) as string[][];
  const results = commands.map((command) => {
    const [verb, key, value] = command;
    if (verb === "set") {
      store.set(key as string, value as string);
      return { result: "OK" };
    }
    if (verb === "get") return { result: store.get(key as string) ?? null };
    if (verb === "del") {
      store.delete(key as string);
      return { result: 1 };
    }
    // The policy, endpoint and key caches all fill through a conditional Lua
    // eval, because a plain SET republishes a snapshot taken before an
    // invalidation (S3-01/S3-02). The wire shape is
    // ["eval", script, numkeys, ...keys, ...argv] — two keys here, the value key
    // and the fence key — so the value is args[5], not args[4].
    //
    // THIS STUB TAKES THE PUBLISH BRANCH UNCONDITIONALLY, AND THAT IS NOT A
    // TEST OF THE FENCE. It models exactly one thing: the value that ends up
    // stored is byte-for-byte the value that was sent, which is what this file
    // is about. The condition itself runs as real Lua against a real Redis in
    // `tests/cache-fence.redis.test.ts` — a file that exists because the last
    // fence shipped broken behind a stub just like this one, and a comment here
    // claiming coverage that lived nowhere is part of how that happened.
    if (verb === "eval") {
      // THIS command's arguments, not the batch's first. The client auto-pipelines,
      // so a fire-and-forget fill can share a batch with the next call's GET; reading
      // commands[0] there stored the fill under the GET's arguments instead.
      const args = command as string[];
      const [evalKey, evalValue] = [args[3] ?? "", args[5] ?? ""];
      store.set(evalKey, evalValue);
      return { result: 1 };
    }
    throw new Error(`unstubbed Redis command: ${verb}`);
  });
  // The client asks for base64 results (`Upstash-Encoding: base64`, its
  // default) and base64-DECODES every string it gets back. A stub that answers
  // in plain text is not the real wire, and the difference is not cosmetic:
  // a plain `null` is valid base64, so it decoded to garbage that read as a
  // cache HIT — which hid the owner cache's every-call miss until a live
  // MONITOR showed it (2026-10-03). Values holding `{` are not valid base64
  // and fell through untouched, which is why the other cases never noticed.
  const headers = new Headers(init?.headers);
  if (headers.get("upstash-encoding")?.toLowerCase() === "base64") {
    for (const entry of results) {
      const { result } = entry as { result: unknown };
      if (typeof result === "string" && result !== "OK") {
        (entry as { result: unknown }).result = Buffer.from(result, "utf8").toString("base64");
      }
    }
  }
  return new Response(JSON.stringify(batched ? results : results[0]), {
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

vi.stubGlobal("fetch", stubFetch);

const {
  getCachedAgentPolicy,
  setCachedAgentPolicy,
  getCachedAgentFallbacks,
  setCachedAgentFallbacks,
  getCachedOwner,
  setCachedOwner,
  getCachedProviderKeys,
  setCachedProviderKeys,
  getCachedKey,
  setCachedKey,
} = await import("@/lib/state/redis");
const { readCurrentAgentPolicyAndShadow } = await import("@/lib/state/policy");
const { readCurrentAgentFallbacks } = await import("@/lib/state/fallbacks");
const { readCurrentOwner } = await import("@/lib/owner/current");
const { readProvidersWithKeys } = await import("@/lib/providers/available");
const { policyIsWellFormed } = await import("@/lib/scope");

/** Every read below must be satisfied by the cache alone. */
const unreachableDb = {
  from: () => {
    throw new Error("the cached entry must satisfy this read");
  },
};

beforeEach(() => {
  store.clear();
});

describe("cache getters return the string they promise", () => {
  // Each case writes what its own setter writes in production, so the round
  // trip under test is the real one rather than a representative one.
  // `write` returns whatever its setter returns — the fenced fills answer with
  // whether they published. Nothing here reads it; the round trip is the subject.
  const roundTrips: { name: string; write: () => Promise<unknown>; read: () => Promise<string | null> }[] = [
    {
      name: "agent policy",
      write: () => setCachedAgentPolicy("u1", "a1", JSON.stringify({ p: {}, s: null })),
      read: () => getCachedAgentPolicy("u1", "a1"),
    },
    {
      name: "agent fallbacks",
      write: () =>
        setCachedAgentFallbacks("u1", "a1", JSON.stringify([{ provider: "groq", model: "llama-3.1-8b" }])),
      read: () => getCachedAgentFallbacks("u1", "a1"),
    },
    {
      name: "owner claim",
      write: () => setCachedOwner("u1", JSON.stringify({ kind: "person", subject: "someone" })),
      read: () => getCachedOwner("u1"),
    },
    {
      name: "provider keys",
      write: () => setCachedProviderKeys("u1", JSON.stringify(["openai", "anthropic"])),
      read: () => getCachedProviderKeys("u1"),
    },
  ];

  for (const { name, write, read } of roundTrips) {
    it(`${name}: a JSON value comes back as a string, not a parsed object`, async () => {
      await write();
      const cached = await read();
      expect(typeof cached).toBe("string");
      // The contract every consumer relies on: JSON.parse(cached) must not throw.
      expect(() => JSON.parse(cached as string)).not.toThrow();
    });
  }

  it("ciphertext is returned untouched", async () => {
    // The provider-key cache holds an AES-GCM blob, which is not valid JSON and
    // so survived this bug. It must keep surviving the fix: re-encoding it would
    // break the one cache that actually guards a credential.
    const sealed = "v1.YWJjZGVmZ2hpamtsbW5vcA.c2VhbGVkLWNpcGhlcnRleHQ";
    await setCachedKey("a1", "openai", sealed);
    expect(await getCachedKey("a1", "openai")).toBe(sealed);
  });

  it("a digit-only value is not silently turned into a number", async () => {
    // parseRecursive returns a real number for "12345". A caller that declared
    // `string` would hand a number to a decrypt path.
    await setCachedKey("a1", "groq", "12345");
    expect(await getCachedKey("a1", "groq")).toBe("12345");
  });

  it("a cache miss is null, not the string \"null\"", async () => {
    expect(await getCachedAgentPolicy("u1", "absent")).toBeNull();
  });
});

describe("an agent with no policy is not refused by its own cache", () => {
  it("reads an allowing policy out of the cache, without touching the database", async () => {
    // Exactly what the previous request's cache-miss branch stored for an agent
    // whose `policy` column is the `{}` default.
    await setCachedAgentPolicy("u1", "a1", JSON.stringify({ p: {}, s: null }));

    const { policy, shadow } = await readCurrentAgentPolicyAndShadow(unreachableDb, "u1", "a1");

    // The regression handed the gate the {p,s} wrapper. parsePolicy rejects it,
    // which the proxy reads as `policy:malformed` and refuses with 403.
    expect(policy).toEqual({});
    expect(shadow).toBeNull();
    expect(policyIsWellFormed(policy)).toBe(true);
  });

  it("carries a shadow candidate through without letting it decide anything", async () => {
    const live = { deny: [{ provider: "openai", models: ["gpt-4o"] }] };
    const candidate = { max_requests_per_hour: 10 };

    await setCachedAgentPolicy("u1", "a2", JSON.stringify({ p: live, s: candidate }));

    const { policy, shadow } = await readCurrentAgentPolicyAndShadow(unreachableDb, "u1", "a2");
    expect(policy).toEqual(live);
    expect(shadow).toEqual(candidate);
  });
});

// The policy cache is the one that refused traffic, but all four share the root
// cause, so all four are pinned. Each of these silently degraded a shipped
// feature rather than erroring: a catch branch returning [] or null looks
// exactly like "nothing configured".
describe("the other cached readers survive their own round trip", () => {
  it("failover reads its configured targets, not an empty list", async () => {
    const entries = [
      { provider: "groq", model: "llama-3.1-8b-instant" },
      { provider: "openai", model: "gpt-4o-mini" },
    ];
    await setCachedAgentFallbacks("u1", "a1", JSON.stringify(entries));
    expect(await readCurrentAgentFallbacks(unreachableDb, "u1", "a1")).toEqual(entries);
  });

  it("a receipt's owner claim survives the cache", async () => {
    await setCachedOwner(
      "u1",
      JSON.stringify({
        kind: "person",
        subject: "someone@example.com",
        tier: "domain",
        verified_at: "2026-01-01T00:00:00Z",
      })
    );
    expect(await readCurrentOwner(unreachableDb, "u1")).toEqual({
      kind: "person",
      sub: "someone@example.com",
      tier: "domain",
      vat: "2026-01-01T00:00:00Z",
    });
  });

  it("a tenant with no published owner is served from the cache, not re-read every call", async () => {
    // The common case: no owner row. The miss branch caches that absence on
    // purpose ("should not cost a database read on every single proxied call"),
    // but it cached JSON `null`, which the client parses back to null — a miss.
    // So every proxied call re-queried agent_owners and re-filled the key
    // (measured 2026-10-03: one SELECT and four Redis commands per call).
    //
    // `unreachableDb` cannot catch this: readCurrentOwner turns ANY failure
    // into null, so a throwing database and a cache hit look identical from
    // outside. Count the reads instead.
    let reads = 0;
    const emptyDb = {
      from: () => {
        reads++;
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: async () => ({ data: null, error: null }),
        };
        return chain;
      },
    } as unknown as Parameters<typeof readCurrentOwner>[0];

    expect(await readCurrentOwner(emptyDb, "u-none")).toBeNull();
    expect(await readCurrentOwner(emptyDb, "u-none")).toBeNull();
    expect(await readCurrentOwner(emptyDb, "u-none")).toBeNull();
    expect(reads).toBe(1);
  });

  it("the provider list survives the cache", async () => {
    await setCachedProviderKeys("u1", JSON.stringify(["openai", "anthropic"]));
    expect(await readProvidersWithKeys(unreachableDb, "u1")).toEqual(["openai", "anthropic"]);
  });
});
