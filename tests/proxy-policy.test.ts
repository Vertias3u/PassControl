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
  getCachedAgentPolicyMock.mockResolvedValue(JSON.stringify({ p: {}, s: null }));
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

    // ONE row read carries both the live policy and the shadow candidate. This
    // is the whole reason shadow mode costs nothing on the credential path — a
    // separate read for the shadow value would be a second round-trip on the
    // way to a provider key, for a decision that decides nothing.
    expect(builder.select).toHaveBeenCalledWith("policy, policy_shadow");

    // Cached together for the same reason, so a cache HIT is also one round
    // trip. `s: null` is a real value meaning "shadow mode is off".
    expect(setCachedAgentPolicyMock).toHaveBeenCalledWith(
      "tenant-a",
      "agent-a",
      JSON.stringify({ p: null, s: null }),
      60
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
    expect(policySelects).toEqual(["policy, policy_shadow", "policy"]);

    // Shadow mode is off, not broken: there is no such thing as an unreadable
    // shadow policy, because an unreadable one simply does not run.
    expect(setCachedAgentPolicyMock).toHaveBeenCalledWith(
      "tenant-a",
      "agent-a",
      JSON.stringify({ p: denyAll, s: null }),
      60
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

    expect(res.status).toBe(200); // fail-open, as documented
    expect(policySelects).toEqual(["policy, policy_shadow"]);
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
    expect(reserveBudgetMock).not.toHaveBeenCalled();
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
    expect(reserveBudgetMock).toHaveBeenCalled();
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
