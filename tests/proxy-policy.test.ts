import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const establishBudgetStateMock = vi.fn();

const {
  verifyVisaMock,
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
  captureSecurityEventMock,
  signReceiptMock,
  fetchMock,
} = vi.hoisted(() => ({
  verifyVisaMock: vi.fn(),
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
  captureSecurityEventMock: vi.fn(),
  signReceiptMock: vi.fn(),
  fetchMock: vi.fn(),
}));

// The proxy now reaches lib/demo/identity.ts to tell the seeded PUBLIC demo
// passport apart from a tenant that holds a demo scope. That module is
// `server-only`, which Next enforces at build time and vitest cannot resolve
// at all — same stub tests/site-demo-routes.test.ts already uses.
// The Cloud allowance resolver sits on the enforcement path and fails CLOSED, so
// an unmocked one refuses every request here with a 503 instead of exercising
// what this file is about.
vi.mock("server-only", () => ({}));
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
vi.mock("@/lib/receipt", () => ({
  signReceipt: (...args: unknown[]) => signReceiptMock(...args),
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
import { shadowRevision, stampShadowVerdict } from "@/lib/policy-shadow";

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

// `shadow` is the candidate policy an operator is trialling. The cache entry
// carries both values because they come from one row read — putting a second
// round-trip on the credential path for a decision that decides nothing would
// be the wrong trade, and the shape is what makes that avoidable.
async function callProxy(
  policy: unknown,
  claims: typeof baseClaims = baseClaims,
  provider = "openai",
  model = "gpt-4.1",
  shadow: unknown = null
) {
  verifyVisaMock.mockResolvedValueOnce(claims);
  getCachedAgentPolicyMock.mockResolvedValueOnce(JSON.stringify({ p: policy, s: shadow ?? null }));
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
    captureSecurityEventMock,
    signReceiptMock,
    fetchMock,
  ]) {
    mock.mockReset();
  }

  serviceClientMock.mockReturnValue({
    from: vi.fn(),
    rpc: vi.fn(async () => ({ data: "provider-key", error: null })),
  });
  openHoldMock.mockResolvedValue({ ok: true, reserved: 1 });
  settleHoldMock.mockResolvedValue(undefined);
  getCachedKeyMock.mockResolvedValue("provider-key");
  setCachedKeyMock.mockResolvedValue(undefined);
  getCachedAgentPolicyMock.mockResolvedValue(JSON.stringify({ p: {}, s: null }));
  setCachedAgentPolicyMock.mockResolvedValue(undefined);
  readKillStateMock.mockResolvedValue({ platformKill: false, tenantKill: false, denylist: [] });
  isSuspendedMock.mockResolvedValue(false);
  writeLogMock.mockResolvedValue(undefined);
  mirrorSpendMock.mockResolvedValue(undefined);
  rateLimitMock.mockResolvedValue({ success: true, remaining: 1 });
  captureSecurityEventMock.mockResolvedValue(undefined);
  signReceiptMock.mockReturnValue("signed-receipt");
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

/**
 * Let the work the route handed to `waitUntil` actually run.
 *
 * `vi.advanceTimersByTimeAsync`, NOT a bare `setTimeout` — this file installs
 * fake timers, so a real macrotask never fires and the flush would simply hang
 * until the test times out. And not a single `Promise.resolve()` either: the
 * deferred chain contains several awaits, and one microtask flush drains only
 * one level of it.
 */
const flushDeferredWork = () => vi.advanceTimersByTimeAsync(0);

describe("proxy agent policy", () => {
  it("signs the evaluated revision into allowed and every governed blocked receipt", async () => {
    const revision = async (
      policy: unknown,
      claims: typeof baseClaims = baseClaims
    ): Promise<string> => {
      signReceiptMock.mockClear();
      await callProxy(policy, claims);
      await vi.waitFor(() => expect(signReceiptMock).toHaveBeenCalled());
      const value = signReceiptMock.mock.calls.at(-1)?.[0]?.policyRevision;
      expect(value).toEqual(expect.any(String));
      return value as string;
    };

    const first = await revision({});
    const budgetChanged = await revision(
      {},
      { ...baseClaims, bt: 2_000 } as unknown as typeof baseClaims
    );
    const scopeChanged = await revision(
      {},
      {
        ...baseClaims,
        scope: [{ provider: "openai", models: ["gpt-4.1"] }],
      }
    );
    const scopeBlocked = await revision(
      {},
      {
        ...baseClaims,
        scope: [{ provider: "openai", models: ["gpt-3.5"] }],
      }
    );
    expect(signReceiptMock.mock.calls.at(-1)?.[0]?.status).toBe("blocked_scope");

    readKillStateMock.mockResolvedValueOnce({
      platformKill: true,
      tenantKill: false,
      denylist: [],
    });
    const killed = await revision({});
    expect(signReceiptMock.mock.calls.at(-1)?.[0]?.status).toBe("blocked_killed");

    const blocked = await revision({
      deny: [{ provider: "openai", models: ["gpt-4*"] }],
    });

    expect(budgetChanged).not.toBe(first);
    expect(scopeChanged).not.toBe(first);
    expect(scopeBlocked).not.toBe(first);
    expect(killed).toBe(first);
    expect(blocked).not.toBe(first);
    expect(signReceiptMock.mock.calls.at(-1)?.[0]).toMatchObject({
      status: "blocked_policy",
      policyRevision: blocked,
    });
    // The first receipt input is a historical snapshot, not a live reference
    // that can change when later calls observe a different rule set.
    expect(first).not.toBe(blocked);
  });

  it("blocks a denied model after scope and before budget reservation", async () => {
    let reservedTokens = 0;
    let spentTokens = 50;
    openHoldMock.mockImplementation(async ({ estimate }: { estimate: number }) => {
      reservedTokens += estimate;
      return { ok: true, reserved: reservedTokens };
    });
    settleHoldMock.mockImplementation(async () => {
      spentTokens += reservedTokens;
    });

    const res = await callProxy({
      deny: [{ provider: "openai", models: ["gpt-4*"] }],
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "blocked_policy" });
    expect(reservedTokens).toBe(0);
    expect(spentTokens).toBe(50);
    expect(openHoldMock).not.toHaveBeenCalled();
    expect(settleHoldMock).not.toHaveBeenCalled();
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
    expect(openHoldMock).not.toHaveBeenCalled();

    vi.setSystemTime(new Date("2026-07-27T10:00:00.000Z"));
    const inside = await callProxy(policy);
    expect(inside.status).toBe(200);
    expect(openHoldMock).toHaveBeenCalledTimes(1);
  });

  it("keeps null and empty policies identical to the legacy path", async () => {
    const nullPolicy = await callProxy(null);
    const emptyPolicy = await callProxy({});

    expect(nullPolicy.status).toBe(200);
    expect(emptyPolicy.status).toBe(200);
    expect(openHoldMock).toHaveBeenCalledTimes(2);
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
    expect(openHoldMock).not.toHaveBeenCalled();
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

  // Live policy is still allowed to fail open. The sender-constraint bit on the
  // same row is an authentication fact, though: an unreadable value cannot be
  // guessed false without silently turning an opted-in passport back into a
  // bearer. This refusal is therefore independent of POLICY_FAIL_CLOSED.
  it("fails passport authentication closed when the row cannot reveal the sender-constraint flag", async () => {
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
    expect(open.status).toBe(503);
    expect(await open.json()).toEqual({ error: "sender_constraint_state_unavailable" });

    process.env.POLICY_FAIL_CLOSED = "true";
    try {
      unreadable();
      verifyVisaMock.mockResolvedValueOnce(baseClaims);
      getCachedAgentPolicyMock.mockResolvedValueOnce(null);
      const closed = await POST(request(), {
        params: Promise.resolve({ provider: "openai", path: ["chat", "completions"] }),
      });
      expect(closed.status).toBe(503);
      expect(await closed.json()).toEqual({ error: "sender_constraint_state_unavailable" });
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

    // ONE row read carries the live policy, shadow candidate, and proof opt-in. This
    // is the whole reason shadow mode costs nothing on the credential path — a
    // separate read for the shadow value would be a second round-trip on the
    // way to a provider key, for a decision that decides nothing.
    // 0055 added the budget-state pair to the SAME read, for the same reason:
    // the epoch check on the money path costs no round trip of its own.
    expect(builder.select).toHaveBeenCalledWith(
      "policy, policy_shadow, sender_constraint_mode, budget_epoch, budget_state_established_at, budget_tokens, budget_cents"
    );

    // Cached together for the same reason, so a cache HIT is also one round
    // trip. `s: null` is a real value meaning "shadow mode is off".
    expect(setCachedAgentPolicyMock).toHaveBeenCalledWith(
      "tenant-a",
      "agent-a",
      JSON.stringify({ p: null, s: null, r: "off", be: null, bs: false }),
      60,
      null
    );
  });

  // A deployment that has not applied 0020 has no `policy_shadow` column.
  //
  // PostgREST does NOT answer such a request with a row that simply lacks the
  // property — it rejects the ENTIRE query. Verified against the running local
  // stack on 2026-08-08 with the anon key:
  //
  //   GET /rest/v1/agents?select=policy,does_not_exist_col  →  HTTP 400
  //   {"code":"42703","details":null,"hint":null,
  //    "message":"column agents.does_not_exist_col does not exist"}
  //
  // So the live policy has to survive the shadow column being absent. It is the
  // deny rules of the whole fleet that are at stake: an unreadable row is
  // POLICY_UNREADABLE, and POLICY_UNREADABLE on the default (fail-open) posture
  // permits exactly the calls the operator wrote a policy to refuse. The
  // previous fixture here modelled an omitted property, which PostgREST cannot
  // produce, and that is why this passed.
  // One PostgREST that has `policy` but not `policy_shadow`, i.e. a database at
  // 0019 or earlier. Unrelated reads on this client (the owner lookup) answer
  // empty and are not recorded, so `policySelects` is the policy read alone.
  function pre0020Client(policy: unknown) {
    const policySelects: string[] = [];
    let columns = "";
    const builder = {
      select: vi.fn((requested: string) => {
        columns = requested;
        if (requested.includes("policy")) policySelects.push(requested);
        return builder;
      }),
      eq: vi.fn(() => builder),
      maybeSingle: vi.fn(async () => {
        if (columns.includes("policy_shadow")) {
          return {
            data: null,
            error: {
              code: "42703",
              details: null,
              hint: null,
              message: "column agents.policy_shadow does not exist",
            },
          };
        }
        if (columns === "policy") return { data: { policy }, error: null };
        return { data: null, error: null };
      }),
    };
    serviceClientMock.mockReturnValue({
      from: vi.fn(() => builder),
      rpc: vi.fn(async () => ({ data: "provider-key", error: null })),
    });
    return policySelects;
  }

  it("still enforces the live deny policy when policy_shadow does not exist", async () => {
    const denyAll = { deny: [{ provider: "openai", models: ["*"] }] };
    const policySelects = pre0020Client(denyAll);
    verifyVisaMock.mockResolvedValueOnce(baseClaims);
    getCachedAgentPolicyMock.mockResolvedValueOnce(null);

    const res = await POST(request(), {
      params: Promise.resolve({ provider: "openai", path: ["chat", "completions"] }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "blocked_policy" });
    expect(fetchMock).not.toHaveBeenCalled();

    // The two-column read is still what runs FIRST, so a current schema keeps
    // paying for exactly one round trip. The narrowed retry is the fallback.
    // The full read still runs FIRST, so a current schema keeps paying for
    // exactly one round trip. Each narrower rung drops exactly one migration's
    // columns, in deployment order — 0055, then 0049, then 0046, then 0020.
    //
    // The 0046 rung asks for `require_sender_constrained_visa` rather than
    // skipping past it (AUTH-03): that boolean was the ONLY way to turn the
    // control on between 0046 and 0049, an operator could set it by hand, and
    // discarding it here while the cache decoder honoured it made a legacy
    // install enforce while warm and drop to bearer-only once the entry expired.
    expect(policySelects).toEqual([
      "policy, policy_shadow, sender_constraint_mode, budget_epoch, budget_state_established_at, budget_tokens, budget_cents",
      "policy, policy_shadow, sender_constraint_mode",
      "policy, policy_shadow, require_sender_constrained_visa",
      "policy, policy_shadow",
      "policy",
    ]);

    // Shadow mode is off, not broken: there is no such thing as an unreadable
    // shadow policy, because an unreadable one simply does not run.
    expect(setCachedAgentPolicyMock).toHaveBeenCalledWith(
      "tenant-a",
      "agent-a",
      JSON.stringify({ p: denyAll, s: null, r: "off", be: null, bs: false }),
      60,
      // The invalidation fence, read before the row and quoted back at fill
      // time. Null here because this mock records no invalidation; the argument
      // being PRESENT is the assertion — the previous fence had a parameter
      // exactly like it that no call site ever passed.
      null
    );
    expect(writeLogMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ policyShadowWould: expect.anything() })
    );
  });

  // The same absence with no policy stored: the call goes through, and nothing
  // about shadow mode is recorded.
  it("treats a pre-0020 schema as shadow mode off, not as an error", async () => {
    pre0020Client(null);
    verifyVisaMock.mockResolvedValueOnce(baseClaims);
    getCachedAgentPolicyMock.mockResolvedValueOnce(null);

    const res = await POST(request(), {
      params: Promise.resolve({ provider: "openai", path: ["chat", "completions"] }),
    });

    expect(res.status).toBe(200);
    // The audit row is written inside waitUntil, which this file mocks as an
    // identity function — so it lands on a later turn of the event loop and this
    // assertion has to wait for it. Its sibling tests get that for free from an
    // `await res.json()` they happen to make; relying on that is how a test
    // starts passing or failing on the number of awaits in unrelated code.
    await flushDeferredWork();
    expect(writeLogMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ policyShadowWould: expect.anything() })
    );
  });

  // A read that fails for a reason OTHER than the missing column must not be
  // retried into a narrower query — it is an infrastructure fault, and the
  // deliberate fail-open posture (with POLICY_FAIL_CLOSED to opt out) is what
  // handles it. Retrying would double the load on a database already in trouble.
  it("does not retry a genuine read failure as a narrower query", async () => {
    const policySelects: string[] = [];
    const builder = {
      select: vi.fn((columns: string) => {
        if (columns.includes("policy")) policySelects.push(columns);
        return builder;
      }),
      eq: vi.fn(() => builder),
      maybeSingle: vi.fn(async () => ({ data: null, error: { message: "timeout" } })),
    };
    serviceClientMock.mockReturnValue({
      from: vi.fn(() => builder),
      rpc: vi.fn(async () => ({ data: "provider-key", error: null })),
    });
    verifyVisaMock.mockResolvedValueOnce(baseClaims);
    getCachedAgentPolicyMock.mockResolvedValueOnce(null);

    const res = await POST(request(), {
      params: Promise.resolve({ provider: "openai", path: ["chat", "completions"] }),
    });

    // The policy evaluator remains fail-open, but this row now also carries an
    // authentication flag. Guessing that unreadable flag off would let an opted-
    // in passport silently fall back to bearer, so the passport path fails closed.
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "sender_constraint_state_unavailable" });
    expect(policySelects).toEqual(["policy, policy_shadow, sender_constraint_mode, budget_epoch, budget_state_established_at, budget_tokens, budget_cents"]);
    expect(setCachedAgentPolicyMock).not.toHaveBeenCalled();
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
    expect(openHoldMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── Shadow mode ──────────────────────────────────────────────────────────────
//
// A candidate policy evaluated on every real call that decides nothing. The
// feature is only worth having if that second half is airtight, so these tests
// are the second half.
describe("policy shadow mode", () => {
  const DENY_ALL_OPENAI = { deny: [{ provider: "openai", models: ["*"] }] };

  // The headline property. A shadow policy that would refuse this call must
  // change nothing an agent or a caller can observe.
  it("never changes the response, even when it would have denied", async () => {
    const withoutShadow = await callProxy({});
    const forwardedWithout = fetchMock.mock.calls.length;

    const withShadow = await callProxy({}, baseClaims, "openai", "gpt-4.1", DENY_ALL_OPENAI);

    expect(withoutShadow.status).toBe(200);
    expect(withShadow.status).toBe(200);
    expect(await withShadow.json()).toEqual(await withoutShadow.json());
    // The call still went upstream. A shadow deny that quietly skipped the
    // provider would be enforcement wearing a diagnostic's name.
    expect(fetchMock.mock.calls.length).toBe(forwardedWithout + 1);
    expect(openHoldMock).toHaveBeenCalled();
  });

  /**
   * The recorded value names the DRAFT as well as the verdict. Without that,
   * the dashboard has to attribute a verdict to a draft by when the row landed
   * — and a long streaming request that read the previous draft lands after the
   * next one's save. The revision is derived from the draft, so it is asserted
   * by deriving it here rather than by pasting a hash.
   */
  it("records what the shadow policy would have done, stamped with which draft said so", async () => {
    await callProxy({}, baseClaims, "openai", "gpt-4.1", DENY_ALL_OPENAI);
    expect(writeLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        policyShadowWould: stampShadowVerdict("deny:policy", shadowRevision(DENY_ALL_OPENAI)),
        status: "ok",
      })
    );

    writeLogMock.mockClear();
    await callProxy({}, baseClaims, "openai", "gpt-4.1", {});
    expect(writeLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        policyShadowWould: stampShadowVerdict("allow", shadowRevision({})),
      })
    );
  });

  // Two drafts that differ must not be recorded under the same name.
  it("stamps a different draft with a different revision", async () => {
    await callProxy({}, baseClaims, "openai", "gpt-4.1", DENY_ALL_OPENAI);
    const first = writeLogMock.mock.calls.at(-1)?.[0].policyShadowWould;

    writeLogMock.mockClear();
    await callProxy({}, baseClaims, "openai", "gpt-4.1", {
      deny: [{ provider: "openai", models: ["gpt-3*"] }],
    });
    const second = writeLogMock.mock.calls.at(-1)?.[0].policyShadowWould;

    expect(first).not.toBe(second);
  });

  // The reverse divergence: the live policy denies, the shadow one would not.
  // Recorded on the blocked row, or an operator loosening a rule has no way to
  // see that it works.
  it("records a would-allow on a call the live policy blocked", async () => {
    const res = await callProxy(DENY_ALL_OPENAI, baseClaims, "openai", "gpt-4.1", {});

    expect(res.status).toBe(403);
    expect(writeLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "blocked_policy",
        policyShadowWould: stampShadowVerdict("allow", shadowRevision({})),
      })
    );
  });

  // THE COUNTER GUARD. rateLimit() mutates. A shadow evaluation that took its
  // own reading would consume the operator's hourly cap twice as fast for
  // having switched shadow mode on — observing the system would change it.
  it("charges the hourly counter exactly once with shadow mode on", async () => {
    const policyKeys: string[] = [];
    rateLimitMock.mockImplementation(async (key: string) => {
      if (key.startsWith("policy-hour:")) policyKeys.push(key);
      return { success: true, remaining: 5 };
    });

    await callProxy({ max_requests_per_hour: 10 }, baseClaims, "openai", "gpt-4.1", {
      max_requests_per_hour: 1,
    });

    expect(policyKeys).toEqual(["policy-hour:tenant-a:agent-a"]);
  });

  // ── The cap the reading was taken FOR ─────────────────────────────────────
  //
  // The counter guard above says the reading is taken once. It does not say the
  // reading answers the draft's question. `rateLimit(key, limit, window)` decides
  // success against the LIVE limit, so a `{success:true}` read for a cap of 10
  // says nothing at all about a draft that caps at 1 — and a draft that caps
  // anything when the live policy caps nothing has no reading in existence.
  //
  // Recording "allow" in either case is a confident false statement about the
  // one thing the operator is trialling. No verdict is the honest answer, and
  // taking a second reading is not an option: it would charge the counter twice.
  const noVerdict = () =>
    expect(writeLogMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ policyShadowWould: expect.anything() })
    );

  it("records no verdict for a draft cap the live policy never counted", async () => {
    const policyKeys: string[] = [];
    rateLimitMock.mockImplementation(async (key: string) => {
      if (String(key).startsWith("policy-hour:")) policyKeys.push(String(key));
      return { success: true, remaining: 5 };
    });

    await callProxy({}, baseClaims, "openai", "gpt-4.1", { max_requests_per_hour: 1 });

    // No live cap means no counter was read at all — and observing the draft
    // must not create one.
    expect(policyKeys).toEqual([]);
    noVerdict();
  });

  it("records no verdict when the draft's cap differs from the live one", async () => {
    rateLimitMock.mockResolvedValue({ success: true, remaining: 5 });

    await callProxy({ max_requests_per_hour: 10 }, baseClaims, "openai", "gpt-4.1", {
      max_requests_per_hour: 1,
    });

    noVerdict();
  });

  // The other half: when the caps DO match, the reading the live gate took is
  // exactly the evidence the draft needs, and suppressing the verdict there
  // would throw away the measurement the feature exists to make.
  it("judges a matching draft cap against the reading already taken", async () => {
    const policyKeys: string[] = [];
    rateLimitMock.mockImplementation(async (key: string) => {
      if (String(key).startsWith("policy-hour:")) policyKeys.push(String(key));
      return { success: true, remaining: 5 };
    });

    await callProxy({ max_requests_per_hour: 10 }, baseClaims, "openai", "gpt-4.1", {
      max_requests_per_hour: 10,
    });

    expect(policyKeys).toEqual(["policy-hour:tenant-a:agent-a"]);
    expect(writeLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ policyShadowWould: expect.stringMatching(/^allow(@|$)/) })
    );
  });

  it("records the draft's deny when a matching cap is exhausted", async () => {
    // Only the POLICY counter is exhausted. Failing the proxy's own request-rate
    // limiter as well would return 429 before any row is written, and this test
    // would pass for the wrong reason.
    rateLimitMock.mockImplementation(async (key: string) =>
      String(key).startsWith("policy-hour:")
        ? { success: false, remaining: 0 }
        : { success: true, remaining: 1 }
    );

    const res = await callProxy({ max_requests_per_hour: 10 }, baseClaims, "openai", "gpt-4.1", {
      max_requests_per_hour: 10,
    });

    expect(res.status).toBe(429);
    expect(writeLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "blocked_policy",
        policyShadowWould: expect.stringMatching(/^deny:policy(@|$)/),
      })
    );
  });

  // A deny rule is decided before the cap is ever consulted, so a draft that
  // denies on a rule still gets a verdict even though its cap has no reading.
  it("still records a rule deny from a draft whose cap has no reading", async () => {
    await callProxy({}, baseClaims, "openai", "gpt-4.1", {
      deny: [{ provider: "openai", models: ["*"] }],
      max_requests_per_hour: 1,
    });

    expect(writeLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ policyShadowWould: expect.stringMatching(/^deny:policy(@|$)/) })
    );
  });

  // Diagnostics must not be able to fail a credential-path call. A shadow value
  // that no reader can make sense of is inert, which is the opposite posture
  // from the LIVE policy — that one fails closed, and deliberately so.
  it.each([
    ["a bare string", "deny everything"],
    ["an array", [1, 2, 3]],
    ["an unknown key", { sudo: true }],
    ["a number", 42],
  ])("is inert when the shadow policy is %s", async (_label, shadow) => {
    const res = await callProxy({}, baseClaims, "openai", "gpt-4.1", shadow);

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalled();
    // Malformed reaches the policy step and denies THERE, so it is honestly
    // recorded as such — the operator should see that their draft is broken.
    expect(writeLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        policyShadowWould: stampShadowVerdict("deny:policy", shadowRevision(shadow)),
      })
    );
  });

  // An earlier gate denying means the shadow policy was never reached. Its
  // "deny" would be someone else's refusal attributed to the rule being
  // trialled — which is exactly the number an operator would promote on.
  it("records nothing when an earlier gate decided the call", async () => {
    readKillStateMock.mockResolvedValue({
      platformKill: true,
      tenantKill: false,
      denylist: [],
    });

    const res = await callProxy({}, baseClaims, "openai", "gpt-4.1", DENY_ALL_OPENAI);

    expect(res.status).toBe(403);
    expect(writeLogMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ policyShadowWould: expect.anything() })
    );
  });

  it("records nothing when shadow mode is off", async () => {
    await callProxy({});
    expect(writeLogMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ policyShadowWould: expect.anything() })
    );
  });
});

