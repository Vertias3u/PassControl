import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The keyless `demo` provider must run the FULL governance pipeline (visa, kill,
// scope, budget) and only replace the Vault-key resolution + upstream forward
// with a locally synthesized response. These tests lock that contract:
//   - a governed demo call returns 200 WITHOUT calling get_provider_key or fetch
//   - the kill switch blocks it
//   - scope is enforced
//   - it is 404 (prod-safe) unless PASSCONTROL_DEMO=1
const {
  verifyVisaMock,
  serviceClientMock,
  reserveBudgetMock,
  reconcileBudgetMock,
  getCachedKeyMock,
  setCachedKeyMock,
  readKillStateMock,
  isSuspendedMock,
  writeLogMock,
  mirrorSpendMock,
  rateLimitMock,
  fetchMock,
} = vi.hoisted(() => {
  return {
    verifyVisaMock: vi.fn(),
    serviceClientMock: vi.fn(),
    reserveBudgetMock: vi.fn(),
    reconcileBudgetMock: vi.fn(),
    getCachedKeyMock: vi.fn(),
    setCachedKeyMock: vi.fn(),
    readKillStateMock: vi.fn(),
    isSuspendedMock: vi.fn(),
    writeLogMock: vi.fn(),
    mirrorSpendMock: vi.fn(),
    rateLimitMock: vi.fn(),
    fetchMock: vi.fn(),
  };
});

vi.mock("@vercel/functions", () => ({ waitUntil: (p: unknown) => p }));
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
  seedSpent: vi.fn(),
}));
vi.mock("@/lib/supabase", () => ({ serviceClient: () => serviceClientMock() }));
vi.mock("@/lib/crypto/aesgcm", () => ({ seal: async () => "sealed", open: async (v: string) => v }));
vi.mock("@/lib/log", () => ({
  writeLog: (...args: unknown[]) => writeLogMock(...args),
  mirrorSpend: (...args: unknown[]) => mirrorSpendMock(...args),
}));
vi.mock("@/lib/ratelimit", () => ({ rateLimit: (...args: unknown[]) => rateLimitMock(...args) }));

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
  scope: [{ provider: "demo", models: ["*"] }],
};

function demoRequest(body?: unknown) {
  return new Request("https://gateway.test/api/v1/demo/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer visa", "content-type": "application/json" },
    body: JSON.stringify(
      body ?? { model: "demo-1", max_tokens: 16, messages: [{ role: "user", content: "hi there" }] }
    ),
  });
}

async function callDemo(body?: unknown) {
  return POST(demoRequest(body), {
    params: Promise.resolve({ provider: "demo", path: ["chat", "completions"] }),
  });
}

beforeEach(() => {
  verifyVisaMock.mockReset();
  serviceClientMock.mockReset();
  reserveBudgetMock.mockReset();
  reconcileBudgetMock.mockReset();
  getCachedKeyMock.mockReset();
  setCachedKeyMock.mockReset();
  readKillStateMock.mockReset();
  isSuspendedMock.mockReset();
  writeLogMock.mockReset();
  mirrorSpendMock.mockReset();
  rateLimitMock.mockReset();
  fetchMock.mockReset();

  verifyVisaMock.mockResolvedValue(baseClaims);
  serviceClientMock.mockReturnValue({
    rpc: vi.fn(async () => ({ data: "SHOULD-NOT-RESOLVE-A-KEY", error: null })),
  });
  reserveBudgetMock.mockResolvedValue({ ok: true, reserved: 1 });
  reconcileBudgetMock.mockResolvedValue(undefined);
  getCachedKeyMock.mockResolvedValue(null);
  setCachedKeyMock.mockResolvedValue(undefined);
  readKillStateMock.mockResolvedValue({ platformKill: false, userKill: false, denylist: [] });
  isSuspendedMock.mockResolvedValue(false);
  writeLogMock.mockResolvedValue(undefined);
  mirrorSpendMock.mockResolvedValue(undefined);
  rateLimitMock.mockResolvedValue({ success: true, remaining: 1 });
  vi.stubGlobal("fetch", fetchMock);
  process.env.PASSCONTROL_DEMO = "1";
});

afterEach(() => {
  delete process.env.PASSCONTROL_DEMO;
});

describe("keyless demo provider", () => {
  it("governs a demo call and returns 200 without touching the Vault or upstream", async () => {
    const rpc = vi.fn(async () => ({ data: "SHOULD-NOT-RESOLVE-A-KEY", error: null }));
    serviceClientMock.mockReturnValue({ rpc });

    const res = await callDemo();

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(JSON.stringify(json)).toMatch(/demo/i);
    // The whole point: the credential path is never reached.
    expect(rpc).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    // But governance IS real: budget reserved + reconciled, logged as ok.
    expect(reserveBudgetMock).toHaveBeenCalled();
    expect(reconcileBudgetMock).toHaveBeenCalled();
    expect(writeLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "demo", status: "ok" })
    );
  });

  it("blocks a demo call when the kill switch is armed", async () => {
    readKillStateMock.mockResolvedValue({ platformKill: false, userKill: true, denylist: [] });

    const res = await callDemo();

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "blocked_suspended" });
    expect(reserveBudgetMock).not.toHaveBeenCalled();
  });

  it("enforces scope on demo calls", async () => {
    verifyVisaMock.mockResolvedValue({
      ...baseClaims,
      scope: [{ provider: "openai", models: ["*"] }],
    });

    const res = await callDemo();

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "blocked_scope" });
  });

  it("is 404 (prod-safe) unless PASSCONTROL_DEMO is enabled", async () => {
    delete process.env.PASSCONTROL_DEMO;

    const res = await callDemo();

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown_provider" });
  });

  it("requires a visa", async () => {
    const req = new Request("https://gateway.test/api/v1/demo/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const res = await POST(req, {
      params: Promise.resolve({ provider: "demo", path: ["chat", "completions"] }),
    });
    expect(res.status).toBe(401);
  });
});
