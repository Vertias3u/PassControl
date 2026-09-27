// C2 + C1 (detection) — the passport-visa door's unauthenticated edge.
//
// C2: the Direct Agent Key branch was rate-limited before any work and the visa
// branch was not. Verifying a visa is local HMAC, but every FAILED one emitted a
// security event, and C1 below adds a database lookup to that failure path — so
// failed visa authentications are now counted per client IP, fail closed. Valid
// visas are never counted or throttled here: they have their per-agent limit.
//
// C1: a Passport SECRET pasted into a client's API-key field reaches the gateway
// as a bearer token. It is a 43-char base64url Ed25519 seed; deriving its public
// key and finding it on an agent is proof — no guess — that this agent's private
// key was just transmitted. The answer names the problem; the event names the
// agent; the token is never echoed or logged.
import { ed25519 } from "@noble/curves/ed25519";
import { bytesToBase64url } from "@/lib/encoding";
import { beforeEach, describe, expect, it, vi } from "vitest";
const establishBudgetStateMock = vi.fn();
const flagExposedMock = vi.fn();

const {
  verifyVisaMock,
  authenticateDirectAgentKeyMock,
  serviceClientMock,
  openHoldMock,
  settleHoldMock,
  getCachedKeyMock,
  setCachedKeyMock,
  getCachedAgentPolicyMock,
  setCachedAgentPolicyMock,
  readKillStateMock,
  isSuspendedMock,
  writeLogMock,
  mirrorSpendMock,
  rateLimitMock,
  rateLimitFailClosedMock,
  captureSecurityEventMock,
  signReceiptMock,
  touchLastSeenMock,
  fetchMock,
} = vi.hoisted(() => ({
  verifyVisaMock: vi.fn(),
  authenticateDirectAgentKeyMock: vi.fn(),
  serviceClientMock: vi.fn(),
  openHoldMock: vi.fn(),
  settleHoldMock: vi.fn(),
  getCachedKeyMock: vi.fn(),
  setCachedKeyMock: vi.fn(),
  getCachedAgentPolicyMock: vi.fn(),
  setCachedAgentPolicyMock: vi.fn(),
  readKillStateMock: vi.fn(),
  isSuspendedMock: vi.fn(),
  writeLogMock: vi.fn(),
  mirrorSpendMock: vi.fn(),
  rateLimitMock: vi.fn(),
  rateLimitFailClosedMock: vi.fn(),
  captureSecurityEventMock: vi.fn(),
  signReceiptMock: vi.fn(),
  touchLastSeenMock: vi.fn(),
  fetchMock: vi.fn(),
}));

