import { describe, it, expect, vi, beforeEach } from "vitest";

const authMock = vi.fn();
const rlMock = vi.fn();
vi.mock("@/lib/control/auth", () => ({ authenticateApiKey: (...a: any[]) => authMock(...a) }));
vi.mock("@/lib/ratelimit", () => ({ rateLimit: (...a: any[]) => rlMock(...a) }));
vi.mock("@/lib/supabase", () => ({ serviceClient: () => ({ tag: "db" }) }));

import { control } from "@/lib/control/handler";

const req = () =>
  new Request("https://x/api/control/v1/agents", { headers: { authorization: "Bearer pc_" + "a".repeat(40) } });

beforeEach(() => {
  authMock.mockReset();
  rlMock.mockReset();
  rlMock.mockResolvedValue({ success: true, remaining: 1 });
});

describe("control() wrapper", () => {
  it("propagates auth failure with the error model + a request id", async () => {
    authMock.mockResolvedValue({ ok: false, status: 401, code: "missing_api_key" });
    const res = await control("read", async () => new Response("x"))(req());
    expect(res.status).toBe(401);
    expect(res.headers.get("x-request-id")).toBeTruthy();
    const body = await res.json();
    expect(body.error.code).toBe("missing_api_key");
    expect(body.error.request_id).toBeTruthy();
  });

  it("rejects a read key on a write endpoint (403) and never runs the handler", async () => {
    authMock.mockResolvedValue({ ok: true, userId: "u1", scope: "read", keyId: "k1" });
    const fn = vi.fn(async () => new Response("nope"));
    const res = await control("write", fn)(req());
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("insufficient_scope");
    expect(fn).not.toHaveBeenCalled();
  });

  it("rejects a flood with a PRE-AUTH IP rate limit (429, no key lookup)", async () => {
    rlMock.mockResolvedValueOnce({ success: false, remaining: 0 }); // IP limit tripped first
    const res = await control("read", async () => new Response("x"))(req());
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(authMock).not.toHaveBeenCalled(); // never reached the DB auth lookup
  });

  it("returns 429 + Retry-After when the per-key limit is hit (after auth)", async () => {
    authMock.mockResolvedValue({ ok: true, userId: "u1", scope: "write", keyId: "k1" });
    rlMock.mockResolvedValueOnce({ success: true, remaining: 1 }); // IP ok
    rlMock.mockResolvedValueOnce({ success: false, remaining: 0 }); // per-key tripped
    const res = await control("read", async () => new Response("x"))(req());
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(authMock).toHaveBeenCalled();
  });

  it("runs the handler with an authenticated, userId-bearing ctx on success", async () => {
    authMock.mockResolvedValue({ ok: true, userId: "u1", scope: "write", keyId: "k1" });
    let seen: any;
    const res = await control("read", async (ctx) => {
      seen = ctx;
      return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
    })(req());
    expect(res.status).toBe(200);
    expect(seen).toMatchObject({ userId: "u1", scope: "write", keyId: "k1", db: { tag: "db" } });
  });

  it("a write key may call read endpoints", async () => {
    authMock.mockResolvedValue({ ok: true, userId: "u1", scope: "write", keyId: "k1" });
    const res = await control("read", async () => new Response("ok"))(req());
    expect(res.status).toBe(200);
  });

  it("awaits dynamic route params into ctx", async () => {
    authMock.mockResolvedValue({ ok: true, userId: "u1", scope: "read", keyId: "k1" });
    let seen: any;
    await control("read", async (ctx) => {
      seen = ctx.params;
      return new Response("ok");
    })(req(), { params: Promise.resolve({ id: "abc" }) });
    expect(seen).toEqual({ id: "abc" });
  });
});
