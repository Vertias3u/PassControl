import { describe, it, expect, vi, beforeEach } from "vitest";

// The operator recovery surface: read the holds an agent is still carrying,
// decide one, and rebuild a counter set from the record.
//
// Auth, rate limiting and the Redis/Lua boundary are mocked. What is under test
// here is the WIRING — scope, tenant scoping, validation, audit, and the two
// side effects that are easy to omit and impossible to notice: the mandatory
// policy purge after a rebuild, and an audit row on a resolve that did nothing.
const {
  authMock,
  auditMock,
  listOpenHolds,
  resolveHold,
  releaseUndispatched,
  rebuildBudgetState,
  purgeAgentPolicy,
} = vi.hoisted(() => ({
  authMock: vi.fn(),
  auditMock: vi.fn(),
  listOpenHolds: vi.fn(),
  resolveHold: vi.fn(),
  releaseUndispatched: vi.fn(),
  rebuildBudgetState: vi.fn(),
  purgeAgentPolicy: vi.fn(),
}));

vi.mock("@/lib/control/auth", () => ({ authenticateApiKey: (...a: any[]) => authMock(...a) }));
vi.mock("@/lib/ratelimit", () => ({ rateLimit: async () => ({ success: true, remaining: 1 }) }));
vi.mock("@/lib/audit", () => ({ recordAdminAction: (...a: any[]) => auditMock(...a) }));
vi.mock("@/lib/state/holds", () => ({
  listOpenHolds: (...a: any[]) => listOpenHolds(...a),
  resolveHold: (...a: any[]) => resolveHold(...a),
  releaseUndispatched: (...a: any[]) => releaseUndispatched(...a),
  rebuildBudgetState: (...a: any[]) => rebuildBudgetState(...a),
}));
vi.mock("@/lib/state/redis", () => ({ purgeAgentPolicy: (...a: any[]) => purgeAgentPolicy(...a) }));

const db = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/supabase", () => ({ serviceClient: () => db.current }));

import { GET as holdsRoute } from "@/app/api/control/v1/agents/[id]/holds/route";
import { POST as resolveRoute } from "@/app/api/control/v1/agents/[id]/holds/[attemptId]/resolve/route";
import { POST as rebuildRoute } from "@/app/api/control/v1/agents/[id]/budget/rebuild/route";

const AGENT = "11111111-1111-1111-1111-111111111111";
const ATTEMPT = "22222222-2222-2222-2222-222222222222";
const KEY = { authorization: "Bearer pc_" + "a".repeat(40) };
/** The tenant every request here authenticates as, and one that isn't. */
const USER = "u1";
const FOREIGN_USER = "another-tenant";

/**
 * A Supabase stand-in that answers ONE agent row and one RPC.
 *
 * `owned: false` does NOT mean "the row is missing". It models the case that
 * actually threatens the tenant boundary: the agent EXISTS under the requested
 * id and belongs to somebody else. The stand-in applies the route's own `.eq()`
 * predicates, so that row disappears only if the route really filters on the
 * caller's tenant. An earlier version returned null regardless of the query,
 * which stayed green with the user_id filter deleted from the route — a false
 * gate on all three routes here (Session 02 part 7).
 *
 * What a caller sees is still one indistinguishable outcome: absent and
 * someone else's must both answer 404.
 */