// The proxy now reaches lib/demo/identity.ts to tell the seeded PUBLIC demo
// passport apart from a tenant that holds a demo scope. That module is
// `server-only`, which Next enforces at build time and vitest cannot resolve
// at all — same stub tests/site-demo-routes.test.ts already uses.
vi.mock("server-only", () => ({}));
vi.mock("@vercel/functions", () => ({ waitUntil: (promise: unknown) => promise }));
vi.mock("@/lib/auth/visa", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/visa")>()),
  verifyVisa: (...args: unknown[]) => verifyVisaMock(...args),
}));
vi.mock("@/lib/auth/direct-key", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/direct-key")>()),
  authenticateDirectAgentKey: (...args: unknown[]) => authenticateDirectAgentKeyMock(...args),
}));
vi.mock("@/lib/state/killswitch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/state/killswitch")>()),
  readKillState: (...args: unknown[]) => readKillStateMock(...args),
}));
vi.mock("@/lib/state/redis", () => ({
  purgeAgentPolicy: vi.fn(),
  // The proxy reads this before the endpoint row and again before dispatch.
  // Omitted, it is undefined, the call throws, and the route 500s.
  readCredentialFence: vi.fn(async () => null),
  isSuspended: (...args: unknown[]) => isSuspendedMock(...args),
  getCachedKey: (...args: unknown[]) => getCachedKeyMock(...args),
  setCachedKey: (...args: unknown[]) => setCachedKeyMock(...args),
  getCachedAgentPolicy: (...args: unknown[]) => getCachedAgentPolicyMock(...args),
  setCachedAgentPolicy: (...args: unknown[]) => setCachedAgentPolicyMock(...args),
  // Mocked explicitly. Left out it is undefined, the call throws, policy.ts
  // catches it, and the fence silently becomes null in every assertion below.
  readPolicyFence: async () => null,
  touchLastSeen: (...args: unknown[]) => touchLastSeenMock(...args),
  flagPassportSecretExposed: (...args: unknown[]) => flagExposedMock(...args),
}));
/**
 * The attempt-lifecycle boundary, mocked as a MODULE rather than re-implemented.
 *
 * tests/reserve-id.test.ts used to hand-copy the reserve Lua into TypeScript and
 * the copy drifted — it collapsed the -1/-2 return codes, so one whole branch of
 * the money boundary was covered by a test that could not fail on it. Mocking
 * the boundary removes that hazard: what the real scripts DO is Tier A's job
 * (tests/holds.redis.test.ts, real Lua on real Redis); what this file asserts is
 * WHICH transition the route chooses and with WHAT arguments.
 *
 * The three settle entry points funnel into one spy carrying an `outcome` tag,
 * because the choice between them IS the behaviour under test.
 */
vi.mock("@/lib/state/holds", () => {
  const settle = async (outcome: string, p: Record<string, unknown>) => {
    const r = await settleHoldMock({ ...p, outcome });
    // A test that does not care about the applied figures gets a realistic
    // settlement rather than `undefined`, which the route would then read
    // fields off. Tests that DO care override the return.
    return (
      r ?? {
        applied: true,
        appliedTokens: Number(p.tokens ?? 0),
        appliedMicrocents: Number(p.microcents ?? 0),
      }
    );
  };
  return {
    openHold: (...args: unknown[]) => openHoldMock(...args),
    // Always granted here: these suites assert what the proxy does AROUND the
    // dispatch boundary, not the boundary itself (tests/proxy-dispatch-permission.test.ts).
    consumeDispatchPermission: async () => ({ granted: true }),
    settleKnown: (p: Record<string, unknown>) => settle("complete", p),
    settleUnknown: (p: Record<string, unknown>) => settle("usage_unknown", p),
    releaseUndispatched: (p: Record<string, unknown>) => settle("not_dispatched", p),
    establishBudgetState: (...args: unknown[]) => establishBudgetStateMock(...args),
  };
});
vi.mock("@/lib/supabase", () => ({ serviceClient: () => serviceClientMock() }));
vi.mock("@/lib/crypto/aesgcm", () => ({ seal: async () => "sealed", open: async (v: string) => v }));
vi.mock("@/lib/log", () => ({
  writeLog: (...args: unknown[]) => writeLogMock(...args),
  mirrorSpend: (...args: unknown[]) => mirrorSpendMock(...args),
}));
vi.mock("@/lib/ratelimit", () => ({
  rateLimit: (...args: unknown[]) => rateLimitMock(...args),
  rateLimitFailClosed: (...args: unknown[]) => rateLimitFailClosedMock(...args),
}));
vi.mock("@/lib/observability", () => ({
  captureError: vi.fn(async () => undefined),
  captureSecurityEvent: (...args: unknown[]) => captureSecurityEventMock(...args),
  logFailOpen: vi.fn(),
}));
vi.mock("@/lib/receipt", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/receipt")>()),
  signReceipt: (...args: unknown[]) => signReceiptMock(...args),
}));

import { GET, POST } from "@/app/api/v1/[provider]/[...path]/route";

