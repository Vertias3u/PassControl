import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  captureSecurityEventMock,
  fetchMock,
} = vi.hoisted(() => ({
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
  captureSecurityEventMock: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock("@vercel/functions", () => ({ waitUntil: (promise: unknown) => promise }));
vi.mock("@/lib/auth/visa", () => ({
  extractVisaToken: (headers: Headers) =>
    headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "",
  verifyVisa: (...args: unknown[]) => verifyVisaMock(...args),
}));
vi.mock("@/lib/state/killswitch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/state/killswitch")>();
  return { ...actual, readKillState: (...args: unknown[]) => readKillStateMock(...args) };
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
vi.mock("@/lib/ratelimit", () => ({
  rateLimit: (...args: unknown[]) => rateLimitMock(...args),
}));
const { logFailOpenMock } = vi.hoisted(() => ({ logFailOpenMock: vi.fn() }));

vi.mock("@/lib/observability", () => ({
  captureError: vi.fn(async () => undefined),
  captureSecurityEvent: (...args: unknown[]) => captureSecurityEventMock(...args),
  logFailOpen: (...args: unknown[]) => logFailOpenMock(...args),
}));

import { POST } from "@/app/api/v1/[provider]/[...path]/route";

const baseClaims = {
  sub: "passport-id",
  agid: "agent-a",
  uid: "tenant-a",
  jti: "jti-1",
  bt: null,
  bc: null,
  st: 0,
  sc: 0,
  ver: 1,
  scope: [{ provider: "openai", models: ["*"] }],
};

function request(provider = "openai", model = "gpt-4.1") {
  return new Request(`https://gateway.test/api/v1/${provider}/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer visa", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
  });
}

async function callProxy(
  policy: unknown,
  claims: typeof baseClaims = baseClaims,
  provider = "openai",
  model = "gpt-4.1"
) {
  verifyVisaMock.mockResolvedValueOnce(claims);
  getCachedAgentPolicyMock.mockResolvedValueOnce(JSON.stringify(policy));
  return POST(request(provider, model), {
    params: Promise.resolve({ provider, path: ["chat", "completions"] }),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-27T10:00:00.000Z"));

  for (const mock of [
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
    captureSecurityEventMock,
    fetchMock,
  ]) {
    mock.mockReset();
  }

  serviceClientMock.mockReturnValue({
    from: vi.fn(),
    rpc: vi.fn(async () => ({ data: "provider-key", error: null })),
  });
  reserveBudgetMock.mockResolvedValue({ ok: true, reserved: 1 });
  reconcileBudgetMock.mockResolvedValue(undefined);
  getCachedKeyMock.mockResolvedValue("provider-key");
  setCachedKeyMock.mockResolvedValue(undefined);
  getCachedAgentPolicyMock.mockResolvedValue(JSON.stringify({}));
  setCachedAgentPolicyMock.mockResolvedValue(undefined);
  readKillStateMock.mockResolvedValue({ platformKill: false, tenantKill: false, denylist: [] });
  isSuspendedMock.mockResolvedValue(false);
  writeLogMock.mockResolvedValue(undefined);
  mirrorSpendMock.mockResolvedValue(undefined);
  rateLimitMock.mockResolvedValue({ success: true, remaining: 1 });
  captureSecurityEventMock.mockResolvedValue(undefined);
  fetchMock.mockImplementation(async () =>
    new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.PASSCONTROL_DEMO;
});

describe("proxy agent policy", () => {
  it("blocks a denied model after scope and before budget reservation", async () => {
    let reservedTokens = 0;
    let spentTokens = 50;
    reserveBudgetMock.mockImplementation(async ({ estimate }: { estimate: number }) => {
      reservedTokens += estimate;
      return { ok: true, reserved: reservedTokens };
    });
    reconcileBudgetMock.mockImplementation(async () => {
      spentTokens += reservedTokens;
    });

    const res = await callProxy({
      deny: [{ provider: "openai", models: ["gpt-4*"] }],
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "blocked_policy" });
    expect(reservedTokens).toBe(0);
    expect(spentTokens).toBe(50);
    expect(reserveBudgetMock).not.toHaveBeenCalled();
    expect(reconcileBudgetMock).not.toHaveBeenCalled();
    expect(writeLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "blocked_policy", model: "gpt-4.1" })
    );
    expect(captureSecurityEventMock).toHaveBeenCalledWith(
      "proxy.blocked_policy_deny",
      expect.objectContaining({ code: "blocked_policy_deny" })
    );
  });

  it("blocks outside a window and allows inside it with a deterministic clock", async () => {
    const policy = {
      windows: [{ days: ["mon"], start: "09:00", end: "18:00", tz: "UTC" }],
    };

    vi.setSystemTime(new Date("2026-07-27T20:00:00.000Z"));
    const outside = await callProxy(policy);
    expect(outside.status).toBe(403);
    expect(reserveBudgetMock).not.toHaveBeenCalled();

    vi.setSystemTime(new Date("2026-07-27T10:00:00.000Z"));
    const inside = await callProxy(policy);
    expect(inside.status).toBe(200);
    expect(reserveBudgetMock).toHaveBeenCalledTimes(1);
  });

  it("keeps null and empty policies identical to the legacy path", async () => {
    const nullPolicy = await callProxy(null);
    const emptyPolicy = await callProxy({});

    expect(nullPolicy.status).toBe(200);
    expect(emptyPolicy.status).toBe(200);
    expect(reserveBudgetMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails closed without a 500 when cached policy JSON or shape is malformed", async () => {
    verifyVisaMock.mockResolvedValueOnce(baseClaims);
    getCachedAgentPolicyMock.mockResolvedValueOnce("{not-json");
    const invalidJson = await POST(request(), {
      params: Promise.resolve({ provider: "openai", path: ["chat", "completions"] }),
    });
    const invalidShape = await callProxy({ max_requests_per_hour: -1 });

    expect(invalidJson.status).toBe(403);
    expect(invalidShape.status).toBe(403);
    expect(await invalidJson.json()).toEqual({ error: "blocked_policy" });
    expect(await invalidShape.json()).toEqual({ error: "blocked_policy" });
    expect(reserveBudgetMock).not.toHaveBeenCalled();
    expect(captureSecurityEventMock).toHaveBeenCalledWith(
      "proxy.blocked_policy_malformed",
      expect.objectContaining({ code: "blocked_policy_malformed" })
    );
  });

  it("enforces max_requests_per_hour with agent and tenant isolated keys", async () => {
    const counts = new Map<string, number>();
    rateLimitMock.mockImplementation(async (key: string, limit: number) => {
      if (key.startsWith("proxy:")) return { success: true, remaining: 1 };
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return { success: count <= limit, remaining: Math.max(0, limit - count) };
    });
    const policy = { max_requests_per_hour: 1 };

    const firstA = await callProxy(policy);
    const secondA = await callProxy(policy);
    const agentB = await callProxy(policy, { ...baseClaims, agid: "agent-b", jti: "jti-b" });
    const sameAgentOtherTenant = await callProxy(policy, {
      ...baseClaims,
      uid: "tenant-b",
      jti: "jti-tenant-b",
    });

    expect(firstA.status).toBe(200);
    expect(secondA.status).toBe(429);
    expect(await secondA.json()).toEqual({ error: "blocked_policy" });
    expect(agentB.status).toBe(200);
    expect(sameAgentOtherTenant.status).toBe(200);
    expect([...counts.keys()].sort()).toEqual([
      "policy-hour:tenant-a:agent-a",
      "policy-hour:tenant-a:agent-b",
      "policy-hour:tenant-b:agent-a",
    ]);
  });

  // A transient Supabase error is NOT the same as a malformed stored policy.
  // Malformed config is the owner's mistake and must fail closed (they can see
  // it in the dashboard and fix it). An unreadable row is an infrastructure
  // blip, and blocking on it would turn a database hiccup into a total gateway
  // outage for every agent — including the overwhelming majority that have no
  // policy at all and needed no `agents` read before this feature existed.
  // House precedent is lib/state/killswitch.ts: read failures fail OPEN unless
  // the operator opts into strict mode.
  it("fails OPEN when the policy row cannot be read, and closed when opted in", async () => {
    const unreadable = () => {
      const builder = {
        select: vi.fn(() => builder),
        eq: vi.fn(() => builder),
        maybeSingle: vi.fn(async () => ({ data: null, error: { message: "timeout" } })),
      };
      serviceClientMock.mockReturnValue({ from: vi.fn(() => builder), rpc: vi.fn() });
    };

    unreadable();
    verifyVisaMock.mockResolvedValueOnce(baseClaims);
    getCachedAgentPolicyMock.mockResolvedValueOnce(null);
    const open = await POST(request(), {
      params: Promise.resolve({ provider: "openai", path: ["chat", "completions"] }),
    });
    expect(open.status).toBe(200);

    process.env.POLICY_FAIL_CLOSED = "true";
    try {
      unreadable();
      verifyVisaMock.mockResolvedValueOnce(baseClaims);
      getCachedAgentPolicyMock.mockResolvedValueOnce(null);
      const closed = await POST(request(), {
        params: Promise.resolve({ provider: "openai", path: ["chat", "completions"] }),
      });
      expect(closed.status).toBe(403);
      expect(await closed.json()).toEqual({ error: "blocked_policy" });
    } finally {
      delete process.env.POLICY_FAIL_CLOSED;
    }
  });

  // A row that IS readable but holds garbage stays fail-closed regardless.
  it("still fails closed on a malformed stored policy even in fail-open mode", async () => {
    const builder = {
      select: vi.fn(() => builder),
      eq: vi.fn(() => builder),
      maybeSingle: vi.fn(async () => ({ data: { policy: { nope: 1 } }, error: null })),
    };
    serviceClientMock.mockReturnValue({ from: vi.fn(() => builder), rpc: vi.fn() });
    verifyVisaMock.mockResolvedValueOnce(baseClaims);
    getCachedAgentPolicyMock.mockResolvedValueOnce(null);

    const res = await POST(request(), {
      params: Promise.resolve({ provider: "openai", path: ["chat", "completions"] }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "blocked_policy" });
  });

  it("loads current policy on a cache miss with explicit tenant scope and a 60-second cache", async () => {
    const filters: Array<[string, unknown]> = [];
    const builder = {
      select: vi.fn(() => builder),
      eq: vi.fn((column: string, value: unknown) => {
        filters.push([column, value]);
        return builder;
      }),
      maybeSingle: vi.fn(async () => ({ data: { policy: null }, error: null })),
    };
    serviceClientMock.mockReturnValue({ from: vi.fn(() => builder), rpc: vi.fn() });
    verifyVisaMock.mockResolvedValueOnce(baseClaims);
    getCachedAgentPolicyMock.mockResolvedValueOnce(null);

    const res = await POST(request(), {
      params: Promise.resolve({ provider: "openai", path: ["chat", "completions"] }),
    });

    expect(res.status).toBe(200);
    expect(filters).toContainEqual(["user_id", "tenant-a"]);
    expect(filters).toContainEqual(["id", "agent-a"]);
    expect(setCachedAgentPolicyMock).toHaveBeenCalledWith(
      "tenant-a",
      "agent-a",
      "null",
      60
    );
  });

  it("enforces policy on the demo path as part of its real governance pipeline", async () => {
    process.env.PASSCONTROL_DEMO = "1";
    const claims = {
      ...baseClaims,
      scope: [{ provider: "demo", models: ["*"] }],
    };

    const res = await callProxy(
      { deny: [{ provider: "demo", models: ["demo-*"] }] },
      claims,
      "demo",
      "demo-1"
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "blocked_policy" });
    expect(reserveBudgetMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