/**
 * S3-04. A passport visa carries the caps as claims (`bt`/`bc`) minted when it
 * was issued, and the proxy used to hand those straight to `openHold`. So an
 * owner lowering a budget changed nothing for an agent already holding a visa,
 * for up to that visa's full 15-minute life: `verifyVisa` authenticated the
 * stale number, the atomic Lua enforced it exactly, and the dashboard showed the
 * new one. Atomicity is not the problem — it was protecting the wrong limit.
 *
 * Direct Agent Keys never had this: their authentication RPC returns the current
 * row on every request, which is the behaviour these tests bring the passport
 * path in line with.
 */
describe("the cap that actually gates the call", () => {
  const cached = (extra: Record<string, unknown>) =>
    JSON.stringify({ p: {}, s: null, r: "off", be: null, bs: false, ...extra });

  it("is the live row's, not the visa's, once the row can be read", async () => {
    verifyVisaMock.mockResolvedValueOnce({ ...baseClaims, bt: 1_000 });
    // What the owner just saved. `bk` is the flag that says these were actually
    // read — without it, `bt: null` and "no such field" are the same bytes.
    getCachedAgentPolicyMock.mockResolvedValueOnce(cached({ bk: true, bt: 50, bc: null }));

    await POST(request("openai", "gpt-4.1"), {
      params: Promise.resolve({ provider: "openai", path: ["chat", "completions"] }),
    });

    expect(openHoldMock).toHaveBeenCalledWith(
      expect.objectContaining({ capTokens: 50, capMicrocents: null })
    );
  });

  it("takes a cap the owner has REMOVED, not just one they lowered", async () => {
    // The direction that needs the `bk` flag to be readable at all. A live null
    // means "no token cap"; an entry that predates this field also has no `bt`,
    // and reading that as unlimited would uncap every agent holding one.
    verifyVisaMock.mockResolvedValueOnce({ ...baseClaims, bt: 1_000 });
    getCachedAgentPolicyMock.mockResolvedValueOnce(cached({ bk: true, bt: null, bc: 250 }));

    await POST(request("openai", "gpt-4.1"), {
      params: Promise.resolve({ provider: "openai", path: ["chat", "completions"] }),
    });

    expect(openHoldMock).toHaveBeenCalledWith(
      // 250 cents in microcents (1_000_000 per cent — see lib/pricing.ts). The
      // row's units are cents; the conversion happens where the cap is
      // enforced, not where it is stored.
      expect.objectContaining({ capTokens: null, capMicrocents: 250 * 1_000_000 })
    );
  });

  it("falls back to the visa's claim when the read could not establish one", async () => {
    // An older schema, a cache entry written before this field existed, or a
    // failed read. Every one of those must behave exactly as this did before —
    // an unknown is not a new denial path, and it is certainly not "no cap".
    verifyVisaMock.mockResolvedValueOnce({ ...baseClaims, bt: 1_000 });
    getCachedAgentPolicyMock.mockResolvedValueOnce(cached({}));

    await POST(request("openai", "gpt-4.1"), {
      params: Promise.resolve({ provider: "openai", path: ["chat", "completions"] }),
    });

    expect(openHoldMock).toHaveBeenCalledWith(expect.objectContaining({ capTokens: 1_000 }));
  });
});