const DIRECT_KEY = `pc_agent_${"A".repeat(43)}`;
const directPrincipal = {
  kind: "direct_key" as const,
  keyId: "00000000-0000-4000-8000-000000000001",
  agentId: "00000000-0000-4000-8000-000000000002",
  userId: "00000000-0000-4000-8000-000000000003",
  scopes: [{ provider: "openai", models: ["gpt-4o-mini"] }],
  budgetTokens: null,
  budgetCents: null,
  spentTokens: 0,
  spentMicrocents: 0,
  suspended: false,
};

function request(headers: Record<string, string> = { "x-api-key": DIRECT_KEY }) {
  return new Request("https://gateway.test/api/v1/openai/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9", ...headers },
    body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] }),
  });
}

function call(headers?: Record<string, string>) {
  return POST(request(headers), {
    params: Promise.resolve({ provider: "openai", path: ["v1", "chat", "completions"] }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PASSCONTROL_TRUST_CF_CONNECTING_IP;
  serviceClientMock.mockReturnValue({
    rpc: vi.fn(async () => ({ data: "provider-key", error: null })),
  });
  authenticateDirectAgentKeyMock.mockResolvedValue(directPrincipal);
  verifyVisaMock.mockResolvedValue({
    sub: "passport-id",
    agid: "agent-id",
    uid: "user-id",
    jti: "visa-id",
    scope: [{ provider: "openai", models: ["gpt-4o-mini"] }],
    bt: null,
    bc: null,
    st: 0,
    sc: 0,
    ver: 1,
  });
  rateLimitFailClosedMock.mockResolvedValue({ success: true, remaining: 9 });
  rateLimitMock.mockResolvedValue({ success: true, remaining: 599 });
  captureSecurityEventMock.mockResolvedValue(undefined);
  readKillStateMock.mockResolvedValue({ platformKill: false, userKill: false, denylist: [] });
  isSuspendedMock.mockResolvedValue(false);
  openHoldMock.mockResolvedValue({ ok: true, reserved: 1 });
  settleHoldMock.mockResolvedValue(undefined);
  getCachedKeyMock.mockResolvedValue(null);
  setCachedKeyMock.mockResolvedValue(undefined);
  getCachedAgentPolicyMock.mockResolvedValue(JSON.stringify({ p: {}, s: null }));
  setCachedAgentPolicyMock.mockResolvedValue(undefined);
  writeLogMock.mockResolvedValue(undefined);
  mirrorSpendMock.mockResolvedValue(undefined);
  signReceiptMock.mockReturnValue("header.payload.signature");
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  );
  vi.stubGlobal("fetch", fetchMock);
});


const SEED = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);
const SECRET = bytesToBase64url(SEED);
const PASSPORT_ID = bytesToBase64url(ed25519.getPublicKey(SEED));
const AGENT = "00000000-0000-4000-8000-0000000000aa";

