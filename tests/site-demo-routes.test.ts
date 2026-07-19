import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The public site demo is intentionally an adapter around the existing gateway
// handlers. These tests exercise that adapter with the real challenge signing,
// visa mint/verify, scope, kill-switch, and budget code paths while replacing
// only infrastructure (Postgres/Redis). No network fetch or Vault RPC is allowed.
const {
  serviceClientMock,
  fromMock,
  agentLookupMock,
  eqMock,
  rpcMock,
  mintVisaMock,
  rateLimitMock,
  readKillStateMock,
  armTenantKillMock,
  claimNonceMock,
  touchLastSeenMock,
  isSuspendedMock,
  reserveBudgetMock,
  reconcileBudgetMock,
  seedSpentMock,
  writeLogMock,
  mirrorSpendMock,
  fetchMock,
  demoPassportSecretMock,
} = vi.hoisted(() => ({
  serviceClientMock: vi.fn(),
  fromMock: vi.fn(),
  agentLookupMock: vi.fn(),
  eqMock: vi.fn(),
  rpcMock: vi.fn(),
  mintVisaMock: vi.fn(),
  rateLimitMock: vi.fn(),
  readKillStateMock: vi.fn(),
  armTenantKillMock: vi.fn(),
  claimNonceMock: vi.fn(),
  touchLastSeenMock: vi.fn(),
  isSuspendedMock: vi.fn(),
  reserveBudgetMock: vi.fn(),
  reconcileBudgetMock: vi.fn(),
  seedSpentMock: vi.fn(),
  writeLogMock: vi.fn(),
  mirrorSpendMock: vi.fn(),
  fetchMock: vi.fn(),
  demoPassportSecretMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@vercel/functions", () => ({ waitUntil: (promise: unknown) => promise }));
vi.mock("@/lib/supabase", () => ({ serviceClient: () => serviceClientMock() }));
vi.mock("@/lib/ratelimit", () => ({
  rateLimit: (...args: unknown[]) => rateLimitMock(...args),
}));
vi.mock("@/lib/state/killswitch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/state/killswitch")>();
  return {
    ...actual,
    readKillState: (...args: unknown[]) => readKillStateMock(...args),
    armTenantKill: (...args: unknown[]) => armTenantKillMock(...args),
  };
});
vi.mock("@/lib/state/redis", () => ({
  claimNonce: (...args: unknown[]) => claimNonceMock(...args),
  touchLastSeen: (...args: unknown[]) => touchLastSeenMock(...args),
  isSuspended: (...args: unknown[]) => isSuspendedMock(...args),
  reserveBudget: (...args: unknown[]) => reserveBudgetMock(...args),
  reconcileBudget: (...args: unknown[]) => reconcileBudgetMock(...args),
  seedSpent: (...args: unknown[]) => seedSpentMock(...args),
  getCachedKey: vi.fn(),
  setCachedKey: vi.fn(),
}));
vi.mock("@/lib/crypto/aesgcm", () => ({ seal: async () => "sealed", open: async (v: string) => v }));
vi.mock("@/lib/log", () => ({
  writeLog: (...args: unknown[]) => writeLogMock(...args),
  mirrorSpend: (...args: unknown[]) => mirrorSpendMock(...args),
}));
vi.mock("@/lib/observability", () => ({
  captureError: vi.fn(async () => undefined),
  captureSecurityEvent: vi.fn(async () => undefined),
}));
vi.mock("@/lib/demo/identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/demo/identity")>();
  return {
    ...actual,
    demoPassportSecret: () => {
      demoPassportSecretMock();
      return actual.demoPassportSecret();
    },
  };
});
vi.mock("@/lib/auth/visa", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/visa")>();
  return {
    ...actual,
    mintVisa: (...args: Parameters<typeof actual.mintVisa>) => {
      mintVisaMock(...args);
      return actual.mintVisa(...args);
    },
  };
});

import { POST as runDemo } from "@/app/api/demo/run/route";
import { POST as setDemoKill } from "@/app/api/demo/kill/route";
import { SEEDED_DEMO_PASSPORT_ID } from "@/lib/demo/identity";

