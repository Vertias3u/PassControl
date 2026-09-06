import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const establishBudgetStateMock = vi.fn();

const {
  pending,
  verifyVisaMock,
  serviceClientMock,
  openHoldMock,
  settleHoldMock,
  getCachedKeyMock,
  readKillStateMock,
  isSuspendedMock,
  readPolicyMock,
  writeLogMock,
  mirrorSpendMock,
  rateLimitMock,
  signReceiptMock,
  fetchMock,
} = vi.hoisted(() => ({
  pending: [] as Promise<unknown>[],
  verifyVisaMock: vi.fn(),
  serviceClientMock: vi.fn(),
  openHoldMock: vi.fn(),
  settleHoldMock: vi.fn(),
  getCachedKeyMock: vi.fn(),
  readKillStateMock: vi.fn(),
  isSuspendedMock: vi.fn(),
  readPolicyMock: vi.fn(),
  writeLogMock: vi.fn(),
  mirrorSpendMock: vi.fn(),
  rateLimitMock: vi.fn(),
  signReceiptMock: vi.fn(),
  fetchMock: vi.fn(),
}));

// The proxy now reaches lib/demo/identity.ts to tell the seeded PUBLIC demo
// passport apart from a tenant that holds a demo scope. That module is
// `server-only`, which Next enforces at build time and vitest cannot resolve
// at all — same stub tests/site-demo-routes.test.ts already uses.
vi.mock("server-only", () => ({}));
vi.mock("@vercel/functions", () => ({
  waitUntil: (promise: Promise<unknown>) => pending.push(Promise.resolve(promise)),
}));
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
  isSuspended: (...args: unknown[]) => isSuspendedMock(...args),
  getCachedKey: (...args: unknown[]) => getCachedKeyMock(...args),
  setCachedKey: vi.fn(async () => undefined),
  touchLastSeen: vi.fn(async () => undefined),
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
vi.mock("@/lib/state/policy", () => ({
  readCurrentAgentPolicyAndShadow: (...args: unknown[]) => readPolicyMock(...args),
}));
vi.mock("@/lib/supabase", () => ({ serviceClient: () => serviceClientMock() }));
vi.mock("@/lib/crypto/aesgcm", () => ({
  seal: async () => "sealed",
  open: async (value: string) => value,
}));
vi.mock("@/lib/log", () => ({
  writeLog: (...args: unknown[]) => writeLogMock(...args),
  mirrorSpend: (...args: unknown[]) => mirrorSpendMock(...args),
}));
vi.mock("@/lib/receipt", () => ({
  signReceipt: (...args: unknown[]) => signReceiptMock(...args),
}));
vi.mock("@/lib/owner/current", () => ({ readCurrentOwner: async () => null }));
vi.mock("@/lib/ratelimit", () => ({
  rateLimit: (...args: unknown[]) => rateLimitMock(...args),
  rateLimitFailClosed: vi.fn(),
}));
vi.mock("@/lib/observability", () => ({
  captureError: vi.fn(async () => undefined),
  captureSecurityEvent: vi.fn(async () => undefined),
  logFailOpen: vi.fn(),
}));
import { POST } from "@/app/api/v1/[provider]/[...path]/route";
import { advertisedClientPath } from "@/lib/scope";

const claims = {
  sub: "passport-id",
  agid: "agent-id",
  uid: "user-id",
  jti: "jti-1",
  bt: 10_000,
  bc: null,
  st: 0,
  sc: 0,
  ver: 1,
  scope: [{ provider: "openai", models: ["gpt-4.1"] }],
};

