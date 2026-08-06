// The machine-readable half of PAVP. Same lookup, same surface, same outage
// semantics as the page — this pins that it stayed that way, because a JSON
// endpoint is what software will actually build on.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PUBLIC_PASSPORT_FIELDS } from "@/lib/verify/passport";
import { config as middlewareConfig } from "@/middleware";

const h = vi.hoisted(() => ({ rateLimitMock: vi.fn(), rpcMock: vi.fn() }));

vi.mock("@/lib/ratelimit", () => ({ rateLimit: (...a: unknown[]) => h.rateLimitMock(...a) }));
vi.mock("@/lib/supabase", () => ({ serviceClient: () => ({ rpc: h.rpcMock }) }));

import { GET } from "@/app/api/verify/[passportId]/route";

const PASSPORT_ID = "Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyc28";

const row = (overrides: Record<string, unknown> = {}) => ({
  passport_pubkey: PASSPORT_ID,
  status: "active",
  created_at: "2026-07-01T09:30:00.000Z",
  ...overrides,
});

const call = (id = PASSPORT_ID, headers: Record<string, string> = {}) =>
  GET(new Request(`https://gw.test/api/verify/${id}`, { headers }), {
    params: Promise.resolve({ passportId: id }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  h.rateLimitMock.mockResolvedValue({ success: true, remaining: 10 });
  h.rpcMock.mockResolvedValue({ data: [row()], error: null });
});

describe("the JSON verification endpoint", () => {
  it("returns exactly the public field set and nothing more", async () => {
    const res = await call();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(Object.keys(body.data).sort()).toEqual([...PUBLIC_PASSPORT_FIELDS].sort());
  });

  it("reads through the same verify_passport function as the page", async () => {
    await call();
    expect(h.rpcMock).toHaveBeenCalledWith("verify_passport", { p_passport_id: PASSPORT_ID });
  });

  it("reports a revoked passport as found and revoked", async () => {
    h.rpcMock.mockResolvedValue({ data: [row({ status: "revoked" })], error: null });
    const body = await (await call()).json();
    expect(body.data.status).toBe("revoked");
  });

  it("publishes a verified owner", async () => {
    h.rpcMock.mockResolvedValue({
      data: [row({ owner_subject: "acme.com", owner_kind: "domain", owner_tier: "domain" })],
      error: null,
    });
    const body = await (await call()).json();
    expect(body.data.owner).toMatchObject({ subject: "acme.com", tier: "domain" });
  });

  it("never leaks a private column even when the row carries one", async () => {
    h.rpcMock.mockResolvedValue({
      data: [row({ name: "acme-prod-billing", user_id: "9f1d0c7a-0000-0000-0000-000000000000" })],
      error: null,
    });
    const text = await (await call()).text();

    expect(text).not.toContain("acme-prod-billing");
    expect(text).not.toContain("9f1d0c7a");
  });

  it("answers 404 for an unknown passport", async () => {
    h.rpcMock.mockResolvedValue({ data: [], error: null });
    expect((await call()).status).toBe(404);
  });

  it("answers 404 for a malformed id without touching the database", async () => {
    const res = await call("11111111-1111-1111-1111-111111111111");
    expect(res.status).toBe(404);
    expect(h.rpcMock).not.toHaveBeenCalled();
  });

  // A machine consumer is far likelier than a human to act on a 404. Answering
  // "no such passport" during an outage would be a false statement about
  // someone's identity that a verifier might treat as a revocation.
  it("answers 503 on an outage, never 404", async () => {
    h.rpcMock.mockResolvedValue({ data: null, error: { message: "boom" } });
    const res = await call();

    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("verification_unavailable");
  });

  it("throttles by client ip and says so with a retry-after", async () => {
    h.rateLimitMock.mockResolvedValue({ success: false, remaining: 0 });
    const res = await call(PASSPORT_ID, { "x-forwarded-for": "203.0.113.7, 10.0.0.1" });

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(h.rateLimitMock).toHaveBeenCalledWith("verify:203.0.113.7", expect.any(Number), expect.any(Number));
  });

  it("is readable cross-origin, since other deployments are the consumers", async () => {
    expect((await call()).headers.get("access-control-allow-origin")).toBe("*");
  });

  // Under /api/, so the matcher already excludes it — agents and verifiers
  // authenticate with tokens, not cookies, and a 302 to /login would be useless.
  it("is not gated by the middleware", () => {
    const matches = middlewareConfig.matcher.some((pattern) =>
      new RegExp(`^${pattern}$`).test(`/api/verify/${PASSPORT_ID}`)
    );
    expect(matches).toBe(false);
  });
});