const DEMO_AGENT = {
  id: "demo-agent-id",
  user_id: "demo-user-id",
  status: "active",
  allowed_scopes: [{ provider: "demo", models: ["*"] }],
  budget_tokens: 200_000,
  budget_cents: null,
  spent_tokens: 0,
  spent_microcents: 0,
};

function jsonRequest(path: string, body: unknown) {
  return new Request(`https://passcontrol.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.10",
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  serviceClientMock.mockReset();
  fromMock.mockReset();
  agentLookupMock.mockReset();
  eqMock.mockReset();
  rpcMock.mockReset();
  mintVisaMock.mockReset();
  rateLimitMock.mockReset();
  readKillStateMock.mockReset();
  armTenantKillMock.mockReset();
  claimNonceMock.mockReset();
  touchLastSeenMock.mockReset();
  isSuspendedMock.mockReset();
  reserveBudgetMock.mockReset();
  reconcileBudgetMock.mockReset();
  seedSpentMock.mockReset();
  writeLogMock.mockReset();
  mirrorSpendMock.mockReset();
  fetchMock.mockReset();
  demoPassportSecretMock.mockReset();

  fromMock.mockImplementation((table: string) => {
    expect(table).toBe("agents");
    const query: Record<string, unknown> = {};
    query.select = vi.fn(() => query);
    query.eq = vi.fn((...args: unknown[]) => {
      eqMock(...args);
      return query;
    });
    query.maybeSingle = vi.fn(() => agentLookupMock());
    return query;
  });
  serviceClientMock.mockReturnValue({ from: fromMock, rpc: rpcMock });
  agentLookupMock.mockResolvedValue({ data: DEMO_AGENT, error: null });
  rateLimitMock.mockResolvedValue({ success: true, remaining: 1 });
  readKillStateMock.mockResolvedValue({ platformKill: false, userKill: false, denylist: [] });
  armTenantKillMock.mockResolvedValue(undefined);
  claimNonceMock.mockResolvedValue(true);
  touchLastSeenMock.mockResolvedValue(undefined);
  isSuspendedMock.mockResolvedValue(false);
  reserveBudgetMock.mockResolvedValue({ ok: true, reserved: 1 });
  reconcileBudgetMock.mockResolvedValue(undefined);
  seedSpentMock.mockResolvedValue(undefined);
  writeLogMock.mockResolvedValue(undefined);
  mirrorSpendMock.mockResolvedValue(undefined);

  vi.stubGlobal("fetch", fetchMock);
  process.env.PASSCONTROL_DEMO = "1";
  process.env.VISA_SECRET = "test-visa-secret-that-is-at-least-32-bytes-long";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.PASSCONTROL_DEMO;
  delete process.env.PASSCONTROL_DEMO_TENANT_ID;
  delete process.env.VISA_SECRET;
});

describe("public demo safety gates", () => {
  it("is prod-safe when PASSCONTROL_DEMO is unset", async () => {
    delete process.env.PASSCONTROL_DEMO;

    const runResponse = await runDemo(
      jsonRequest("/api/demo/run", { prompt: "This must not run" })
    );
    const killResponse = await setDemoKill(
      jsonRequest("/api/demo/kill", { armed: true })
    );

    expect(runResponse.status).toBe(404);
    expect(killResponse.status).toBe(404);
    expect(fromMock).not.toHaveBeenCalled();
    expect(mintVisaMock).not.toHaveBeenCalled();
    expect(reserveBudgetMock).not.toHaveBeenCalled();
    expect(armTenantKillMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/demo/run", () => {
  it("allows the demo-only agent through without touching the Vault or an upstream", async () => {
    const response = await runDemo(
      jsonRequest("/api/demo/run", { prompt: "Say hello in 3 words" })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      blocked: false,
      response: expect.stringMatching(/^\[demo\]/),
    });
    expect(eqMock).toHaveBeenCalledWith("passport_pubkey", SEEDED_DEMO_PASSPORT_ID);
    expect(reserveBudgetMock).toHaveBeenCalled();
    expect(reconcileBudgetMock).toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an agent with any non-demo provider scope before key access", async () => {
    agentLookupMock.mockResolvedValue({
      data: {
        ...DEMO_AGENT,
        allowed_scopes: [
          { provider: "demo", models: ["*"] },
          { provider: "openai", models: ["*"] },
        ],
      },
      error: null,
    });

    const response = await runDemo(
      jsonRequest("/api/demo/run", { prompt: "This must not run" })
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      blocked: false,
      response: "demo temporarily unavailable",
    });
    expect(demoPassportSecretMock).not.toHaveBeenCalled();
    expect(mintVisaMock).not.toHaveBeenCalled();
    expect(reserveBudgetMock).not.toHaveBeenCalled();
  });

  it("returns blocked (403) when the demo tenant kill switch is armed", async () => {
    readKillStateMock.mockResolvedValue({ platformKill: false, userKill: true, denylist: [] });

    const response = await runDemo(jsonRequest("/api/demo/run", { prompt: "Same call" }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      ok: false,
      blocked: true,
      response: "blocked (403)",
    });
    expect(reserveBudgetMock).not.toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is hard rate-limited before signing a challenge", async () => {
    rateLimitMock.mockImplementation(async (key: string) => ({
      success: !key.startsWith("demo-run:"),
      remaining: 0,
    }));

    const response = await runDemo(jsonRequest("/api/demo/run", { prompt: "Hello" }));

    expect(response.status).toBe(429);
    expect(fromMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/demo/kill", () => {
  it("allows the demo-only agent to toggle only its fixed tenant", async () => {
    const armed = await setDemoKill(
      jsonRequest("/api/demo/kill", { armed: true, user_id: "real-user-id" })
    );
    const disarmed = await setDemoKill(jsonRequest("/api/demo/kill", { armed: false }));

    expect(armed.status).toBe(200);
    expect(await armed.json()).toEqual({ ok: true, armed: true });
    expect(disarmed.status).toBe(200);
    expect(await disarmed.json()).toEqual({ ok: true, armed: false });
    expect(eqMock).toHaveBeenCalledWith("passport_pubkey", SEEDED_DEMO_PASSPORT_ID);
    expect(armTenantKillMock).toHaveBeenNthCalledWith(1, "demo-user-id", true);
    expect(armTenantKillMock).toHaveBeenNthCalledWith(2, "demo-user-id", false);
    expect(armTenantKillMock).not.toHaveBeenCalledWith("real-user-id", expect.anything());
  });

  it("is hard rate-limited before resolving or changing the demo tenant", async () => {
    rateLimitMock.mockImplementation(async (key: string) => ({
      success: !key.startsWith("demo-kill:"),
      remaining: 0,
    }));

    const response = await setDemoKill(jsonRequest("/api/demo/kill", { armed: true }));

    expect(response.status).toBe(429);
    expect(fromMock).not.toHaveBeenCalled();
    expect(armTenantKillMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "has any non-demo provider scope",
      agent: {
        ...DEMO_AGENT,
        allowed_scopes: [
          { provider: "demo", models: ["*"] },
          { provider: "openai", models: ["*"] },
        ],
      },
    },
    {
      label: "is not active",
      agent: { ...DEMO_AGENT, status: "suspended" },
    },
    {
      label: "does not exist",
      agent: null,
    },
  ])("refuses to change kill state when the demo agent $label", async ({ agent }) => {
    agentLookupMock.mockResolvedValue({ data: agent, error: null });

    const response = await setDemoKill(
      jsonRequest("/api/demo/kill", { armed: true })
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "demo_unavailable" });
    expect(armTenantKillMock).not.toHaveBeenCalled();
  });

  it("refuses to change kill state when the optional tenant pin does not match", async () => {
    process.env.PASSCONTROL_DEMO_TENANT_ID = "a-different-tenant";

    const response = await setDemoKill(
      jsonRequest("/api/demo/kill", { armed: true })
    );

    expect(response.status).toBe(503);
    expect(armTenantKillMock).not.toHaveBeenCalled();
  });
});
