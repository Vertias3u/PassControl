import { describe, it, expect, vi, beforeEach } from "vitest";
import { clampLimit } from "@/lib/control/params";
import { jsonToBase64url } from "@/lib/encoding";

// --- auth + rate limit: a passing read key (the boundary is exercised elsewhere) ---
const authMock = vi.fn();
vi.mock("@/lib/control/auth", () => ({ authenticateApiKey: (...a: any[]) => authMock(...a) }));
vi.mock("@/lib/ratelimit", () => ({ rateLimit: async () => ({ success: true, remaining: 1 }) }));

// Chainable supabase mock recording .eq() filters; resolves to a per-test dataset.
let dataset: { data: unknown; error: unknown } = { data: [], error: null };
let rpcDataset: { data: unknown; error: unknown } = { data: [], error: null };
const eqCalls: [string, unknown][] = [];
const orCalls: string[] = [];
const builder = () => {
  const b: any = {
    select: () => b,
    eq: (col: string, val: unknown) => {
      eqCalls.push([col, val]);
      return b;
    },
    order: () => b,
    or: (value: string) => {
      orCalls.push(value);
      return b;
    },
    limit: () => b,
    maybeSingle: async () => dataset,
    then: (res: any) => res(dataset),
  };
  return b;
};
vi.mock("@/lib/supabase", () => ({
  serviceClient: () => ({
    from: () => builder(),
    rpc: async () => rpcDataset,
  }),
}));

const holdsMock = vi.fn();
vi.mock("@/lib/state/holds", () => ({ readReservedMany: (...args: unknown[]) => holdsMock(...args) }));

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
  orCalls.length = 0;
  dataset = { data: [], error: null };
  rpcDataset = {
    data: [{
      log_tokens: 0,
      log_microcents: 0,
      adjustment_tokens: 0,
      adjustment_microcents: 0,
      attributable_tokens: 0,
      attributable_microcents: 0,
      contributing_logs: 0,
      contributing_adjustments: 0,
      last_reconciled_at: null,
    }],
    error: null,
  };
  holdsMock.mockResolvedValue(new Map());
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

  it("returns a stable cursor and applies it as a created_at/id keyset", async () => {
    const createdAt = "2026-09-12T10:00:00.000Z";
    dataset = {
      data: [
        { id: "00000000-0000-4000-8000-000000000003", created_at: createdAt },
        { id: "00000000-0000-4000-8000-000000000002", created_at: createdAt },
      ],
      error: null,
    };
    const first = await (await getLogs(req("https://x/api/control/v1/logs?limit=1"))).json();
    expect(first.data).toHaveLength(1);
    expect(first.next_cursor).toEqual(expect.any(String));

    const cursor = jsonToBase64url({ created_at: createdAt, id: "00000000-0000-4000-8000-000000000002" });
    await getLogs(req(`https://x/api/control/v1/logs?cursor=${cursor}`));
    expect(orCalls.at(-1)).toContain("created_at.lt.2026-09-12T10:00:00.000Z");
    expect(orCalls.at(-1)).toContain("id.lt.00000000-0000-4000-8000-000000000002");
  });

  it("rejects malformed cursors without querying", async () => {
    const res = await getLogs(req("https://x/api/control/v1/logs?cursor=not-a-cursor"));
    expect(res.status).toBe(400);
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
    expect(body.data.fleet).toMatchObject({ spent_tokens: 150, spent_microcents: 20000 });
    expect(body.data.agents).toHaveLength(2);
  });

  /**
   * T4-02. This number is NOT observed provider cost, and returning it under a
   * bare `spent_microcents` said that it was.
   *
   * Postgres defines spend once, in 0055, as
   * `coalesce(enforced_microcents, coalesce(cost_microcents, 0))` — the amount
   * charged against the budget. For a call the gateway cannot price those two
   * differ: the audit row records `cost_microcents: null` and `unpriced: true`
   * while the enforcement figure is a conservative estimate taken from the
   * built-in provider's table. So the same call was reported as unknown on its
   * receipt and as a precise dollar figure here.
   *
   * The counter is deliberately unchanged — it is what `reconcile_agent_spend`
   * and `rebuild_agent_spend` both fold, and making this surface disagree with
   * the database's own definition would be a worse bug than the one being
   * fixed. What changes is the claim: the basis is now stated, so a consumer
   * persisting this cannot mistake it for money a provider actually charged.
   */
  it("states the basis of the figure rather than implying it is observed cost", async () => {
    dataset = {
      data: [{ id: "a1", name: "x", spent_tokens: 100, spent_microcents: 15000 }],
      error: null,
    };
    const body = await (await getSpend(req("https://x/api/control/v1/spend"))).json();

    expect(body.data.fleet.basis).toBe("enforced");
    expect(body.data.agents[0].basis).toBe("enforced");
  });

  it("explains settled charges, adjustments, differences, and open holds separately", async () => {
    dataset = {
      data: [{ id: "a1", name: "x", spent_tokens: 200, spent_microcents: 8_000_000 }],
      error: null,
    };
    rpcDataset = {
      data: [{
        log_tokens: 150,
        log_microcents: 3_093_700,
        adjustment_tokens: 25,
        adjustment_microcents: 2_000_000,
        attributable_tokens: 175,
        attributable_microcents: 5_093_700,
        contributing_logs: 2,
        contributing_adjustments: 1,
        last_reconciled_at: "2026-09-12T09:00:00Z",
      }],
      error: null,
    };
    holdsMock.mockResolvedValue(new Map([
      ["a1", { tokens: 40, microcents: 900_000, openHolds: 2 }],
    ]));

    const body = await (await getSpend(req("https://x/api/control/v1/spend"))).json();
    expect(body.data.reconciliation).toMatchObject({
      state: "pending",
      settled_microcents: 8_000_000,
      log_attributed_microcents: 3_093_700,
      adjustment_microcents: 2_000_000,
      difference_microcents: 2_906_300,
      holds_state: "available",
      open_reserved_microcents: 900_000,
      open_holds: 2,
    });
  });

  it("does not turn unavailable durable or Redis reads into zero", async () => {
    dataset = { data: [{ id: "a1", name: "x", spent_tokens: 3, spent_microcents: 7 }], error: null };
    rpcDataset = { data: null, error: { message: "migration missing" } };
    holdsMock.mockRejectedValue(new Error("redis unavailable"));
    const body = await (await getSpend(req("https://x/api/control/v1/spend"))).json();
    expect(body.data.reconciliation).toMatchObject({
      state: "unavailable",
      settled_microcents: 7,
      log_attributed_microcents: null,
      difference_microcents: null,
      holds_state: "unavailable",
      open_reserved_microcents: null,
      open_holds: null,
    });
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
