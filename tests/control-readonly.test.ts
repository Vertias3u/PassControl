import { describe, it, expect, vi, beforeEach } from "vitest";
import { clampLimit } from "@/lib/control/params";

// --- auth + rate limit: a passing read key (the boundary is exercised elsewhere) ---
const authMock = vi.fn();
vi.mock("@/lib/control/auth", () => ({ authenticateApiKey: (...a: any[]) => authMock(...a) }));
vi.mock("@/lib/ratelimit", () => ({ rateLimit: async () => ({ success: true, remaining: 1 }) }));

// Chainable supabase mock recording .eq() filters; resolves to a per-test dataset.
let dataset: { data: unknown; error: unknown } = { data: [], error: null };
const eqCalls: [string, unknown][] = [];
const builder = () => {
  const b: any = {
    select: () => b,
    eq: (col: string, val: unknown) => {
      eqCalls.push([col, val]);
      return b;
    },
    order: () => b,
    limit: () => b,
    maybeSingle: async () => dataset,
    then: (res: any) => res(dataset),
  };
  return b;
};
vi.mock("@/lib/supabase", () => ({ serviceClient: () => ({ from: () => builder() }) }));

// Redis-backed kill-state mock.
const killMock = vi.fn();
vi.mock("@/lib/state/killswitch", () => ({ readKillState: (...a: any[]) => killMock(...a) }));

import { GET as getLogs } from "@/app/api/control/v1/logs/route";
import { GET as getAudit } from "@/app/api/control/v1/audit/route";
import { GET as getSpend } from "@/app/api/control/v1/spend/route";
import { GET as getKill } from "@/app/api/control/v1/kill-switch/route";

const req = (url = "https://x/api/control/v1/x") =>
  new Request(url, { headers: { authorization: "Bearer pc_" + "a".repeat(40) } });

beforeEach(() => {
  authMock.mockResolvedValue({ ok: true, userId: "u1", scope: "read", keyId: "k1" });
  eqCalls.length = 0;
  dataset = { data: [], error: null };
});

describe("clampLimit", () => {
  it("defaults, bounds, and rejects junk", () => {
    expect(clampLimit(null)).toBe(50);
    expect(clampLimit("10")).toBe(10);
    expect(clampLimit("9999")).toBe(100); // hard cap
    expect(clampLimit("0")).toBe(1); // floor
    expect(clampLimit("-5")).toBe(1);
    expect(clampLimit("abc")).toBe(50); // fallback
  });
});

describe("GET /logs", () => {
  it("scopes to userId and applies agent_id + status filters", async () => {
    dataset = { data: [{ id: "l1" }], error: null };
    const res = await getLogs(req("https://x/api/control/v1/logs?agent_id=a1&status=ok"));
    expect(res.status).toBe(200);
    expect(eqCalls).toContainEqual(["user_id", "u1"]); // boundary
    expect(eqCalls).toContainEqual(["agent_id", "a1"]);
    expect(eqCalls).toContainEqual(["status", "ok"]);
    expect((await res.json()).data).toEqual([{ id: "l1" }]);
  });
});

describe("GET /audit", () => {
  it("scopes to userId and returns the trail", async () => {
    dataset = { data: [{ id: "ev1", action: "agent.create" }], error: null };
    const res = await getAudit(req("https://x/api/control/v1/audit"));
    expect(res.status).toBe(200);
    expect(eqCalls).toContainEqual(["user_id", "u1"]);
    expect((await res.json()).data[0].action).toBe("agent.create");
  });
});

describe("GET /spend", () => {
  it("scopes to userId and rolls up fleet totals (micro-cents)", async () => {
    dataset = {
      data: [
        { id: "a1", name: "x", spent_tokens: 100, spent_microcents: 15000 },
        { id: "a2", name: "y", spent_tokens: 50, spent_microcents: 5000 },
      ],
      error: null,
    };
    const res = await getSpend(req("https://x/api/control/v1/spend"));
    expect(res.status).toBe(200);
    expect(eqCalls).toContainEqual(["user_id", "u1"]);
    const body = await res.json();
    expect(body.data.fleet).toEqual({ spent_tokens: 150, spent_microcents: 20000 });
    expect(body.data.agents).toHaveLength(2);
  });
});

describe("GET /kill-switch", () => {
  it("reports the per-tenant kill state for the caller", async () => {
    killMock.mockResolvedValue({ userKill: true, platformKill: false, denylist: [] });
    const res = await getKill(req("https://x/api/control/v1/kill-switch"));
    expect(res.status).toBe(200);
    expect(killMock).toHaveBeenCalledWith("u1"); // scoped to caller
    expect((await res.json()).data).toEqual({ armed: true, platform_kill: false });
  });
});