function fakeDb(opts: {
  owned?: boolean;
  row?: Record<string, unknown>;
  selectError?: boolean;
  rpc?: { spent_tokens: number; spent_microcents: number };
  rpcError?: boolean;
  updateError?: boolean;
  /** Postgres error the ledger insert should fail with, e.g. { code: "23505" }. */
  insertError?: { code?: string; message?: string };
}) {
  const updates: Record<string, unknown>[] = [];
  const inserts: Record<string, unknown>[] = [];
  const rpcCalls: any[] = [];
  const stored: Record<string, unknown> = {
    id: AGENT,
    user_id: opts.owned === false ? FOREIGN_USER : USER,
    ...(opts.row ?? {}),
  };
  // One builder per from(), so predicates from one query never leak into the next.
  const builder = () => {
    const filters: Record<string, unknown> = {};
    const b: any = {
      select: () => b,
      eq: (column: string, value: unknown) => {
        filters[column] = value;
        return b;
      },
      maybeSingle: async () =>
        opts.selectError
          ? { data: null, error: { message: "boom" } }
          : {
              data: Object.entries(filters).every(([column, value]) => stored[column] === value)
                ? stored
                : null,
              error: null,
            },
      insert: async (values: Record<string, unknown>) => {
        inserts.push(values);
        return { data: null, error: opts.insertError ?? null };
      },
      update: (values: Record<string, unknown>) => {
        updates.push(values);
        // The update builder is awaited directly after .eq(), so the chain link
        // has to be thenable rather than another builder.
        const u: any = {
          eq: () => Promise.resolve(opts.updateError ? { error: { message: "boom" } } : { error: null }),
        };
        return u;
      },
    };
    return b;
  };
  return {
    inserts,
    client: {
      from: () => builder(),
      rpc: async (name: string, args: unknown) => {
        rpcCalls.push({ name, args });
        return opts.rpcError
          ? { data: null, error: { message: "boom" } }
          : { data: [{ agent_id: AGENT, ...(opts.rpc ?? { spent_tokens: 0, spent_microcents: 0 }) }], error: null };
      },
    },
    updates,
    rpcCalls,
  };
}

const rebuildResult = (over: Record<string, unknown> = {}) => ({
  reservedTokens: 0,
  reservedMicrocents: 0,
  computedReservedTokens: 0,
  computedReservedMicrocents: 0,
  openHolds: 0,
  seededReserved: false,
  truncated: false,
  ...over,
});

const get = (url: string) => new Request(url, { headers: KEY });
const post = (url: string, body: unknown) =>
  new Request(url, {
    method: "POST",
    headers: { ...KEY, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const ctx = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) });

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ ok: true, userId: "u1", scope: "write", keyId: "k1" });
  listOpenHolds.mockResolvedValue([]);
  resolveHold.mockResolvedValue({ applied: true, appliedTokens: 0, appliedMicrocents: 0 });
  releaseUndispatched.mockResolvedValue({ applied: true, appliedTokens: 0, appliedMicrocents: 0 });
  rebuildBudgetState.mockResolvedValue(rebuildResult());
  purgeAgentPolicy.mockResolvedValue(undefined);
});

describe("GET /agents/{id}/holds", () => {
  it("lists open holds with both estimates and an age", async () => {
    db.current = fakeDb({}).client;
    listOpenHolds.mockResolvedValue([
      {
        attemptId: ATTEMPT,
        createdAtMs: 1_700_000_000_000,
        ageMs: 4242,
        estimateTokens: 900,
        estimateMicrocents: 5,
        provider: "anthropic",
        model: "claude-opus-5",
      },
    ]);
    const res = await holdsRoute(get(`https://x/api/control/v1/agents/${AGENT}/holds`), ctx({ id: AGENT }));
    expect(res.status).toBe(200);
    expect((await res.json()).data.holds).toEqual([
      {
        attempt_id: ATTEMPT,
        created_at: "2023-11-14T22:13:20.000Z",
        age_ms: 4242,
        estimate_tokens: 900,
        estimate_microcents: 5,
        provider: "anthropic",
        model: "claude-opus-5",
      },
    ]);
  });

  // The identifying half. An abandoned attempt writes no agent_logs row, so
  // there is no receipt and the attempt id appears nowhere else — provider,
  // model and started-at are the whole basis for finding the call on the
  // provider's billing page. A hold opened before these existed reports null
  // rather than an empty string, so "unknown" is legible as unknown.
  it("reports an older hold's missing provider and model as null", async () => {
    db.current = fakeDb({}).client;
    listOpenHolds.mockResolvedValue([
      { attemptId: ATTEMPT, createdAtMs: 0, ageMs: 0, estimateTokens: 1, estimateMicrocents: 0, provider: "", model: "" },
    ]);
    const res = await holdsRoute(get(`https://x/api/control/v1/agents/${AGENT}/holds`), ctx({ id: AGENT }));
    expect((await res.json()).data.holds[0]).toMatchObject({
      provider: null,
      model: null,
      created_at: null,
    });
  });

  // The trust boundary this route lives on. Hold keys are namespaced by agent id
  // ALONE, so an id guessed out of another tenant's receipt would otherwise read
  // back their in-flight spending. The tenant check has to happen BEFORE the
  // Redis read, not just before the response.
  it("does not read Redis for an agent this key does not own", async () => {
    db.current = fakeDb({ owned: false }).client;
    const res = await holdsRoute(get(`https://x/api/control/v1/agents/${AGENT}/holds`), ctx({ id: AGENT }));
    expect(res.status).toBe(404);
    expect(listOpenHolds).not.toHaveBeenCalled();
  });

  // Cleared a full page and stopped is the failure mode: the procedure is "work
  // through these one at a time", so a page boundary that looks like the end of
  // the list reads as "finished" to the person doing it.
  it("says so when there are more holds than one page", async () => {
    db.current = fakeDb({}).client;
    listOpenHolds.mockResolvedValue(
      Array.from({ length: 200 }, (_, i) => ({
        attemptId: `a${i}`,
        createdAtMs: 1,
        ageMs: 1,
        estimateTokens: 1,
        estimateMicrocents: 0,
        provider: "anthropic",
        model: "m",
      }))
    );
    const res = await holdsRoute(get(`https://x/api/control/v1/agents/${AGENT}/holds`), ctx({ id: AGENT }));
    expect((await res.json()).data.truncated).toBe(true);
  });

  it("does not claim truncation on a short list", async () => {
    db.current = fakeDb({}).client;
    const res = await holdsRoute(get(`https://x/api/control/v1/agents/${AGENT}/holds`), ctx({ id: AGENT }));
    expect((await res.json()).data.truncated).toBe(false);
  });

  it("rejects a malformed id before touching the database", async () => {
    db.current = fakeDb({}).client;
    const res = await holdsRoute(get("https://x/api/control/v1/agents/nope/holds"), ctx({ id: "nope" }));
    expect(res.status).toBe(400);
    expect(listOpenHolds).not.toHaveBeenCalled();
  });
});