function agentsLookup(rows: unknown[] | null, error: unknown = null) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    limit: vi.fn(async () => ({ data: rows, error })),
  };
  const from = vi.fn(() => builder);
  serviceClientMock.mockReturnValue({ from, rpc: vi.fn(async () => ({ data: "provider-key", error: null })) });
  return { from, builder };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe("C2 — failed visa authentications are limited per client IP", () => {
  beforeEach(() => {
    verifyVisaMock.mockResolvedValue(null);
  });

  it("counts a failed visa against the client IP and answers 401", async () => {
    agentsLookup([]);
    const res = await call(bearer("not.a.visa"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_visa" });
    expect(rateLimitFailClosedMock).toHaveBeenCalledWith("visa-fail-ip:203.0.113.9", expect.any(Number), expect.any(Number));
    expect(captureSecurityEventMock).toHaveBeenCalledWith("proxy.invalid_visa", expect.anything());
  });

  it("never counts or throttles a valid visa", async () => {
    verifyVisaMock.mockResolvedValue({
      sub: "passport-id", agid: "agent-id", uid: "user-id", jti: "visa-id",
      scope: [{ provider: "openai", models: ["gpt-4o-mini"] }], bt: null, bc: null, st: 0, sc: 0, ver: 1,
    });
    rateLimitFailClosedMock.mockResolvedValue({ success: false, remaining: 0 });
    const res = await call(bearer("valid.visa.token"));
    expect(res.status).not.toBe(429);
    expect(rateLimitFailClosedMock).not.toHaveBeenCalledWith(expect.stringMatching(/^visa-fail-ip:/), expect.anything(), expect.anything());
  });

  it("answers an over-limit source 429 with no event and no database work", async () => {
    const { from } = agentsLookup([{ id: AGENT, user_id: "u", passport_pubkey: PASSPORT_ID }]);
    rateLimitFailClosedMock.mockResolvedValue({ success: false, remaining: 0 });
    const res = await call(bearer(SECRET));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
    expect(res.headers.get("retry-after")).toBeTruthy();
    expect(from).not.toHaveBeenCalled();
    expect(captureSecurityEventMock).not.toHaveBeenCalled();
  });

  it("does no database work when the counter is unreadable, and still answers 401", async () => {
    const { from } = agentsLookup([{ id: AGENT, user_id: "u", passport_pubkey: PASSPORT_ID }]);
    rateLimitFailClosedMock.mockResolvedValue({ success: false, remaining: 0, unreadable: true });
    const res = await call(bearer(SECRET));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_visa" });
    expect(from).not.toHaveBeenCalled();
  });
});

describe("C1 — a Passport secret presented as a bearer token", () => {
  beforeEach(() => {
    verifyVisaMock.mockResolvedValue(null);
  });

  it("is recognised by deriving its public key, answered with its own code, and never echoed", async () => {
    const { builder } = agentsLookup([{ id: AGENT, user_id: "u", passport_pubkey: PASSPORT_ID }]);
    const res = await call(bearer(SECRET));
    const text = await res.text();
    expect(res.status).toBe(401);
    expect(JSON.parse(text).error).toBe("passport_secret_presented_as_bearer");
    expect(JSON.parse(text).message).toMatch(/private/i);
    expect(JSON.parse(text).message).toMatch(/rotate/i);
    expect(text).not.toContain(SECRET);
    expect(builder.eq).toHaveBeenCalledWith("passport_pubkey", PASSPORT_ID);
    expect(captureSecurityEventMock).toHaveBeenCalledWith(
      "proxy.passport_secret_presented",
      expect.objectContaining({ agentId: AGENT, status: 401 })
    );
    expect(JSON.stringify(captureSecurityEventMock.mock.calls)).not.toContain(SECRET);
    expect(flagExposedMock).toHaveBeenCalledWith(AGENT, PASSPORT_ID);
    expect(JSON.stringify(flagExposedMock.mock.calls)).not.toContain(SECRET);
    expect(writeLogMock).not.toHaveBeenCalled();
  });

  it("does not fire for the PUBLIC passport id, which derives a key that matches nothing", async () => {
    const { builder } = agentsLookup([]);
    const res = await call(bearer(PASSPORT_ID));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("invalid_visa");
    expect(builder.eq).toHaveBeenCalledWith("passport_pubkey", bytesToBase64url(ed25519.getPublicKey(new Uint8Array(Buffer.from(PASSPORT_ID, "base64url")))));
    expect(flagExposedMock).not.toHaveBeenCalled();
  });

  it("only tries the derivation for a token shaped exactly like a seed", async () => {
    const { from } = agentsLookup([]);
    await call(bearer("header.payload.signature"));
    await call(bearer(SECRET + "A"));
    expect(from).not.toHaveBeenCalled();
  });

  it("falls back to the plain 401 when the lookup fails", async () => {
    agentsLookup(null, { message: "timeout" });
    const res = await call(bearer(SECRET));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("invalid_visa");
    expect(flagExposedMock).not.toHaveBeenCalled();
  });
});
