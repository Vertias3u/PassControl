// The two device-flow endpoints, exercised directly.
//
// These are the unauthenticated credential edge. They sit OUTSIDE
// /api/control/v1/ because `control()` requires the key they exist to hand out,
// and `middleware.ts` excludes /api/* — so their own limiters and status mapping
// are the entire perimeter. Nothing upstream is checking them.
//
// tests/cli-login.test.ts drives a STUB gateway, which means it never executes a
// line of these files. This is the only coverage they have.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  limitMock: vi.fn(async (..._a: unknown[]) => ({ success: true, remaining: 10, unreadable: false })),
  started: [] as unknown[],
  status: null as string | null,
  grant: null as string | null,
  taken: 0,
}));

vi.mock("@/lib/ratelimit", () => ({
  rateLimitFailClosed: (...a: unknown[]) => h.limitMock(...a),
}));

vi.mock("@/lib/state/device-auth", () => ({
  DEVICE_CODE_TTL_S: 600,
  startDeviceAuthorization: async (input: unknown) => {
    h.started.push(input);
  },
  readDeviceStatus: async () => h.status,
  takeDeviceGrant: async () => {
    h.taken += 1;
    const value = h.grant;
    h.grant = null;
    return value;
  },
}));

vi.mock("@/lib/crypto/aesgcm", () => ({
  open: async (sealed: string) => sealed,
  seal: async (plain: string) => plain,
}));

import { POST as startRoute } from "@/app/api/auth/device/start/route";
import { POST as tokenRoute } from "@/app/api/auth/device/token/route";

beforeEach(() => {
  h.limitMock.mockReset();
  h.limitMock.mockResolvedValue({ success: true, remaining: 10, unreadable: false });
  h.started.length = 0;
  h.status = null;
  h.grant = null;
  h.taken = 0;
});

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const GOOD_DEVICE_CODE = "d".repeat(43);
const validGrant = () =>
  JSON.stringify({
    version: 1,
    userId: "user-1",
    token: `pc_${"k".repeat(43)}`,
    prefix: "pc_kkkkkkkk",
    expiresAt: Date.now() + 60_000,
  });

describe("POST /api/auth/device/start", () => {
  it("mints BOTH codes server-side", async () => {
    // A client-chosen user_code is the whole threat model in one field: pick a
    // code, phish an operator into approving it, collect their key.
    const res = await startRoute(
      post("https://gw.example/api/auth/device/start", { client_name: "laptop", user_code: "AAAAAAAA" })
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.user_code).not.toBe("AAAAAAAA");
    expect(body.user_code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{8}$/u);
    expect(body.device_code).not.toBe(body.user_code);
  });

  it("advertises an approval URL with no fragment and no query", async () => {
    const res = await startRoute(post("https://gw.example/api/auth/device/start", {}));
    const { verification_uri: uri } = await res.json();
    expect(uri).toBe("https://gw.example/dashboard/cli");
    expect(uri).not.toContain("#");
    expect(uri).not.toContain("?");
  });

  it("never returns the device code in the browser-facing URL", async () => {
    const res = await startRoute(post("https://gw.example/api/auth/device/start", {}));
    const body = await res.json();
    expect(body.verification_uri).not.toContain(body.device_code);
    expect(body.verification_uri).not.toContain(body.user_code);
  });

  it("refuses when the limiter fails CLOSED", async () => {
    // rateLimitFailClosed returns success:false when Redis is unreadable. An
    // unauthenticated code-minting endpoint must not degrade into an unmetered
    // one, and since the flow cannot complete without Redis anyway, refusing
    // costs a legitimate caller nothing real.
    h.limitMock.mockResolvedValue({ success: false, remaining: 0, unreadable: true });
    const res = await startRoute(post("https://gw.example/api/auth/device/start", {}));
    expect(res.status).toBe(429);
    expect(h.started, "nothing may be written when the limiter refuses").toHaveLength(0);
  });

  it("strips a client name that dresses itself up as chrome", async () => {
    // This string is rendered next to an Approve button. The risk is not script
    // injection — React escapes — it is punctuation that makes an attacker's
    // device look like part of the product.
    await startRoute(
      post("https://gw.example/api/auth/device/start", {
        client_name: "Chrome — ✅ verified by PassControl <official>",
      })
    );
    const name = (h.started[0] as { clientName: string }).clientName;
    expect(name).not.toMatch(/[—✅<>]/u);
    // Runs collapse too: a long gap is the same visual trick as the punctuation.
    expect(name).toBe("Chrome verified by PassControl official");
    expect(name).not.toMatch(/\s{2,}/u);
  });

  it("caps the client name and falls back rather than storing an empty one", async () => {
    await startRoute(post("https://gw.example/api/auth/device/start", { client_name: "𝕏".repeat(50) }));
    expect((h.started[0] as { clientName: string }).clientName).toBe("unknown device");
    h.started.length = 0;
    await startRoute(post("https://gw.example/api/auth/device/start", { client_name: "a".repeat(500) }));
    expect((h.started[0] as { clientName: string }).clientName.length).toBeLessThanOrEqual(60);
  });

  it("rejects a non-JSON content type and an oversized body", async () => {
    const wrongType = await startRoute(
      post("https://gw.example/api/auth/device/start", {}, { "content-type": "text/plain" })
    );
    expect(wrongType.status).toBe(415);
    const huge = await startRoute(
      post("https://gw.example/api/auth/device/start", JSON.stringify({ client_name: "x".repeat(9000) }))
    );
    expect(huge.status).toBe(413);
  });
});

