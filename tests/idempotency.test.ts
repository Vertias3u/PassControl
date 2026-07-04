import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory Redis with SET NX semantics.
const { store } = vi.hoisted(() => ({ store: new Map<string, unknown>() }));
const r = {
  set: vi.fn(async (k: string, v: unknown, opts?: { nx?: boolean }) => {
    if (opts?.nx && store.has(k)) return null;
    store.set(k, v);
    return "OK";
  }),
  get: vi.fn(async (k: string) => store.get(k) ?? null),
  del: vi.fn(async (k: string) => (store.delete(k) ? 1 : 0)),
};
vi.mock("@/lib/state/redis", () => ({ redis: () => r }));

import { runIdempotent, normalizeIdemKey } from "@/lib/control/idempotency";

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
});

describe("normalizeIdemKey", () => {
  it("strips control chars, bounds length, rejects empty", () => {
    expect(normalizeIdemKey("  abc\r\n  ")).toBe("abc");
    expect(normalizeIdemKey("")).toBeNull();
    expect(normalizeIdemKey("x".repeat(201))).toBeNull();
  });
});

describe("runIdempotent", () => {
  it("runs the handler once and replays the cached response on retry", async () => {
    let n = 0;
    const exec = async () => {
      n++;
      return new Response(JSON.stringify({ id: "a1" }), { status: 201, headers: { "content-type": "application/json" } });
    };
    const r1 = await runIdempotent("key1", "idem1", "req1", exec);
    const r2 = await runIdempotent("key1", "idem1", "req2", exec);

    expect(n).toBe(1); // executed exactly once
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(await r1.text()).toBe('{"id":"a1"}');
    expect(await r2.text()).toBe('{"id":"a1"}');
    expect(r2.headers.get("idempotent-replay")).toBe("true");
  });

  it("returns 409 while the original request is still in flight", async () => {
    store.set("idem:key1:idem1", "pending"); // claimed but not yet completed
    const res = await runIdempotent("key1", "idem1", "req", async () => new Response("x"));
    expect(res.status).toBe(409);
  });

  it("does not cache a 5xx; a later retry re-runs", async () => {
    let n = 0;
    const exec = async () => {
      n++;
      return new Response("err", { status: 500 });
    };
    await runIdempotent("key1", "idem1", "r1", exec);
    await runIdempotent("key1", "idem1", "r2", exec);
    expect(n).toBe(2); // transient failure was not cached
  });

  it("scopes the cache key by the API key (no cross-key collision)", async () => {
    const exec = async () => new Response(JSON.stringify({ v: 1 }), { status: 200 });
    await runIdempotent("keyA", "same", "r", exec);
    expect(store.has("idem:keyA:same")).toBe(true);
    expect(store.has("idem:keyB:same")).toBe(false);
  });
});