function request(path: string[], body: Record<string, unknown>) {
  return new Request(`https://gateway.test/api/v1/openai/${path.join("/")}`, {
    method: "POST",
    headers: { authorization: "Bearer visa", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function call(path: string[], body: Record<string, unknown>) {
  return POST(request(path, body), {
    params: Promise.resolve({ provider: "openai", path }),
  });
}

async function flushPending() {
  for (;;) {
    const batch = pending.splice(0);
    if (batch.length === 0) return;
    await Promise.all(batch);
  }
}

beforeEach(() => {
  pending.length = 0;
  for (const mock of [
    verifyVisaMock,
    serviceClientMock,
    openHoldMock,
    settleHoldMock,
    getCachedKeyMock,
    readKillStateMock,
    isSuspendedMock,
    readPolicyMock,
    writeLogMock,
    mirrorSpendMock,
    rateLimitMock,
    signReceiptMock,
    fetchMock,
  ]) {
    mock.mockReset();
  }

  verifyVisaMock.mockResolvedValue(claims);
  serviceClientMock.mockReturnValue({ rpc: vi.fn(async () => ({ data: "provider-key" })) });
  openHoldMock.mockResolvedValue({ ok: true, reserved: 1, reservedMicrocents: 0 });
  settleHoldMock.mockResolvedValue(undefined);
  getCachedKeyMock.mockResolvedValue("provider-key");
  readKillStateMock.mockResolvedValue({ platformKill: false, tenantKill: false, denylist: [] });
  isSuspendedMock.mockResolvedValue(false);
  readPolicyMock.mockResolvedValue({ policy: {}, shadow: null });
  writeLogMock.mockResolvedValue(undefined);
  mirrorSpendMock.mockResolvedValue(undefined);
  rateLimitMock.mockResolvedValue({ success: true, remaining: 1 });
  signReceiptMock.mockReturnValue("signed-receipt");
  fetchMock.mockResolvedValue(
    new Response(
      JSON.stringify({
        id: "resp_1",
        object: "response",
        status: "completed",
        usage: { input_tokens: 37, output_tokens: 11, total_tokens: 48 },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    )
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("governed OpenAI Responses API", () => {
  it("does not replace the advertised OpenAI chat path with Responses", () => {
    expect(advertisedClientPath("openai", "chat")).toEqual(["chat", "completions"]);
  });

  it.each([["responses"], ["v1", "responses"]])(
    "governs POST /%s through reserve, key injection, reconciliation, log, and receipt",
    async (...path: string[]) => {
      const res = await call(path, {
        model: "gpt-4.1",
        input: "hi",
        max_output_tokens: 64,
      });
      await flushPending();

      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.openai.com/v1/responses",
        expect.objectContaining({
          method: "POST",
          headers: expect.any(Headers),
        })
      );
      const headers = fetchMock.mock.calls.at(-1)?.[1]?.headers as Headers;
      expect(headers.get("authorization")).toBe("Bearer provider-key");
      expect(openHoldMock).toHaveBeenCalledOnce();
      expect(settleHoldMock).toHaveBeenCalledWith(
        expect.objectContaining({ tokens: 48 })
      );
      expect(writeLogMock).toHaveBeenCalledWith(
        expect.objectContaining({ inputTokens: 37, outputTokens: 11, status: "ok" })
      );
      expect(signReceiptMock).toHaveBeenCalledWith(
        expect.objectContaining({
          inputTokens: 37,
          outputTokens: 11,
          status: "ok",
          policyRevision: expect.any(String),
        })
      );
    }
  );

  it.each([
    ["incomplete terminal status", { status: "incomplete", usage: { input_tokens: 37, output_tokens: 11 } }],
    ["missing usage", { status: "completed" }],
    ["malformed usage", { status: "completed", usage: { input_tokens: -1, output_tokens: 11 } }],
  ])("settles buffered Responses with %s as usage_unknown", async (_name, body) => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    const res = await call(["v1", "responses"], {
      model: "gpt-4.1",
      input: "hi",
      max_output_tokens: 64,
    });
    await flushPending();

    expect(res.status).toBe(200);
    expect(settleHoldMock).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "usage_unknown" })
    );
    expect(writeLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "usage_unknown" })
    );
  });

  it("gets streaming usage from response.completed without injecting include_usage", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        'event: response.completed\n' +
          'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":37,"output_tokens":11,"total_tokens":48}}}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } }
      )
    );

    const res = await call(["v1", "responses"], {
      model: "gpt-4.1",
      input: "hi",
      max_output_tokens: 64,
      stream: true,
      stream_options: { include_obfuscation: false },
    });
    await res.text();
    await flushPending();

    const forwarded = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(forwarded.stream_options).toEqual({ include_obfuscation: false });
    expect(forwarded.stream_options).not.toHaveProperty("include_usage");
    expect(settleHoldMock).toHaveBeenCalledWith(
      expect.objectContaining({ tokens: 48 })
    );
    expect(writeLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 37, outputTokens: 11, status: "ok" })
    );
  });

  it("refuses a killed Responses call before reserve or provider contact", async () => {
    readKillStateMock.mockResolvedValueOnce({
      platformKill: true,
      tenantKill: false,
      denylist: [],
    });

    const res = await call(["v1", "responses"], { model: "gpt-4.1", input: "hi" });
    await flushPending();

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "blocked_suspended" });
    expect(openHoldMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a suspended Responses call with the standard code before provider contact", async () => {
    isSuspendedMock.mockResolvedValueOnce(true);

    const res = await call(["v1", "responses"], { model: "gpt-4.1", input: "hi" });
    await flushPending();

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "blocked_suspended" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an out-of-scope Responses call before reserve or provider contact", async () => {
    verifyVisaMock.mockResolvedValueOnce({
      ...claims,
      scope: [{ provider: "openai", models: ["gpt-4o-mini"] }],
    });

    const res = await call(["v1", "responses"], { model: "gpt-4.1", input: "hi" });
    await flushPending();

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "blocked_scope" });
    expect(openHoldMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an over-budget Responses call before provider contact", async () => {
    openHoldMock.mockResolvedValueOnce({ ok: false, reason: "tokens" });

    const res = await call(["v1", "responses"], { model: "gpt-4.1", input: "hi" });
    await flushPending();

    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: "blocked_budget" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps exact-segment deny-by-default around Responses", async () => {
    const suffixed = await call(["v1", "responses", "extra"], {
      model: "gpt-4.1",
      input: "hi",
    });
    const wrongMethodShape = await call(["v1", "response"], {
      model: "gpt-4.1",
      input: "hi",
    });
    await flushPending();

    expect(suffixed.status).toBe(403);
    expect(wrongMethodShape.status).toBe(403);
    expect(await suffixed.json()).toEqual({ error: "blocked_endpoint" });
    expect(await wrongMethodShape.json()).toEqual({ error: "blocked_endpoint" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