describe("POST /agents/{id}/holds/{attemptId}/resolve", () => {
  const url = `https://x/api/control/v1/agents/${AGENT}/holds/${ATTEMPT}/resolve`;
  const params = { id: AGENT, attemptId: ATTEMPT };

  it("requires write scope, and moves nothing on a read key", async () => {
    authMock.mockResolvedValue({ ok: true, userId: "u1", scope: "read", keyId: "k1" });
    db.current = fakeDb({}).client;
    const res = await resolveRoute(post(url, { outcome: "not_spent" }), ctx(params));
    expect(res.status).toBe(403);
    expect(releaseUndispatched).not.toHaveBeenCalled();
    expect(resolveHold).not.toHaveBeenCalled();
  });

  it("persists a degraded operator charge in the ledger that budget rebuild reads", async () => {
    // An abandoned dispatched attempt has no proxy agent_logs row. Lua has
    // closed it without moving counters; admin_audit is NOT an input to
    // agent_log_spend_rows / rebuild_agent_spend (migration 0055).
    const fake = fakeDb({});
    const writes: { table: string; row: Record<string, unknown> }[] = [];
    db.current = {
      ...fake.client,
      from: (table: string) => ({
        ...fake.client.from(),
        insert: async (value: Record<string, unknown> | Record<string, unknown>[]) => {
          for (const row of Array.isArray(value) ? value : [value]) writes.push({ table, row });
          return { data: null, error: null };
        },
      }),
    };
    resolveHold.mockResolvedValue({
      applied: false, degraded: true, appliedTokens: 1200, appliedMicrocents: 340,
    });
    const res = await resolveRoute(
      post(url, { outcome: "spent", tokens: 1200, microcents: 340 }), ctx(params)
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({
      state_lost: true, applied_tokens: 1200, applied_microcents: 340,
    });
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "budget.hold_resolve",
      metadata: expect.objectContaining({ state_lost: true, applied_tokens: 1200 }),
    }));
    // Session 02's assertion, with ONE change and no weakening: the table.
    // It asked for an `agent_logs` row, which three existing invariants forbid —
    // 0006 (append-only), 0026's identity CHECK (an operator recovery has no
    // visa and no key to satisfy it), and tests/agent-logs-identity-contract's
    // "exactly one application writer", which failed on the first attempt at
    // this. The property it was actually testing — the charge must reach the
    // input `rebuild_agent_spend` reads — is unchanged and is asserted here.
    // Migration 0056 makes that input `agent_log_spend_rows` PLUS adjustments
    // for attempts the ledger never recorded.
    expect(writes, "closed charge never entered the rebuild input").toEqual(
      expect.arrayContaining([expect.objectContaining({
        table: "agent_spend_adjustments",
        row: expect.objectContaining({
          agent_id: AGENT, attempt_id: ATTEMPT, tokens: 1200, microcents: 340,
        }),
      })])
    );
  });

  it("admits and persists an in-range tenfold operator overstatement", async () => {
    const fake = fakeDb({});
    db.current = fake.client;
    resolveHold.mockResolvedValue({
      applied: false, degraded: true, appliedTokens: 194120, appliedMicrocents: 21560000,
    });
    const res = await resolveRoute(
      post(url, { outcome: "spent", tokens: 194120, microcents: 21560000 }), ctx(params)
    );
    expect(res.status).toBe(200);
    expect(resolveHold).toHaveBeenCalledWith({
      agentId: AGENT, attemptId: ATTEMPT, tokens: 194120, microcents: 21560000,
    });
    expect(fake.inserts).toContainEqual(expect.objectContaining({
      attempt_id: ATTEMPT, tokens: 194120, microcents: 21560000,
    }));
  });

  it("charges what the operator says was spent", async () => {
    db.current = fakeDb({}).client;
    resolveHold.mockResolvedValue({ applied: true, appliedTokens: 1200, appliedMicrocents: 340 });
    const res = await resolveRoute(post(url, { outcome: "spent", tokens: 1200, microcents: 340 }), ctx(params));
    expect(res.status).toBe(200);
    expect(resolveHold).toHaveBeenCalledWith({
      agentId: AGENT,
      attemptId: ATTEMPT,
      tokens: 1200,
      microcents: 340,
    });
    expect((await res.json()).data).toMatchObject({
      applied: true,
      applied_tokens: 1200,
      applied_microcents: 340,
    });
  });

  // "spent 0" and "not spent" are numerically identical and mean different
  // things: one says the call reached a provider and was free, the other says it
  // never left. They must not collapse into the same transition.
  it("accepts an explicit zero, and keeps it distinct from a release", async () => {
    db.current = fakeDb({}).client;
    const res = await resolveRoute(post(url, { outcome: "spent", tokens: 0, microcents: 0 }), ctx(params));
    expect(res.status).toBe(200);
    expect(resolveHold).toHaveBeenCalledTimes(1);
    expect(releaseUndispatched).not.toHaveBeenCalled();
  });

  it("releases the whole hold on not_spent", async () => {
    db.current = fakeDb({}).client;
    await resolveRoute(post(url, { outcome: "not_spent" }), ctx(params));
    expect(releaseUndispatched).toHaveBeenCalledWith({ agentId: AGENT, attemptId: ATTEMPT });
    expect(resolveHold).not.toHaveBeenCalled();
  });

  // The compare-and-set upstream already makes a double refund impossible. What
  // this pins is that the SECOND caller is told so, and that the row it reports
  // is the first resolution's — not a second one that never happened.
  it("reports a replay as applied:false and still audits it", async () => {
    db.current = fakeDb({}).client;
    resolveHold.mockResolvedValue({ applied: false, appliedTokens: 55, appliedMicrocents: 7 });
    const res = await resolveRoute(post(url, { outcome: "spent", tokens: 999, microcents: 999 }), ctx(params));

    expect((await res.json()).data).toMatchObject({
      applied: false,
      applied_tokens: 55,
      applied_microcents: 7,
    });
    // Requested and applied recorded separately: a trail carrying only the
    // request would read as two charges where there was one.
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "budget.hold_resolve",
        metadata: expect.objectContaining({
          applied: false,
          requested_tokens: 999,
          applied_tokens: 55,
        }),
      })
    );
  });

  it("surfaces an attempt id with no hold behind it", async () => {
    db.current = fakeDb({}).client;
    resolveHold.mockResolvedValue({ applied: false, appliedTokens: 0, appliedMicrocents: 0, anomaly: true });
    const res = await resolveRoute(post(url, { outcome: "spent", tokens: 1 }), ctx(params));
    expect((await res.json()).data.unknown_attempt).toBe(true);
  });

  it("filters a real foreign-agent candidate out before resolving its hold", async () => {
    // A candidate exists under the requested id. It is invisible ONLY if the
    // route actually includes the caller's tenant predicate. fakeDb(owned:false)
    // cannot prove that: its eq is a no-op and it always returns null.
    const foreignAgent = { id: AGENT, user_id: "another-tenant" };
    const filters: Record<string, unknown> = {};
    const query: any = {
      select: () => query,
      eq: (column: string, value: unknown) => {
        filters[column] = value;
        return query;
      },
      maybeSingle: async () => ({
        data: Object.entries(filters).every(
          ([column, value]) => foreignAgent[column as keyof typeof foreignAgent] === value
        ) ? foreignAgent : null,
        error: null,
      }),
    };
    db.current = { from: () => query };
    const res = await resolveRoute(post(url, { outcome: "not_spent" }), ctx(params));
    expect(res.status).toBe(404);
    expect(releaseUndispatched).not.toHaveBeenCalled();
    expect(resolveHold).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("refuses another tenant's hold without touching it", async () => {
    db.current = fakeDb({ owned: false }).client;
    const res = await resolveRoute(post(url, { outcome: "not_spent" }), ctx(params));
    expect(res.status).toBe(404);
    expect(releaseUndispatched).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown outcome", { outcome: "maybe" }],
    // The one an operator reaches by being brief. Omitted amounts default to
    // zero, so this body would charge nothing — from the endpoint that exists
    // to make sure real spending IS charged.
    ["a spend that names no amount", { outcome: "spent" }],
    ["no outcome at all", {}],
    ["a negative amount", { outcome: "spent", tokens: -1 }],
    ["a non-numeric amount", { outcome: "spent", microcents: "lots" }],
    ["an implausible token count", { outcome: "spent", tokens: 1e12 }],
    ["an implausible cost", { outcome: "spent", microcents: 1e12 }],
  ])("rejects %s", async (_label, body) => {
    db.current = fakeDb({}).client;
    const res = await resolveRoute(post(url, body), ctx(params));
    expect(res.status).toBe(400);
    expect(resolveHold).not.toHaveBeenCalled();
    expect(releaseUndispatched).not.toHaveBeenCalled();
  });

  // The ceiling has to sit ABOVE what a hold can reserve. Capped too low, a
  // large call becomes a hold whose only acceptable resolution is `not_spent` —
  // the endpoint would refuse the truthful answer and accept only the one that
  // hands the money back. $50 is an ordinary enough figure that refusing it
  // would be that bug; the units are µ¢ (1 USD = 100_000_000).
  it("accepts a charge far larger than a single dollar", async () => {
    db.current = fakeDb({}).client;
    const res = await resolveRoute(
      post(url, { outcome: "spent", tokens: 900_000, microcents: 5_000_000_000 }),
      ctx(params)
    );
    expect(res.status).toBe(200);
    expect(resolveHold).toHaveBeenCalledWith(
      expect.objectContaining({ microcents: 5_000_000_000 })
    );
  });

  it("rejects a malformed attempt id", async () => {
    db.current = fakeDb({}).client;
    const res = await resolveRoute(post(url, { outcome: "not_spent" }), ctx({ id: AGENT, attemptId: "nope" }));
    expect(res.status).toBe(400);
    expect(releaseUndispatched).not.toHaveBeenCalled();
  });
});

