import { beforeEach, describe, expect, it, vi } from "vitest";
import { bytesToBase64url } from "@/lib/encoding";

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
  readFallbacksMock,
  order,
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
  fetchMock: vi.fn(),
  readProvidersWithKeysMock: vi.fn(),
  readFallbacksMock: vi.fn(),
  order: [] as string[],
}));

vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));
vi.mock("@/lib/auth/visa", () => ({
  extractVisaToken: (headers: Headers) => headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "",
  verifyVisa: (...args: unknown[]) => verifyVisaMock(...args),
}));
vi.mock("@/lib/state/killswitch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/state/killswitch")>()),
  readKillState: (...args: unknown[]) => readKillStateMock(...args),
}));
vi.mock("@/lib/state/redis", () => ({
  isSuspended: (...args: unknown[]) => isSuspendedMock(...args),
  reserveBudget: (...args: unknown[]) => {
    order.push("reserve");
    return reserveBudgetMock(...args);
  },
  reconcileBudget: (...args: unknown[]) => {
    order.push("release");
    return reconcileBudgetMock(...args);
  },
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
vi.mock("@/lib/providers/available", () => ({
  readProvidersWithKeys: (...args: unknown[]) => readProvidersWithKeysMock(...args),
}));
vi.mock("@/lib/state/fallbacks", () => ({
  readCurrentAgentFallbacks: (...args: unknown[]) => readFallbacksMock(...args),
}));

import { POST } from "@/app/api/v1/[provider]/[...path]/route";

const GROQ = { provider: "groq", model: "llama-3.3-70b" };

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
  scope: [
    { provider: "openai", models: ["gpt-4o-mini"] },
    { provider: "groq", models: ["llama-3.3-70b"] },
  ],
};

function upstream(body: string, status: number, contentType = "application/json") {
  return new Response(body, {
    status,
    headers: { "content-type": contentType, "content-length": String(body.length) },
  });
}

const QUOTA = JSON.stringify({
  error: { message: "quota", type: "insufficient_quota", code: "insufficient_quota" },
});

async function callProxy() {
  const req = new Request("https://gateway.test/api/v1/openai/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer visa", "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] }),
  });
  return POST(req, { params: Promise.resolve({ provider: "openai", path: ["chat", "completions"] }) });
}

/** The provider each upstream call actually went to, in order. */
function forwardedTo() {
  return fetchMock.mock.calls.map(([url]) => new URL(String(url)).host);
}

function loggedStatuses() {
  return writeLogMock.mock.calls.map(([entry]) => entry.status);
}

beforeEach(() => {
  order.length = 0;
  for (const m of [
    verifyVisaMock, serviceClientMock, reserveBudgetMock, reconcileBudgetMock,
    getCachedKeyMock, setCachedKeyMock, getCachedAgentPolicyMock, setCachedAgentPolicyMock,
    readKillStateMock, isSuspendedMock, writeLogMock, mirrorSpendMock, rateLimitMock,
    fetchMock, readProvidersWithKeysMock, readFallbacksMock,
  ]) m.mockReset();

  verifyVisaMock.mockResolvedValue(baseClaims);
  serviceClientMock.mockReturnValue({ rpc: vi.fn(async () => ({ data: "provider-key", error: null })) });
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
  readProvidersWithKeysMock.mockResolvedValue(["openai", "groq"]);
  readFallbacksMock.mockResolvedValue([GROQ]);
  vi.stubGlobal("fetch", fetchMock);
});

describe("the retry allowlist", () => {
  it.each([
    ["credit exhaustion", QUOTA, 429],
    ["a rate limit", JSON.stringify({ error: { code: "rate_limit_exceeded" } }), 429],
    ["a 500", "{}", 500],
    ["a 503", "{}", 503],
  ])("fails over on %s", async (_label, body, status) => {
    fetchMock.mockResolvedValueOnce(upstream(body, status));
    fetchMock.mockResolvedValueOnce(upstream(JSON.stringify({ ok: true }), 200));

    const res = await callProxy();

    expect(res.status).toBe(200);
    expect(forwardedTo()).toEqual(["api.openai.com", "api.groq.com"]);
  });

  it("fails over when the connection drops", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    fetchMock.mockResolvedValueOnce(upstream(JSON.stringify({ ok: true }), 200));

    expect((await callProxy()).status).toBe(200);
    expect(forwardedTo()).toEqual(["api.openai.com", "api.groq.com"]);
  });

  // The allowlist's whole point: a 400 says something about the request, so a
  // second provider gets the same broken call and a second key is spent on it.
  it.each([400, 401, 403, 404])("never fails over on a %s", async (status) => {
    fetchMock.mockResolvedValue(upstream(JSON.stringify({ error: { message: "bad" } }), status));

    const res = await callProxy();

    expect(res.status).toBe(status);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never fails over once the provider has started answering", async () => {
    // A 200 is terminal even if the body later fails — there is nothing to fail
    // over from once bytes are on their way to the client.
    fetchMock.mockResolvedValue(
      new Response("data: {}\n\n", { status: 200, headers: { "content-type": "text/event-stream" } })
    );

    expect((await callProxy()).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("a fallback is re-checked, never trusted", () => {
  it("skips a fallback outside the visa's scope", async () => {
    verifyVisaMock.mockResolvedValue({ ...baseClaims, scope: [{ provider: "openai", models: ["gpt-4o-mini"] }] });
    fetchMock.mockResolvedValue(upstream(QUOTA, 429));

    const res = await callProxy();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Falls back to phase 1's answer: the structured 402.
    expect(res.status).toBe(402);
  });

  // The security-grade case. A deny rule names a provider AND models, so a
  // fallback that bypassed it would silently defeat a rule the operator wrote.
  it("skips a fallback a policy deny rule forbids", async () => {
    getCachedAgentPolicyMock.mockResolvedValue(
      JSON.stringify({ p: { deny: [{ provider: "groq", models: ["*"] }] }, s: null })
    );
    fetchMock.mockResolvedValue(upstream(QUOTA, 429));

    await callProxy();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(forwardedTo()).toEqual(["api.openai.com"]);
  });

  // Trust boundary #3: revocation is instant. Failover puts an extra round-trip
  // between the first kill read and the second call going out.
  // Trust boundary #3 again, and written so the kill switch is provably the
  // cause. "one fetch happened" alone would also be true if the fallback were
  // skipped for scope, for a missing key, or by a `qualifies` bug that refused
  // everything — so the identical setup with the switch CLEAR has to fail over.
  it("stops failing over if the kill switch is armed between attempts", async () => {
    const armAfterFirstRead = () =>
      readKillStateMock
        .mockReset()
        .mockResolvedValueOnce({ platformKill: false, tenantKill: false, denylist: [] })
        .mockResolvedValue({ platformKill: true, tenantKill: false, denylist: [] });

    fetchMock.mockResolvedValue(upstream(QUOTA, 429));
    armAfterFirstRead();
    await callProxy();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Control: everything else identical, switch never armed → it does fail over.
    fetchMock.mockClear();
    readKillStateMock.mockReset().mockResolvedValue({
      platformKill: false,
      tenantKill: false,
      denylist: [],
    });
    await callProxy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops failing over if the agent is suspended between attempts", async () => {
    fetchMock.mockResolvedValue(upstream(QUOTA, 429));
    isSuspendedMock.mockReset().mockResolvedValueOnce(false).mockResolvedValue(true);
    await callProxy();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockClear();
    isSuspendedMock.mockReset().mockResolvedValue(false);
    await callProxy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("skips a fallback with no stored provider key", async () => {
    serviceClientMock.mockReturnValue({
      rpc: vi
        .fn()
        .mockResolvedValueOnce({ data: "provider-key", error: null })
        .mockResolvedValue({ data: null, error: null }),
    });
    fetchMock.mockResolvedValue(upstream(QUOTA, 429));

    const res = await callProxy();

    // Only the primary reached a provider; the client gets the primary's answer,
    // not the fallback's missing-key problem.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(402);
  });
});

describe("budget across attempts", () => {
  // The ordering bug this is written to catch: reconcileBudget DECRBYs `reserved`
  // while the reserve script INCRBYs it and compares the total against the cap.
  // Deferring the release lets the next attempt see a doubled reservation.
  // Asserting both merely "happened" would pass while that bug is live.
  it("releases the failed attempt BEFORE reserving for the next", async () => {
    // Invocation order is not the property under test and would pass even with
    // the bug: reconcileBudget is *called* before the loop continues either way.
    // What matters is that the Redis round-trip has COMPLETED, so the next
    // reserve cannot see the previous attempt's tokens still counted. So the
    // release is made genuinely slow and its completion recorded separately.
    reconcileBudgetMock.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push("release-done");
    });
    fetchMock.mockResolvedValueOnce(upstream(QUOTA, 429));
    fetchMock.mockResolvedValueOnce(upstream(JSON.stringify({ ok: true }), 200));

    await callProxy();

    const firstReleaseDone = order.indexOf("release-done");
    const secondReserve = order.lastIndexOf("reserve");
    expect(firstReleaseDone).toBeGreaterThan(-1);
    expect(secondReserve).toBeGreaterThan(order.indexOf("reserve"));
    expect(firstReleaseDone).toBeLessThan(secondReserve);
  });

  it("takes one reservation per attempt, each with its own id", async () => {
    fetchMock.mockResolvedValueOnce(upstream(QUOTA, 429));
    fetchMock.mockResolvedValueOnce(upstream(JSON.stringify({ ok: true }), 200));

    await callProxy();

    const ids = reserveBudgetMock.mock.calls.map(([a]) => a.reserveId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(reconcileBudgetMock.mock.calls.map(([a]) => a.reserveId)).toEqual(ids);
  });

  it("records the failed attempt with zero spend and the successful one with usage", async () => {
    fetchMock.mockResolvedValueOnce(upstream(QUOTA, 429));
    fetchMock.mockResolvedValueOnce(upstream(JSON.stringify({ ok: true }), 200));

    await callProxy();

    expect(loggedStatuses()).toEqual(["provider_exhausted", "ok"]);
    expect(reconcileBudgetMock.mock.calls[0]?.[0]).toMatchObject({
      actualTokens: 0,
      actualMicrocents: 0,
    });
  });
});

describe("policy rate limiting is charged per client request, not per attempt", () => {
  it("does not take a second hourly reading when it fails over", async () => {
    getCachedAgentPolicyMock.mockResolvedValue(
      JSON.stringify({ p: { max_requests_per_hour: 10 }, s: null })
    );
    fetchMock.mockResolvedValueOnce(upstream(QUOTA, 429));
    fetchMock.mockResolvedValueOnce(upstream(JSON.stringify({ ok: true }), 200));

    await callProxy();

    // Pinned first: a world where no failover happened would make the reading
    // count trivially correct and prove nothing.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // rateLimit MUTATES, so a second reading is a second charge against an
    // allowance the operator wrote about the agent, not about our retries.
    const hourly = rateLimitMock.mock.calls.filter(([key]) => String(key).startsWith("policy-hour:"));
    expect(hourly).toHaveLength(1);
  });
});

describe("the receipt chain", () => {
  it("gives each attempt its own receipt and returns the last one's id", async () => {
    fetchMock.mockResolvedValueOnce(upstream(QUOTA, 429));
    fetchMock.mockResolvedValueOnce(upstream(JSON.stringify({ ok: true }), 200));

    const res = await callProxy();

    const ids = writeLogMock.mock.calls.map(([entry]) => entry.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(res.headers.get("x-passcontrol-receipt-id")).toBe(ids[1]);
  });

  it("records each attempt against the provider that actually served it", async () => {
    fetchMock.mockResolvedValueOnce(upstream(QUOTA, 429));
    fetchMock.mockResolvedValueOnce(upstream(JSON.stringify({ ok: true }), 200));

    await callProxy();

    expect(writeLogMock.mock.calls.map(([e]) => [e.provider, e.model])).toEqual([
      ["openai", "gpt-4o-mini"],
      ["groq", "llama-3.3-70b"],
    ]);
  });
});

// The headline artifact of failover, verified on the real signed receipts the
// proxy produced rather than on the inputs it was handed.
describe("the signed receipt chain", () => {
  // base64url of 32 raw bytes, the same shape tests/receipt.test.ts uses.
  const SEED = bytesToBase64url(new Uint8Array(32).fill(7));

  function claimsOf(jws: string): Record<string, unknown> {
    const payload = jws.split(".")[1] ?? "";
    const padded = payload.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(padded + "=".repeat((4 - (padded.length % 4)) % 4)));
  }

  function receipts() {
    return writeLogMock.mock.calls.map(([entry]) => {
      expect(entry.receipt, "the proxy signed no receipt").toBeTruthy();
      return { id: entry.id as string, claims: claimsOf(entry.receipt as string) };
    });
  }

  beforeEach(() => {
    process.env.INSTANCE_SIGNING_KEY = SEED;
    process.env.PASSCONTROL_ISSUER = "https://gw.example.com";
  });

  it("links the successful attempt back to the one it replaced", async () => {
    fetchMock.mockResolvedValueOnce(upstream(QUOTA, 429));
    fetchMock.mockResolvedValueOnce(upstream(JSON.stringify({ ok: true }), 200));

    await callProxy();
    const [failed, succeeded] = receipts();

    // The failed attempt started the chain: it followed nothing.
    expect(failed?.claims).not.toHaveProperty("prev");
    expect(failed?.claims).not.toHaveProperty("why");

    // The successful one names what it replaced and why it moved.
    expect(succeeded?.claims.prev).toBe(failed?.id);
    expect(succeeded?.claims.why).toBe("credit_exhausted");
  });

  it("carries the reason the attempt actually failed, not a generic one", async () => {
    fetchMock.mockResolvedValueOnce(upstream("{}", 503));
    fetchMock.mockResolvedValueOnce(upstream(JSON.stringify({ ok: true }), 200));

    await callProxy();

    // upstream_5xx is one of the two reasons where the first provider may
    // already have billed the call — the distinction a reader needs.
    expect(receipts()[1]?.claims.why).toBe("upstream_5xx");
  });

  // Both attempts digest the CLIENT's bytes, which do not change. That is
  // exactly why a shared digest is not a link and `prev` has to be explicit —
  // matching two receipts by digest coincidence is a guess.
  it("gives both attempts the same request digest, and links them anyway", async () => {
    fetchMock.mockResolvedValueOnce(upstream(QUOTA, 429));
    fetchMock.mockResolvedValueOnce(upstream(JSON.stringify({ ok: true }), 200));

    await callProxy();
    const [failed, succeeded] = receipts();

    expect(succeeded?.claims.req).toEqual(failed?.claims.req);
    expect(succeeded?.claims.prev).toBe(failed?.id);
  });

  it("records each attempt against the provider that served it, and keeps ver at 1", async () => {
    fetchMock.mockResolvedValueOnce(upstream(QUOTA, 429));
    fetchMock.mockResolvedValueOnce(upstream(JSON.stringify({ ok: true }), 200));

    await callProxy();
    const [failed, succeeded] = receipts();

    expect(failed?.claims.prov).toBe("openai");
    expect(succeeded?.claims.prov).toBe("groq");
    expect(succeeded?.claims.mdl).toBe("llama-3.3-70b");
    // Additive claims must not invalidate a verifier already in the field.
    expect(failed?.claims.ver).toBe(1);
    expect(succeeded?.claims.ver).toBe(1);
  });

  it("writes no chain claims at all on a call that never failed over", async () => {
    readFallbacksMock.mockResolvedValue([]);
    fetchMock.mockResolvedValue(upstream(JSON.stringify({ ok: true }), 200));

    await callProxy();
    const [only] = receipts();

    expect(only?.claims).not.toHaveProperty("prev");
    expect(only?.claims).not.toHaveProperty("why");
  });
});

describe("the attempt cap", () => {
  it("never exceeds one primary plus the configured fallbacks", async () => {
    readFallbacksMock.mockResolvedValue([
      { provider: "groq", model: "llama-3.3-70b" },
      { provider: "mistral", model: "mistral-large" },
      { provider: "together", model: "llama-3" },
    ]);
    verifyVisaMock.mockResolvedValue({
      ...baseClaims,
      scope: [
        { provider: "openai", models: ["*"] },
        { provider: "groq", models: ["*"] },
        { provider: "mistral", models: ["*"] },
        { provider: "together", models: ["*"] },
      ],
    });
    fetchMock.mockResolvedValue(upstream(QUOTA, 429));

    await callProxy();

    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("does nothing different when no fallbacks are configured", async () => {
    readFallbacksMock.mockResolvedValue([]);
    fetchMock.mockResolvedValue(upstream(QUOTA, 429));

    const res = await callProxy();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(402);
    expect(loggedStatuses()).toEqual(["provider_exhausted"]);
  });
});

// ── The shadow verdict is per ATTEMPT, not per call ──────────────────────────
//
// The live policy is re-evaluated for every fallback — that is what stops a
// fallback bypassing a deny rule the operator wrote. The shadow verdict has to
// be re-evaluated on exactly the same terms, or the panel counts an Anthropic
// attempt as one the draft would allow when the draft denies Anthropic
// specifically. The numbers are what an operator promotes on.
describe("the shadow verdict follows the attempt, not the primary", () => {
  /** The verdict recorded against each attempt, with any revision stamp removed. */
  function loggedShadow() {
    return writeLogMock.mock.calls.map(([entry]) =>
      typeof entry.policyShadowWould === "string"
        ? entry.policyShadowWould.split("@")[0]
        : entry.policyShadowWould
    );
  }

  it("records the fallback's own verdict when the draft denies only the fallback", async () => {
    getCachedAgentPolicyMock.mockResolvedValue(
      JSON.stringify({ p: {}, s: { deny: [{ provider: "groq", models: ["*"] }] } })
    );
    fetchMock.mockResolvedValueOnce(upstream(QUOTA, 429));
    fetchMock.mockResolvedValueOnce(upstream(JSON.stringify({ ok: true }), 200));

    await callProxy();

    expect(loggedStatuses()).toEqual(["provider_exhausted", "ok"]);
    // The primary is OpenAI and the draft says nothing about OpenAI; the
    // fallback is the provider the draft denies. Inheriting the primary's
    // "allow" reports a Groq attempt the draft would have suppressed.
    expect(loggedShadow()).toEqual(["allow", "deny:policy"]);
  });

  it("records the fallback's own verdict when the draft denies only the primary", async () => {
    getCachedAgentPolicyMock.mockResolvedValue(
      JSON.stringify({ p: {}, s: { deny: [{ provider: "openai", models: ["*"] }] } })
    );
    fetchMock.mockResolvedValueOnce(upstream(QUOTA, 429));
    fetchMock.mockResolvedValueOnce(upstream(JSON.stringify({ ok: true }), 200));

    await callProxy();

    // The inverse: inheriting would overcount would-block attempts.
    expect(loggedShadow()).toEqual(["deny:policy", "allow"]);
  });

  // The constraint that must survive the fix. rateLimit() MUTATES: re-evaluating
  // the shadow policy per attempt must not take a reading of its own, or an
  // operator's hourly allowance is consumed by the gateway's internal retries.
  it("takes no extra hourly reading to judge the fallback", async () => {
    const policyKeys: string[] = [];
    rateLimitMock.mockImplementation(async (key: string) => {
      if (String(key).startsWith("policy-hour:")) policyKeys.push(String(key));
      return { success: true, remaining: 5 };
    });
    getCachedAgentPolicyMock.mockResolvedValue(
      JSON.stringify({ p: { max_requests_per_hour: 10 }, s: { max_requests_per_hour: 10 } })
    );
    fetchMock.mockResolvedValueOnce(upstream(QUOTA, 429));
    fetchMock.mockResolvedValueOnce(upstream(JSON.stringify({ ok: true }), 200));

    await callProxy();

    expect(policyKeys).toEqual(["policy-hour:user-id:agent-id"]);
    expect(loggedShadow()).toEqual(["allow", "allow"]);
  });
});