describe("POST /api/auth/device/token", () => {
  it("maps every state to the status the CLI branches on", async () => {
    const call = async () =>
      tokenRoute(post("https://gw.example/api/auth/device/token", { device_code: GOOD_DEVICE_CODE }));

    h.status = "pending";
    expect((await call()).status, "pending → 202 so the CLI keeps polling").toBe(202);

    h.status = "denied";
    const denied = await call();
    expect(denied.status).toBe(400);
    expect((await denied.json()).error, "denied → the CLI stops immediately").toBe("access_denied");

    h.status = null;
    const gone = await call();
    expect((await gone.json()).error, "unknown → expired, not pending").toBe("expired_token");
  });

  it("returns the key exactly once", async () => {
    h.status = "approved";
    h.grant = validGrant();
    const first = await tokenRoute(
      post("https://gw.example/api/auth/device/token", { device_code: GOOD_DEVICE_CODE })
    );
    expect(first.status).toBe(200);
    expect((await first.json()).api_key).toMatch(/^pc_/u);

    // The grant is consumed. A replayed device_code gets nothing, and is NOT
    // told the difference between "already redeemed" and "expired" — that
    // distinction is only useful to someone holding a stolen code.
    const second = await tokenRoute(
      post("https://gw.example/api/auth/device/token", { device_code: GOOD_DEVICE_CODE })
    );
    expect(second.status).toBe(400);
    expect((await second.json()).error).toBe("expired_token");
  });

  it("refuses a grant whose own expiry has passed", async () => {
    h.status = "approved";
    h.grant = JSON.stringify({ version: 1, userId: "u", token: "pc_x", prefix: "pc_x", expiresAt: Date.now() - 1 });
    const res = await tokenRoute(
      post("https://gw.example/api/auth/device/token", { device_code: GOOD_DEVICE_CODE })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("expired_token");
  });

  it("answers slow_down without touching the store", async () => {
    h.limitMock.mockResolvedValue({ success: false, remaining: 0, unreadable: false });
    h.status = "approved";
    h.grant = validGrant();
    const res = await tokenRoute(
      post("https://gw.example/api/auth/device/token", { device_code: GOOD_DEVICE_CODE })
    );
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("slow_down");
    expect(h.taken, "a throttled poll must not consume the grant").toBe(0);
  });

  it("limits on the device code, never the caller's IP", async () => {
    // A CLI behind CGNAT shares an IP with strangers; one polling client must not
    // exhaust everyone else's budget. And the limiter key holds the HASH, so its
    // own key space never contains a live secret.
    h.status = "pending";
    await tokenRoute(
      post("https://gw.example/api/auth/device/token", { device_code: GOOD_DEVICE_CODE }, { "x-forwarded-for": "203.0.113.9" })
    );
    const key = String(h.limitMock.mock.calls[0]?.[0] ?? "");
    expect(key).toMatch(/^device-token:[0-9a-f]{64}$/u);
    expect(key).not.toContain("203.0.113.9");
    expect(key).not.toContain(GOOD_DEVICE_CODE);
  });

  it("rejects a malformed device code before it reaches the hash", async () => {
    // Under the 4 KiB body cap on purpose — a bigger body is refused as 413 by
    // the size check first, which is correct but tests a different guard.
    for (const bad of ["", "short", "x".repeat(200)]) {
      const res = await tokenRoute(post("https://gw.example/api/auth/device/token", { device_code: bad }));
      expect(res.status, `"${bad.slice(0, 12)}…" must be refused`).toBe(400);
      expect((await res.json()).error).toBe("expired_token");
    }
    expect(h.limitMock, "a junk code must not even cost a limiter round trip").not.toHaveBeenCalled();
  });

  it("accepts no session cookie as a substitute for the device code", async () => {
    // These routes gate themselves. A cookie means nothing here, and must not.
    h.status = "approved";
    h.grant = validGrant();
    const res = await tokenRoute(
      post("https://gw.example/api/auth/device/token", { device_code: "wrong" }, { cookie: "sb-access-token=whatever" })
    );
    expect(res.status).toBe(400);
    expect(h.taken).toBe(0);
  });
});