describe("POST /agents/{id}/budget/rebuild", () => {
  const url = `https://x/api/control/v1/agents/${AGENT}/budget/rebuild`;
  const params = { id: AGENT };

  it("requires write scope — this is the only counter-lowering in the product", async () => {
    authMock.mockResolvedValue({ ok: true, userId: "u1", scope: "read", keyId: "k1" });
    db.current = fakeDb({}).client;
    const res = await rebuildRoute(post(url, {}), ctx(params));
    expect(res.status).toBe(403);
    expect(rebuildBudgetState).not.toHaveBeenCalled();
  });

  it("rebuilds from the record, rebases Redis onto a new epoch, and audits it", async () => {
    const fake = fakeDb({
      row: { budget_epoch: "old-epoch" },
      rpc: { spent_tokens: 4200, spent_microcents: 830 },
    });
    db.current = fake.client;
    rebuildBudgetState.mockResolvedValue(rebuildResult({ reservedTokens: 700, reservedMicrocents: 12, openHolds: 2 }));

    const res = await rebuildRoute(post(url, {}), ctx(params));
    expect(res.status).toBe(200);
    const { data } = await res.json();

    expect(fake.rpcCalls).toEqual([{ name: "rebuild_agent_spend", args: { p_agent_id: AGENT } }]);
    expect(data).toMatchObject({
      spent_tokens: 4200,
      spent_microcents: 830,
      reserved_tokens: 700,
      reserved_microcents: 12,
      open_holds: 2,
    });

    // The SAME epoch in both stores. A rebuild that minted two different uuids
    // would leave the agent refusing every call for exactly the reason it was
    // being rebuilt.
    const persisted = fake.updates[0]!.budget_epoch;
    expect(persisted).toBe(data.budget_epoch);
    expect(rebuildBudgetState).toHaveBeenCalledWith({
      agentId: AGENT,
      epoch: persisted,
      spentTokens: 4200,
      spentMicrocents: 830,
    });
    expect(persisted).not.toBe("old-epoch");
    // Establishment is asserted too — a rebuilt agent whose timestamp stayed
    // null would be read as never-initialised on its next call.
    expect(fake.updates[0]!.budget_state_established_at).toEqual(expect.any(String));

    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "budget.rebuild",
        metadata: expect.objectContaining({
          from_epoch: "old-epoch",
          to_epoch: persisted,
          spent_tokens: 4200,
          open_holds: 2,
        }),
      })
    );
  });

  // NOT OPTIONAL, and the failure it prevents is invisible: the epoch rides in
  // the cached policy, so a stale entry keeps the proxy comparing against the
  // generation this rebuild just replaced — every call refused, for a full TTL,
  // right after the operator was told the recovery succeeded.
  it("purges the policy cache for the agent it rebuilt", async () => {
    db.current = fakeDb({}).client;
    await rebuildRoute(post(url, {}), ctx(params));
    expect(purgeAgentPolicy).toHaveBeenCalledWith("u1", AGENT);
  });

  it("writes Postgres before Redis, so a half-done rebuild refuses rather than permits", async () => {
    const order: string[] = [];
    const fake = fakeDb({});
    const realUpdate = fake.client.from().update;
    db.current = {
      ...fake.client,
      from: () => {
        const b: any = fake.client.from();
        return {
          ...b,
          select: () => b,
          update: (v: any) => {
            order.push("postgres");
            return realUpdate(v);
          },
        };
      },
    };
    rebuildBudgetState.mockImplementation(async () => {
      order.push("redis");
      return rebuildResult();
    });
    await rebuildRoute(post(url, {}), ctx(params));
    expect(order).toEqual(["postgres", "redis"]);
  });

  it("does not rebuild another tenant's agent", async () => {
    const fake = fakeDb({ owned: false });
    db.current = fake.client;
    const res = await rebuildRoute(post(url, {}), ctx(params));
    expect(res.status).toBe(404);
    expect(fake.rpcCalls).toEqual([]);
    expect(rebuildBudgetState).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  // A failed RPC must not rebase Redis onto an epoch whose counters were never
  // computed — that would zero the agent's spend on a database error.
  it("touches nothing when the rebuild RPC fails", async () => {
    db.current = fakeDb({ rpcError: true }).client;
    const res = await rebuildRoute(post(url, {}), ctx(params));
    expect(res.status).toBe(500);
    expect(rebuildBudgetState).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("stops before Redis when the epoch cannot be persisted", async () => {
    db.current = fakeDb({ updateError: true }).client;
    const res = await rebuildRoute(post(url, {}), ctx(params));
    expect(res.status).toBe(500);
    expect(rebuildBudgetState).not.toHaveBeenCalled();
  });
});

/**
 * THE REFUSAL AN OPERATOR HAS TO BE ABLE TO SEE.
 *
 * Wiring `consumeDispatchPermission` into the proxy activated a guard in
 * SETTLE_LUA that had never been able to fire: a `not_dispatched` release is
 * now refused for any hold whose attempt reached the dispatch boundary. That is
 * the point of the change — but a refusal returns `{applied: false}`, which is
 * the identical shape to "someone already resolved this". An operator told only
 * `applied: false` would conclude the hold was handled and move on, leaving a
 * hold open that they believe is closed.
 *
 * So the route has to say WHICH of the two happened.
 */
describe("POST /holds/{attemptId}/resolve — a dispatched hold cannot be released", () => {
  const url = `https://x/api/control/v1/agents/${AGENT}/holds/${ATTEMPT}/resolve`;
  const params = { id: AGENT, attemptId: ATTEMPT };

  beforeEach(() => {
    releaseUndispatched.mockResolvedValue({
      applied: false,
      appliedTokens: 0,
      appliedMicrocents: 0,
      conflict: true,
    });
  });

  it("distinguishes a dispatch refusal from a replay in the response", async () => {
    db.current = fakeDb({}).client;
    const res = await resolveRoute(post(url, { outcome: "not_spent" }), ctx(params));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({
      applied: false,
      // Not a replay and not an unknown attempt: the hold is real, still open,
      // and refused this particular outcome because the request was sent.
      refused_dispatched: true,
      unknown_attempt: false,
    });
  });

  it("records the refusal in the audit trail", async () => {
    db.current = fakeDb({}).client;
    await resolveRoute(post(url, { outcome: "not_spent" }), ctx(params));

    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0]![0].metadata).toMatchObject({
      outcome: "not_spent",
      applied: false,
      refused_dispatched: true,
    });
  });

  // Three different meanings behind one `applied: false`, and an operator who
  // reads the wrong one goes and does the wrong thing: a dispatch refusal sends
  // them to the provider's dashboard for evidence, a state loss sends them to
  // the rebuild endpoint, and a replay means there is nothing to do at all.
  it("distinguishes lost counters from a dispatch refusal, in the body and the trail", async () => {
    db.current = fakeDb({}).client;
    resolveHold.mockResolvedValue({
      applied: false,
      appliedTokens: 12,
      appliedMicrocents: 34,
      degraded: true,
    });
    const res = await resolveRoute(
      post(url, { outcome: "spent", tokens: 12, microcents: 34 }),
      ctx(params)
    );
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({
      applied: false,
      state_lost: true,
      // NOT this one. The attempt was sent or not; that question is untouched
      // by the counters having been lost, and conflating them would send the
      // operator hunting a provider invoice for a Redis problem.
      refused_dispatched: false,
      unknown_attempt: false,
      // The charge still comes back, because it is still the charge. The audit
      // row carries it and the rebuild sums the audit rows.
      applied_tokens: 12,
      applied_microcents: 34,
    });
    expect(auditMock.mock.calls[0]![0].metadata).toMatchObject({
      state_lost: true,
      refused_dispatched: false,
    });
  });

  // Until a rebuild runs, this row is the ONLY record of what that attempt cost
  // — the counters it would have moved are gone. So a figure mistyped into it is
  // otherwise permanent, and Session 02 proved that a tenfold typo inside the
  // endpoint's own limits exhausts an agent's budget early. A second resolve is
  // the only thing that can reach the row, and it must carry the correction.
  it("lets a repeated resolve correct a figure the first one got wrong", async () => {
    const fake = fakeDb({ insertError: { code: "23505", message: "duplicate key" } });
    db.current = fake.client;
    // A replay: the script returns the FIRST resolution's stored amounts, which
    // is exactly why the row must not be written from them.
    resolveHold.mockResolvedValue({
      applied: false, appliedTokens: 194120, appliedMicrocents: 21560000, degraded: true,
    });
    const res = await resolveRoute(
      post(url, { outcome: "spent", tokens: 19412, microcents: 2156000 }), ctx(params)
    );
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({
      state_lost: true,
      ledger_recorded: true,
      // The confirmation the operator needs. `applied_tokens` is the hold's and
      // still shows the mistyped 194120 — reading that from a 200 would say the
      // correction had not taken.
      ledger_corrected: true,
      recorded_tokens: 19412,
      recorded_microcents: 2156000,
      applied_tokens: 194120,
    });
    // The attempted insert carries the OPERATOR's figures, not the echo.
    expect(fake.inserts[0]).toMatchObject({
      attempt_id: ATTEMPT, agent_id: AGENT, tokens: 19412, microcents: 2156000,
    });
    // And the correction actually lands, rather than the duplicate being
    // shrugged off as "already recorded".
    expect(fake.updates, "a corrected resolve must overwrite the mistyped figure").toEqual([
      { tokens: 19412, microcents: 2156000 },
    ]);
  });

  it("reports a ledger write that genuinely failed instead of swallowing it", async () => {
    const fake = fakeDb({ insertError: { code: "08006", message: "connection failure" } });
    db.current = fake.client;
    resolveHold.mockResolvedValue({
      applied: false, appliedTokens: 12, appliedMicrocents: 34, degraded: true,
    });
    const res = await resolveRoute(
      post(url, { outcome: "spent", tokens: 12, microcents: 34 }), ctx(params)
    );
    const body = (await res.json()) as { data: Record<string, unknown> };
    // The hold is closed and the counters are gone; this row was the only place
    // the charge could live. Saying nothing would leave the operator to run a
    // rebuild that silently comes back short.
    expect(body.data).toMatchObject({ state_lost: true, ledger_recorded: false });
  });

  // The other direction, and the one that would be a double charge: when the
  // settle APPLIED, Redis has the amount and the mirror carries it to the
  // checkpoint. A ledger row here as well would charge it twice.
  it("writes no ledger row when the settle actually moved the counters", async () => {
    const fake = fakeDb({});
    db.current = fake.client;
    resolveHold.mockResolvedValue({ applied: true, appliedTokens: 99, appliedMicrocents: 99 });
    const res = await resolveRoute(
      post(url, { outcome: "spent", tokens: 99, microcents: 99 }), ctx(params)
    );
    expect((await res.json()).data).toMatchObject({ applied: true, state_lost: false });
    expect(fake.inserts, "a settle that moved counters must not also write the ledger").toEqual([]);
  });

  it("does not flag an ordinary replay as a dispatch refusal", async () => {
    db.current = fakeDb({}).client;
    releaseUndispatched.mockResolvedValue({
      applied: false,
      appliedTokens: 3,
      appliedMicrocents: 4,
    });
    const res = await resolveRoute(post(url, { outcome: "not_spent" }), ctx(params));
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({ applied: false, refused_dispatched: false });
  });
});

