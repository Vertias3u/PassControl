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
    const r1 = await runIdempotent("key1", "idem1", "req1", exec, "same-fingerprint");
    const r2 = await runIdempotent("key1", "idem1", "req2", exec, "same-fingerprint");

    expect(n).toBe(1); // executed exactly once
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(await r1.text()).toBe('{"id":"a1"}');
    expect(await r2.text()).toBe('{"id":"a1"}');
    expect(r2.headers.get("idempotent-replay")).toBe("true");
  });

  it("returns 409 while the original request is still in flight", async () => {
    store.set("idem:key1:idem1", "pending"); // claimed but not yet completed
    const res = await runIdempotent("key1", "idem1", "req", async () => new Response("x"), "same-fingerprint");
    expect(res.status).toBe(409);
  });

  it("does not cache a 5xx; a later retry re-runs", async () => {
    let n = 0;
    const exec = async () => {
      n++;
      return new Response("err", { status: 500 });
    };
    await runIdempotent("key1", "idem1", "r1", exec, "same-fingerprint");
    await runIdempotent("key1", "idem1", "r2", exec, "same-fingerprint");
    expect(n).toBe(2); // transient failure was not cached
  });

  it("scopes the cache key by the API key (no cross-key collision)", async () => {
    const exec = async () => new Response(JSON.stringify({ v: 1 }), { status: 200 });
    await runIdempotent("keyA", "same", "r", exec, "same-fingerprint");
    expect(store.has("idem:keyA:same")).toBe(true);
    expect(store.has("idem:keyB:same")).toBe(false);
  });
});

// Exercise the real wrapper too: it must hash the request before exec consumes it.
const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/control/auth", () => ({ authenticateApiKey: authMock }));
vi.mock("@/lib/ratelimit", () => ({ rateLimit: async () => ({ success: true }) }));
vi.mock("@/lib/supabase", () => ({ serviceClient: () => ({}) }));
import { control } from "@/lib/control/handler";
import { createHash } from "node:crypto";

const fingerprint = (method: string, path: string, body: string) =>
  createHash("sha256").update([method, path, body].join("\n")).digest("hex");

describe("request-bound idempotency", () => {
  it.each([
    ["body", "POST", "/agents?x=1", '{"a":2}'],
    ["path", "POST", "/kill?x=1", '{"a":1}'],
    ["search", "POST", "/agents?x=2", '{"a":1}'],
    ["method", "DELETE", "/agents?x=1", '{"a":1}'],
  ])("rejects reuse with a different %s", async (_, method, path, body) => {
    authMock.mockResolvedValue({ ok: true, userId: "u1", scope: "write", keyId: "key1" });
    const exec = vi.fn(async ({ req }: { req: Request }) => new Response(await req.text()));
    const handler = control("write", exec);
    const request = (method: string, path: string, body: string) => new Request(`https://x${path}`, {
      method, body, headers: { "idempotency-key": "idem1" },
    });
    const first = await handler(request("POST", "/agents?x=1", '{"a":1}'));
    expect(await first.text()).toBe('{"a":1}');
    const replay = await handler(request("POST", "/agents?x=1", '{"a":1}'));
    expect(replay.headers.get("idempotent-replay")).toBe("true");
    const mismatch = await handler(request(method, path, body));
    expect(mismatch.status).toBe(422);
    expect((await mismatch.json()).error.code).toBe("idempotency_key_reused");
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("stores SHA-256 of method, pathname plus search, and the unchanged body", async () => {
    authMock.mockResolvedValue({ ok: true, userId: "u1", scope: "write", keyId: "key1" });
    const handler = control("write", async ({ req }) => new Response(await req.text()));
    await handler(new Request("https://x/agents?x=1", {
      method: "POST", body: "body", headers: { "idempotency-key": "idem1" },
    }));
    expect(store.get("idem:key1:idem1")).toMatchObject({ fp: fingerprint("POST", "/agents?x=1", "body") });
  });

  it("returns 409 for a matching pending claim and 422 for a different request", async () => {
    let release!: (r: Response) => void;
    const exec = vi.fn(() => new Promise<Response>(resolve => { release = resolve; }));
    const first = runIdempotent("key1", "idem1", "r1", exec, "fp1");
    await Promise.resolve();
    const same = await runIdempotent("key1", "idem1", "r2", exec, "fp1");
    const different = await runIdempotent("key1", "idem1", "r3", exec, "fp2");
    release(new Response("ok"));
    await first;
    expect(same.status).toBe(409);
    expect(different.status).toBe(422);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it.each(["pending", { status: 201, body: "legacy" }])("preserves recognised legacy records: %j", async legacy => {
    store.set("idem:key1:idem1", legacy);
    const res = await runIdempotent("key1", "idem1", "r", async () => new Response("unused"), "fp");
    expect(res.status).toBe(typeof legacy === "string" ? 409 : 201);
  });

  it("rejects unrecognised records without a fingerprint", async () => {
    store.set("idem:key1:idem1", { unknown: true });
    const res = await runIdempotent("key1", "idem1", "r", async () => new Response("unused"), "fp");
    expect(res.status).toBe(422);
  });

  it.each([true, false])("bounds the fingerprint read to 64 KiB (declared length: %s)", async declared => {
    authMock.mockResolvedValue({ ok: true, userId: "u1", scope: "write", keyId: "key1" });
    const exec = vi.fn(async () => new Response("ok"));
    const res = await control("write", exec)(new Request("https://x/agents", {
      method: "POST", body: "x".repeat(65537),
      headers: { "idempotency-key": "idem1", ...(declared ? { "content-length": "65537" } : {}) },
    }));
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe("payload_too_large");
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("what a deployment still running the old code sees (CP6 rollout)", () => {
  it("stores the in-flight claim as a string, which old code answers with 409", async () => {
    let release!: (r: Response) => void;
    const first = runIdempotent("key1", "idem1", "r1", () => new Promise<Response>((r) => { release = r; }), "fp1");
    await Promise.resolve();
    const claim = store.get("idem:key1:idem1");
    // The old reader replayed ANY object as a finished response: status undefined, empty body.
    expect(typeof claim).toBe("string");
    expect(claim).toBe("pending:fp1");
    release(new Response("ok"));
    await first;
  });

  it("answers 409, not 422, when the claim vanished between the claim and the read", async () => {
    store.set("idem:key1:idem1", "pending:other");
    r.get.mockResolvedValueOnce(null);
    const res = await runIdempotent("key1", "idem1", "r", async () => new Response("unused"), "fp");
    expect(res.status).toBe(409);
  });
});

describe("the control wrapper runs on the edge runtime", () => {
  it("imports no Node built-in", async () => {
    const { readFileSync } = await import("node:fs");
    for (const f of ["lib/control/handler.ts", "lib/control/idempotency.ts"]) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/from\s+["']node:/u);
    }
  });
});
