import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  verifyVisaMock,
  authenticateDirectAgentKeyMock,
  serviceClientMock,
  reserveBudgetMock,
  reconcileBudgetMock,
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
  reserveBudgetMock: vi.fn(),
  reconcileBudgetMock: vi.fn(),
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
  isSuspended: (...args: unknown[]) => isSuspendedMock(...args),
  reserveBudget: (...args: unknown[]) => reserveBudgetMock(...args),
  reconcileBudget: (...args: unknown[]) => reconcileBudgetMock(...args),
  getCachedKey: (...args: unknown[]) => getCachedKeyMock(...args),
  setCachedKey: (...args: unknown[]) => setCachedKeyMock(...args),
  getCachedAgentPolicy: (...args: unknown[]) => getCachedAgentPolicyMock(...args),
  setCachedAgentPolicy: (...args: unknown[]) => setCachedAgentPolicyMock(...args),
  touchLastSeen: (...args: unknown[]) => touchLastSeenMock(...args),
  seedSpent: vi.fn(),
}));
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

import { POST } from "@/app/api/v1/[provider]/[...path]/route";

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
  reserveBudgetMock.mockResolvedValue({ ok: true, reserved: 1 });
  reconcileBudgetMock.mockResolvedValue(undefined);
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

describe("Direct Agent Key gateway authentication", () => {
  it("rate-limits the client IP before the database lookup", async () => {
    await call();
    expect(rateLimitFailClosedMock).toHaveBeenCalledWith(
      "direct-key-ip:203.0.113.9",
      expect.any(Number),
      expect.any(Number)
    );
    expect(rateLimitFailClosedMock.mock.invocationCallOrder[0]).toBeLessThan(
      authenticateDirectAgentKeyMock.mock.invocationCallOrder[0]!
    );
  });

  it("ignores a spoofed Cloudflare header outside the Workers deployment", async () => {
    await call({
      "x-api-key": DIRECT_KEY,
      "cf-connecting-ip": "198.51.100.42",
      "x-forwarded-for": "203.0.113.250",
    });
    expect(rateLimitFailClosedMock).toHaveBeenCalledWith(
      "direct-key-ip:203.0.113.250",
      expect.any(Number),
      expect.any(Number)
    );
  });

  it("trusts Cloudflare's edge-provided IP only when the deployment opts in", async () => {
    process.env.PASSCONTROL_TRUST_CF_CONNECTING_IP = "true";
    await call({
      "x-api-key": DIRECT_KEY,
      "cf-connecting-ip": "198.51.100.42",
      "x-forwarded-for": "203.0.113.250",
    });
    expect(rateLimitFailClosedMock).toHaveBeenCalledWith(
      "direct-key-ip:198.51.100.42",
      expect.any(Number),
      expect.any(Number)
    );
  });

  it("refuses killed, suspended, or rate-limited agents before later admission work", async () => {
    rateLimitMock.mockResolvedValueOnce({ success: false, remaining: 0 });
    expect((await call()).status).toBe(429);

    vi.clearAllMocks();
    rateLimitFailClosedMock.mockResolvedValue({ success: true, remaining: 9 });
    rateLimitMock.mockResolvedValue({ success: true, remaining: 599 });
    authenticateDirectAgentKeyMock.mockResolvedValue(directPrincipal);
    readKillStateMock.mockResolvedValue({ platformKill: true, userKill: false, denylist: [] });
    isSuspendedMock.mockResolvedValue(false);
    expect((await call()).status).toBe(403);

    vi.clearAllMocks();
    rateLimitFailClosedMock.mockResolvedValue({ success: true, remaining: 9 });
    rateLimitMock.mockResolvedValue({ success: true, remaining: 599 });
    authenticateDirectAgentKeyMock.mockResolvedValue(directPrincipal);
    readKillStateMock.mockResolvedValue({ platformKill: false, userKill: false, denylist: [] });
    isSuspendedMock.mockResolvedValue(true);
    expect((await call()).status).toBe(403);
  });


  it("accepts x-api-key, bypasses visa verification, and records direct identity", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(verifyVisaMock).not.toHaveBeenCalled();
    expect(authenticateDirectAgentKeyMock).toHaveBeenCalledWith(expect.anything(), DIRECT_KEY);
    expect(signReceiptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        authMethod: "direct_key",
        agentAccessKeyId: directPrincipal.keyId,
        credentialUseId: expect.any(String),
      })
    );
    expect(writeLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        authMethod: "direct_key",
        agentAccessKeyId: directPrincipal.keyId,
        credentialUseId: expect.any(String),
      })
    );
  });

  it("blocks garbage-key floods before Supabase and fails closed when Redis is unreadable", async () => {
    rateLimitFailClosedMock.mockResolvedValue({ success: false, remaining: 0, unreadable: true });
    const res = await call();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "authentication_rate_limit_unavailable" });
    expect(authenticateDirectAgentKeyMock).not.toHaveBeenCalled();
  });

  it("answers a limited source with 429 without touching Supabase", async () => {
    rateLimitFailClosedMock.mockResolvedValue({ success: false, remaining: 0 });
    const res = await call();
    expect(res.status).toBe(429);
    expect(authenticateDirectAgentKeyMock).not.toHaveBeenCalled();
  });

  it("fails closed when direct-key storage is unavailable", async () => {
    authenticateDirectAgentKeyMock.mockRejectedValue(new Error("direct_key_lookup_failed"));
    const res = await call();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "authentication_unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps Authorization Bearer precedence when both headers are present", async () => {
    const res = await call({ authorization: "Bearer passport.visa.value", "x-api-key": DIRECT_KEY });
    expect(res.status).toBe(200);
    expect(verifyVisaMock).toHaveBeenCalledWith("passport.visa.value");
    expect(rateLimitFailClosedMock).not.toHaveBeenCalled();
    expect(authenticateDirectAgentKeyMock).not.toHaveBeenCalled();
  });

  // ── last-seen ──────────────────────────────────────────────────────────────
  //
  // `touchLastSeen` had exactly two callers — the challenge and the visa mint —
  // both of which a direct key skips entirely. So `lastseen:<agid>` was never
  // written for a direct-key agent, the reconcile cron had nothing to flush,
  // and `agents.last_seen_at` stayed NULL however many calls the agent made.
  // Observed on production 2026-08-17: the fleet table read "never" for an
  // agent whose most recent call was twelve minutes old.
  describe("last-seen", () => {
    it("stamps it once the key is accepted", async () => {
      const res = await call();
      expect(res.status).toBe(200);
      expect(touchLastSeenMock).toHaveBeenCalledWith(directPrincipal.agentId);
    });

    it("stamps on authentication, not on a cleared call", async () => {
      // Same meaning the passport path already gives it: the challenge stamps
      // before any gate runs. A suspended agent that presents a valid key WAS
      // seen — that is exactly when an operator most wants to know it is live.
      isSuspendedMock.mockResolvedValue(true);
      const res = await call();
      expect(res.status).toBe(403);
      expect(touchLastSeenMock).toHaveBeenCalledWith(directPrincipal.agentId);
    });

    it("never stamps for a credential that was not authenticated", async () => {
      authenticateDirectAgentKeyMock.mockResolvedValue(null);
      const res = await call();
      expect(res.status).toBe(401);
      expect(touchLastSeenMock).not.toHaveBeenCalled();
    });

    it("cannot fail the call when Redis is unwritable", async () => {
      // It is a presentation stamp on the money path. It must never be able to
      // refuse, delay, or 500 a call that the gate already cleared.
      touchLastSeenMock.mockRejectedValue(new Error("redis down"));
      const res = await call();
      expect(res.status).toBe(200);
    });
  });
});