/**
 * The list has to answer "is not_spent even permitted here?" BEFORE the
 * operator tries it. Without this the only way to find out is to attempt the
 * release and read the refusal, which is a poor way to learn something the
 * gateway has known since the moment it sent the request.
 */
describe("GET /agents/{id}/holds — reports whether an attempt was dispatched", () => {
  const url = `https://x/api/control/v1/agents/${AGENT}/holds`;

  it("marks a hold whose attempt reached the provider", async () => {
    db.current = fakeDb({}).client;
    listOpenHolds.mockResolvedValue([
      {
        attemptId: ATTEMPT,
        createdAtMs: 1_700_000_000_000,
        ageMs: 1000,
        estimateTokens: 10,
        estimateMicrocents: 20,
        provider: "openai",
        model: "gpt-4.1",
        mayHaveDispatched: true,
      },
    ]);
    const res = await holdsRoute(new Request(url, { headers: KEY }), ctx({ id: AGENT }));
    const body = (await res.json()) as { data: { holds: Record<string, unknown>[] } };
    expect(body.data.holds[0]!).toMatchObject({ may_have_dispatched: true });
  });

  it("marks one that never left the building", async () => {
    db.current = fakeDb({}).client;
    listOpenHolds.mockResolvedValue([
      {
        attemptId: ATTEMPT,
        createdAtMs: 1_700_000_000_000,
        ageMs: 1000,
        estimateTokens: 10,
        estimateMicrocents: 20,
        provider: "openai",
        model: "gpt-4.1",
        mayHaveDispatched: false,
      },
    ]);
    const res = await holdsRoute(new Request(url, { headers: KEY }), ctx({ id: AGENT }));
    const body = (await res.json()) as { data: { holds: Record<string, unknown>[] } };
    expect(body.data.holds[0]!).toMatchObject({ may_have_dispatched: false });
  });
});
