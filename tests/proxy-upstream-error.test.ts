import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  verifyVisaMock,
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
  fetchMock,
  readProvidersWithKeysMock,
} = vi.hoisted(() => {
  return {
    verifyVisaMock: vi.fn(),
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
    fetchMock: vi.fn(),
    readProvidersWithKeysMock: vi.fn(),
  };
});

vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));
vi.mock("@/lib/auth/visa", () => ({
  extractVisaToken: (headers: Headers) => headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "",
  verifyVisa: (...args: unknown[]) => verifyVisaMock(...args),
}));
vi.mock("@/lib/state/killswitch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/state/killswitch")>();
  return {
    ...actual,
    readKillState: (...args: unknown[]) => readKillStateMock(...args),
  };
});
vi.mock("@/lib/state/redis", () => ({
  isSuspended: (...args: unknown[]) => isSuspendedMock(...args),
  reserveBudget: (...args: unknown[]) => reserveBudgetMock(...args),
  reconcileBudget: (...args: unknown[]) => reconcileBudgetMock(...args),
  getCachedKey: (...args: unknown[]) => getCachedKeyMock(...args),
  setCachedKey: (...args: unknown[]) => setCachedKeyMock(...args),
  getCachedAgentPolicy: (...args: unknown[]) => getCachedAgentPolicyMock(...args),
  setCachedAgentPolicy: (...args: unknown[]) => setCachedAgentPolicyMock(...args),
  seedSpent: vi.fn(),
}));
vi.mock("@/lib/supabase", () => ({ serviceClient: () => serviceClientMock() }));
vi.mock("@/lib/crypto/aesgcm", () => ({ seal: async () => "sealed", open: async (v: string) => v }));
vi.mock("@/lib/log", () => ({
  writeLog: (...args: unknown[]) => writeLogMock(...args),
  mirrorSpend: (...args: unknown[]) => mirrorSpendMock(...args),
}));
vi.mock("@/lib/ratelimit", () => ({ rateLimit: (...args: unknown[]) => rateLimitMock(...args) }));
// Only the tenant lookup is mocked. classifyUpstreamFailure and buildAlternatives
// run for real here on purpose: the point of these cases is that the proxy wires
// the real classifier to the real alternatives builder, which a mock would hide.
vi.mock("@/lib/providers/available", () => ({
  readProvidersWithKeys: (...args: unknown[]) => readProvidersWithKeysMock(...args),
}));

import { POST } from "@/app/api/v1/[provider]/[...path]/route";

const baseClaims = {
  sub: "passport-id",
  agid: "agent-id",
  uid: "user-id",
  jti: "jti-1",
  bt: null,
  bc: null,
  st: 0,
  sc: 0,
  ver: 1,
  scope: [{ provider: "openai", models: ["gpt-4o-mini"] }],
};

function request() {
  return new Request("https://gateway.test/api/v1/openai/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer visa", "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
}

async function callProxy() {
  return POST(request(), {
    params: Promise.resolve({ provider: "openai", path: ["chat", "completions"] }),
  });
}

function expectReleasedWithoutSpend() {
  const reserveId = reserveBudgetMock.mock.calls[0]?.[0]?.reserveId;
  expect(reserveId).toEqual(expect.any(String));
  expect(reconcileBudgetMock).toHaveBeenCalledWith(
    expect.objectContaining({
      agentId: "agent-id",
      reserveId,
      actualTokens: 0,
      actualMicrocents: 0,
    })
  );
  expect(writeLogMock).toHaveBeenCalledWith(
    expect.objectContaining({
      jti: "jti-1",
      status: "upstream_error",
      inputTokens: 0,
      outputTokens: 0,
      costMicrocents: 0,
    })
  );
  expect(mirrorSpendMock).not.toHaveBeenCalled();
}

beforeEach(() => {
  verifyVisaMock.mockReset();
  serviceClientMock.mockReset();
  reserveBudgetMock.mockReset();
  reconcileBudgetMock.mockReset();
  getCachedKeyMock.mockReset();
  setCachedKeyMock.mockReset();
  getCachedAgentPolicyMock.mockReset();
  setCachedAgentPolicyMock.mockReset();
  readKillStateMock.mockReset();
  isSuspendedMock.mockReset();
  writeLogMock.mockReset();
  mirrorSpendMock.mockReset();
  rateLimitMock.mockReset();
  fetchMock.mockReset();
  readProvidersWithKeysMock.mockReset();
  readProvidersWithKeysMock.mockResolvedValue([]);

  verifyVisaMock.mockResolvedValue(baseClaims);
  serviceClientMock.mockReturnValue({
    rpc: vi.fn(async () => ({ data: "provider-key", error: null })),
  });
  reserveBudgetMock.mockResolvedValue({ ok: true, reserved: 1 });
  reconcileBudgetMock.mockResolvedValue(undefined);
  getCachedKeyMock.mockResolvedValue(null);
  setCachedKeyMock.mockResolvedValue(undefined);
  getCachedAgentPolicyMock.mockResolvedValue(JSON.stringify({ p: {}, s: null }));
  setCachedAgentPolicyMock.mockResolvedValue(undefined);
  readKillStateMock.mockResolvedValue({ platformKill: false, tenantKill: false, denylist: [] });
  isSuspendedMock.mockResolvedValue(false);
  writeLogMock.mockResolvedValue(undefined);
  mirrorSpendMock.mockResolvedValue(undefined);
  rateLimitMock.mockResolvedValue({ success: true, remaining: 1 });
  vi.stubGlobal("fetch", fetchMock);
});

describe("proxy upstream-error reservation release", () => {
  it("releases the reservation and records zero spend when upstream returns non-2xx", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "upstream failed" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      })
    );

    const res = await callProxy();

    expect(res.status).toBe(500);
    expectReleasedWithoutSpend();
  });

  it("releases the reservation and records zero spend when fetch throws", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));

    const res = await callProxy();

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "upstream_unreachable" });
    expectReleasedWithoutSpend();
  });
});

// ── Provider credit exhaustion ───────────────────────────────────────────────
//
// The gateway holds keys for the agent's other scoped providers, so an "out of
// credit" answer is one it can turn into something actionable. Everything else
// must still come through exactly as it did before — that unchanged path is what
// most of these cases are pinning.
const OPENAI_QUOTA = JSON.stringify({
  error: {
    message: "You exceeded your current quota, please check your plan and billing details.",
    type: "insufficient_quota",
    param: null,
    code: "insufficient_quota",
  },
});

const OPENAI_RATE_LIMIT = JSON.stringify({
  error: {
    message: "Rate limit reached for gpt-4o-mini in organization org-abc on requests per min.",
    type: "requests",
    param: null,
    code: "rate_limit_exceeded",
  },
});

function upstreamError(body: string, status: number, contentType = "application/json") {
  return new Response(body, {
    status,
    headers: { "content-type": contentType, "content-length": String(body.length) },
  });
}

function reconcileCalls() {
  return writeLogMock.mock.calls.filter(([entry]) => entry?.jti === "jti-1");
}

describe("proxy provider-credit exhaustion", () => {
  it("answers a quota-exhausted provider with a structured 402", async () => {
    verifyVisaMock.mockResolvedValue({
      ...baseClaims,
      scope: [
        { provider: "openai", models: ["gpt-4o-mini"] },
        { provider: "groq", models: ["llama-3.3-70b"] },
      ],
    });
    readProvidersWithKeysMock.mockResolvedValue(["openai", "groq"]);
    fetchMock.mockResolvedValue(upstreamError(OPENAI_QUOTA, 429));

    const res = await callProxy();

    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({
      error: "provider_credit_exhausted",
      provider: "openai",
      alternatives: [
        {
          provider: "groq",
          models: ["llama-3.3-70b"],
          same_shape: true,
          path: "/v1/groq/chat/completions",
        },
      ],
    });
    // The id has to resolve: this path writes a row, so the header's contract
    // ("this names a decision the gateway recorded") still holds.
    expect(res.headers.get("x-passcontrol-receipt-id")).toEqual(expect.any(String));
  });

  it("records the exhaustion under its own status, not blocked_budget", async () => {
    readProvidersWithKeysMock.mockResolvedValue(["openai"]);
    fetchMock.mockResolvedValue(upstreamError(OPENAI_QUOTA, 429));

    await callProxy();

    expect(writeLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ jti: "jti-1", status: "provider_exhausted" })
    );
  });

  // Today's normal case: passport issuance writes one scope entry, so most agents
  // have nothing to fail over to. The answer must still be a well-formed 402
  // rather than a special-cased error.
  it("still answers a 402 for a single-provider agent, with no alternatives", async () => {
    readProvidersWithKeysMock.mockResolvedValue(["openai"]);
    fetchMock.mockResolvedValue(upstreamError(OPENAI_QUOTA, 429));

    const res = await callProxy();

    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ alternatives: [] });
  });

  it("releases the reservation exactly once and spends nothing", async () => {
    readProvidersWithKeysMock.mockResolvedValue(["openai"]);
    fetchMock.mockResolvedValue(upstreamError(OPENAI_QUOTA, 429));

    await callProxy();

    expect(reconcileBudgetMock).toHaveBeenCalledTimes(1);
    expect(reconcileBudgetMock).toHaveBeenCalledWith(
      expect.objectContaining({ actualTokens: 0, actualMicrocents: 0 })
    );
    expect(reconcileCalls()).toHaveLength(1);
    expect(mirrorSpendMock).not.toHaveBeenCalled();
  });

  // The load-bearing negative, end to end. OpenAI uses 429 for both a transient
  // rate limit and permanent exhaustion; only the body separates them. Rewriting
  // a rate limit as a 402 tells an agent to abandon a provider it should have
  // waited one second for.
  it("passes an OpenAI rate limit through untouched", async () => {
    readProvidersWithKeysMock.mockResolvedValue(["openai", "groq"]);
    fetchMock.mockResolvedValue(upstreamError(OPENAI_RATE_LIMIT, 429));

    const res = await callProxy();

    expect(res.status).toBe(429);
    expect(await res.text()).toBe(OPENAI_RATE_LIMIT);
    expect(writeLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ jti: "jti-1", status: "upstream_error" })
    );
    expect(reconcileBudgetMock).toHaveBeenCalledTimes(1);
  });

  it("passes an unrelated upstream failure through byte-for-byte", async () => {
    const body = JSON.stringify({ error: { message: "gateway timeout", type: "server_error" } });
    fetchMock.mockResolvedValue(upstreamError(body, 503));

    const res = await callProxy();

    expect(res.status).toBe(503);
    expect(await res.text()).toBe(body);
  });

  // The classifier never sees a non-JSON body, so the proxy must not read one —
  // reading is what turns a streamed pass-through into a buffered response.
  it("does not inspect a non-JSON error body on a classifiable status", async () => {
    fetchMock.mockResolvedValue(upstreamError(OPENAI_QUOTA, 429, "text/event-stream"));

    const res = await callProxy();

    expect(res.status).toBe(429);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(readProvidersWithKeysMock).not.toHaveBeenCalled();
  });

  // A status this provider has no rule for must not cost a body read either.
  it("does not look up the tenant's providers on an unclassifiable status", async () => {
    fetchMock.mockResolvedValue(upstreamError(OPENAI_QUOTA, 500));

    await callProxy();

    expect(readProvidersWithKeysMock).not.toHaveBeenCalled();
  });
});
