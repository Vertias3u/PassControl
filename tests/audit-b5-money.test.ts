// B5 money-boundary review; route harness reused from B2.
// Route harness adapted from proxy-receipt.test.ts; only network/state boundaries mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const sentryHarness = vi.hoisted(() => ({
  events: [] as unknown[],
  errors: [] as Error[],
  beforeSend: undefined as undefined | ((event: unknown) => unknown),
}));
vi.mock("@sentry/nextjs", () => ({
  init: (options: { beforeSend: (event: unknown) => unknown }) => { sentryHarness.beforeSend = options.beforeSend; },
  captureException: (error: Error) => {
    sentryHarness.errors.push(error);
    // Serialize the message as the SDK does, then use the REAL registered scrubber.
    sentryHarness.events.push(sentryHarness.beforeSend!({ exception: { values: [{ type: error.name, value: error.message }] } }));
  },
  captureMessage: vi.fn(),
}));
const establishBudgetStateMock = vi.fn();
const fallbacks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/lib/state/fallbacks", () => ({ readCurrentAgentFallbacks: (...args: unknown[]) => fallbacks.read(...args) }));

const {
  verifyVisaMock,
  serviceClientMock,
  openHoldMock,
  settleHoldMock,
  dispatchPermissionMock,
  getCachedKeyMock,
  setCachedKeyMock,
  getCachedAgentPolicyMock,
  setCachedAgentPolicyMock,
  readKillStateMock,
  isSuspendedMock,
  writeLogMock,
  mirrorSpendMock,
  rateLimitMock,
  signReceiptMock,
  readCurrentOwnerMock,
  fetchMock,
} = vi.hoisted(() => ({
  verifyVisaMock: vi.fn(),
  serviceClientMock: vi.fn(),
  openHoldMock: vi.fn(),
  settleHoldMock: vi.fn(),
  dispatchPermissionMock: vi.fn(),
  getCachedKeyMock: vi.fn(),
  setCachedKeyMock: vi.fn(),
  getCachedAgentPolicyMock: vi.fn(),
  setCachedAgentPolicyMock: vi.fn(),
  readKillStateMock: vi.fn(),
  isSuspendedMock: vi.fn(),
  writeLogMock: vi.fn(),
  mirrorSpendMock: vi.fn(),
  rateLimitMock: vi.fn(),
  signReceiptMock: vi.fn(),
  readCurrentOwnerMock: vi.fn(),
  fetchMock: vi.fn(),
}));

const storage = vi.hoisted(() => ({ eval: vi.fn(), zrange: vi.fn(), hgetall: vi.fn() }));
const attack = vi.hoisted(() => ({
  mission: null as import("@/lib/mission/store").MissionRecord | null,
  missionRead: vi.fn(), revoked: false, delegationRead: vi.fn(), redisFailure: false, realKills: false,
  approvalCheck: vi.fn(), telegramPoll: vi.fn(), harnessErrors: [] as string[],
}));
vi.mock("@/lib/mission/store", async (original) => ({
  ...await original<typeof import("@/lib/mission/store")>(),
  readMissionById: (...args: unknown[]) => attack.missionRead(...args),
  readActiveMissionForAgent: (...args: unknown[]) => attack.missionRead(...args),
}));
vi.mock("@/lib/state/mission", () => ({
  readMissionBinding: async () => null, recordMissionDecision: async () => undefined,
}));
vi.mock("@/lib/state/approvals", async (original) => ({
  ...await original<typeof import("@/lib/state/approvals")>(),
  checkApproval: (...args: unknown[]) => attack.approvalCheck(...args),
}));
vi.mock("@/lib/alerts/approvals", () => ({
  sendApprovalPrompt: async () => undefined,
  pollTelegramDecisions: (...args: unknown[]) => attack.telegramPoll(...args),
}));
vi.mock("server-only", () => ({}));
const deferred = vi.hoisted(() => [] as Promise<unknown>[]);
vi.mock("@vercel/functions", () => ({ waitUntil: (p: Promise<unknown>) => { deferred.push(Promise.resolve(p)); } }));
vi.mock("@/lib/auth/visa", () => ({
  extractVisaToken: (headers: Headers) =>
    headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "",
  verifyVisa: (...args: unknown[]) => verifyVisaMock(...args),
}));
vi.mock("@/lib/state/killswitch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/state/killswitch")>();
  return { ...actual, readKillState: (...args: Parameters<typeof actual.readKillState>) => attack.realKills ? actual.readKillState(...args) : readKillStateMock(...args) };
});
vi.mock("@/lib/state/redis", () => ({
  redis: () => ({ eval: storage.eval, zrange: storage.zrange, hgetall: storage.hgetall, smembers: async () => [], mget: async (...keys: string[]) => {
    if (attack.redisFailure) throw new Error("redis unavailable");
    if (keys.some(k => k.startsWith("dlrev:"))) attack.delegationRead();
    return keys.map(k => k.startsWith("dlrev:") && attack.revoked ? "1" : k.startsWith("killswitch:loaded:") ? "1" : null);
  } }),
  touchLastSeen: async () => undefined,
  getCachedEndpoint: async () => "|",
  purgeAgentPolicy: vi.fn(),
  readCredentialFence: vi.fn(async () => null),
  isSuspended: (...args: unknown[]) => isSuspendedMock(...args),
  getCachedKey: (...args: unknown[]) => getCachedKeyMock(...args),
  setCachedKey: (...args: unknown[]) => setCachedKeyMock(...args),
  getCachedAgentPolicy: (...args: unknown[]) => getCachedAgentPolicyMock(...args),
  setCachedAgentPolicy: (...args: unknown[]) => setCachedAgentPolicyMock(...args),
  readPolicyFence: async () => null,
}));
vi.mock("@/lib/state/holds", () => {
  const settle = async (outcome: string, p: Record<string, unknown>) => {
    const r = await settleHoldMock({ ...p, outcome });
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
    consumeDispatchPermission: (...args: unknown[]) => dispatchPermissionMock(...args),
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
vi.mock("@/lib/ratelimit", () => ({ rateLimitFailClosed: (...args: unknown[]) => rateLimitMock(...args), rateLimit: (...args: unknown[]) => rateLimitMock(...args) }));
vi.mock("@/lib/owner/current", () => ({
  readCurrentOwner: (...args: unknown[]) => readCurrentOwnerMock(...args),
}));
vi.mock("@/lib/receipt", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/receipt")>();
  return { ...actual, signReceipt: (...args: unknown[]) => signReceiptMock(...args) };
});

import { POST } from "@/app/api/v1/[provider]/[...path]/route";

const baseClaims = {
  sub: "passport-id",
  agid: "agent-id",
  uid: "user-id",
  jti: "visa-jti-1",
  bt: null,
  bc: null,
  st: 0,
  sc: 0,
  ver: 1,
};

function call(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return POST(
    new Request("https://gateway.test/api/v1/openai/v1/chat/completions?provider=openai&path=v1&path=chat&path=completions", {
      method: "POST",
      headers: { authorization: "Bearer visa", "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ provider: "openai", path: ["v1", "chat", "completions"] }) }
  );
}

const KEY = "sk-test-local-only";
const SCOPES = [{ provider: "openai", models: ["gpt-4o-mini"] }];
const CHAT = { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] };

beforeEach(() => {
  vi.resetAllMocks();
  deferred.length = 0;
  vi.stubEnv("KILL_SWITCH_FAIL_CLOSED", "true");
  vi.stubEnv("POLICY_FAIL_CLOSED", "true");
  attack.harnessErrors.length = 0;
  attack.mission = null;
  attack.revoked = false;
  attack.redisFailure = false; attack.realKills = false;
  attack.missionRead.mockImplementation(async () => attack.mission ? { kind: "ok", record: structuredClone(attack.mission) } : { kind: "none" });
  attack.approvalCheck.mockResolvedValue({ state: "none" });
  verifyVisaMock.mockResolvedValue({ ...baseClaims, scope: SCOPES });
  fallbacks.read.mockResolvedValue([]);
  sentryHarness.events.length = 0;
  sentryHarness.errors.length = 0;
  serviceClientMock.mockReturnValue({
    rpc: vi.fn(async () => ({ data: KEY, error: null })),
    from: (table: string) => {
      if (table === "tripwire_decoys") return { select: () => ({ in: async () => ({ data: [], error: null }) }) };
      const chain = {
        select: () => chain, eq: () => chain,
        maybeSingle: async () => ({ data: { service_rules: { github: { allow: [{ method: "GET", path: "/user" }], max_requests_per_hour: 50 } } }, error: null }),
      };
      return chain;
    },
  });
  openHoldMock.mockResolvedValue({ ok: true, reserved: 1 });
  dispatchPermissionMock.mockResolvedValue({ granted: true });
  settleHoldMock.mockResolvedValue(undefined);
  getCachedKeyMock.mockResolvedValue(null);
  setCachedKeyMock.mockResolvedValue(undefined);
  getCachedAgentPolicyMock.mockResolvedValue(JSON.stringify({ p: {}, s: null }));
  setCachedAgentPolicyMock.mockResolvedValue(undefined);
  readKillStateMock.mockResolvedValue({ platformKill: false, userKill: false, denylist: [] });
  isSuspendedMock.mockResolvedValue(false);
  writeLogMock.mockResolvedValue(undefined);
  mirrorSpendMock.mockResolvedValue(undefined);
  rateLimitMock.mockResolvedValue({ success: true, remaining: 1 });
  signReceiptMock.mockReturnValue("header.payload.signature");
  readCurrentOwnerMock.mockResolvedValue(null);
  fetchMock.mockImplementation(async () =>
    new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  );
  vi.stubGlobal("fetch", fetchMock);
});

async function drain() {
  for (let i = 0; i < deferred.length; i++) await deferred[i];
}
afterEach(async () => {
  await drain();
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
});

// Preconditions execute in hooks, so it.fails can only swallow the property assertion.
describe("B5-01 an output estimate must bound the dispatched generation", () => {
  let forward: Record<string, unknown> | undefined;
  let reservedOutput: number;
  beforeEach(async () => {
    verifyVisaMock.mockResolvedValue({ ...baseClaims, scope: SCOPES, bc: 1 });
    const body = { ...CHAT, n: 4 };
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 65_536 } }), {
      headers: { "content-type": "application/json" },
    }));
    const response = await call(body);
    await response.text(); await drain();
    expect([200, 400, 402]).toContain(response.status);
    forward = undefined;
    reservedOutput = estimateTokenUsage(body).outputTokens;
    if (fetchMock.mock.calls.length === 0) return; // A refusal also protects the cap.
    expect(openHoldMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(settleHoldMock).toHaveBeenCalledTimes(1);
    forward = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(reservedOutput).toBe(4096);
    const hold = openHoldMock.mock.calls[0]![0];
    expect(hold.capMicrocents).toBe(1_000_000);
    expect(hold.estimateMicrocents).toBeGreaterThan(0);
    expect(hold.estimateMicrocents).toBeLessThan(hold.capMicrocents);
    expect(settleHoldMock.mock.calls[0]![0]).toMatchObject({ outcome: "complete", tokens: 65_537 });
    expect(settleHoldMock.mock.calls[0]![0].microcents).toBeGreaterThan(hold.capMicrocents);
  });
  it.fails("B5-01 a dollar-limited request cannot forward an unbounded default output", () => {
    if (!forward) { expect(fetchMock).not.toHaveBeenCalled(); return; }
    const limit = requestedOutputTokens("chat_completions", forward);
    expect(typeof limit === "number" && limit <= reservedOutput).toBe(true);
  });
});

describe("B5-02 a period-only agent with a legacy policy-cache entry", () => {
  let hold: Record<string, unknown>;
  beforeEach(async () => {
    // Readable policy, known unlimited cumulative caps, durable epoch; period
    // metadata absent as on an older cache writer. Redis may still have pbase.
    getCachedAgentPolicyMock.mockResolvedValue(JSON.stringify({
      p: {}, s: null, bk: true, bt: null, bc: null, be: "epoch-existing", bs: true,
    }));
    const response = await call(CHAT);
    await response.text(); await drain();
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(openHoldMock).toHaveBeenCalledTimes(1);
    hold = openHoldMock.mock.calls[0]![0];
    expect(hold.capTokens).toBeNull(); expect(hold.capMicrocents).toBeNull();
  });
  it("B5-02 unknown period must consult its last enforced snapshot", () => {
    expect(hold).toMatchObject({
      periodLimit: { mode: "unknown" },
      budgetState: { epoch: "epoch-existing", established: true },
    });
  });
});

describe("B5-03 declared sub-agent cap is a guardrail, not an adversarial boundary", () => {
  let second: Response;
  beforeEach(async () => {
    getCachedAgentPolicyMock.mockResolvedValue(JSON.stringify({ p: { subagent_session_cap_cents: 0 }, s: null }));
    // The boundary mock refuses exactly the ledger the real Lua refuses at zero.
    openHoldMock.mockImplementation(async (p: { subLedger?: unknown }) =>
      p.subLedger ? { ok: false, reason: "subagent" } : { ok: true, reserved: 1 });
    const first = await call(CHAT, { "x-claude-code-session-id": "same-session", "x-claude-code-agent-id": "child" });
    expect(first.status).toBe(402);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(openHoldMock.mock.calls[0]![0].subLedger).toMatchObject({ capMicrocents: 0 });
    second = await call(CHAT, { "x-claude-code-session-id": "same-session" });
    await second.text(); await drain();
    expect(openHoldMock).toHaveBeenCalledTimes(2);
    expect(openHoldMock.mock.calls[1]![0].subLedger).toBeUndefined();
  });
  it.fails("B5-03 the same child cannot escape its zero cap by omitting its declaration", () => {
    expect(second.status).toBe(402);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("B5-04 recovery must not seed from a partial hold scan", () => {
  beforeEach(async () => {
    // Reuse the B2 I/O boundary but run the REAL exported rebuild helper.
    // No replacement or TypeScript interpretation of any Lua script.
    const ids = Array.from({ length: 1001 }, (_, i) => `open-${i}`);
    storage.zrange.mockImplementation(async (_key: string, start: number, end: number) => ids.slice(start, end + 1));
    storage.hgetall.mockResolvedValue({ st: "open", et: "1", ec: "100000000", cr: String(Date.now()), ph: "pre_dispatch" });
    storage.eval.mockResolvedValue([1000, 100_000_000_000, 3]);
    const { rebuildBudgetState } = await vi.importActual<typeof import("@/lib/state/holds")>("@/lib/state/holds");
    await rebuildBudgetState({ agentId: "agent-id", epoch: "recovery", spentTokens: 0, spentMicrocents: 0 }).catch(() => undefined);
    expect(storage.zrange).toHaveBeenCalled();
    expect(ids).toHaveLength(1001);
  });
  it("B5-04 an incomplete recovery sum must not be written as reserved capacity", () => {
    // Refusing OR reading the complete sum protects capacity; sending a partial
    // NX seed does not. Assert the boundary argument, without interpreting Lua.
    for (const write of storage.eval.mock.calls) {
      expect(Number(write[2][4])).toBeGreaterThanOrEqual(1001 * 100_000_000);
    }
    if (!storage.eval.mock.calls.length) expect(storage.eval).not.toHaveBeenCalled();
  });
});

describe("B5-05 delegation expiry during upload must stop a new hold", () => {
  let expiry: number;
  beforeEach(async () => {
    const initial = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(initial);
    const now = Math.floor(initial / 1000);
    expiry = now + 1;
    const claims = { ...baseClaims, ver: 3, scope: SCOPES, exp: expiry,
      act: { sub: "W".repeat(43), dlg: "jti-0000000000000001", dep: 1, ch: "c".repeat(43) },
      dc: [{ dlg: "jti-0000000000000001", cap: 50_000_000, iat: now - 5, exp: expiry }],
    };
    verifyVisaMock.mockImplementation(async () => Date.now() < expiry * 1000 ? claims : null);
    let release!: () => void;
    const admitted = new Promise<void>(r => { release = r; });
    rateLimitMock.mockImplementation(async (key: string) => {
      if (key === `proxy:${baseClaims.agid}`) release();
      return { success: true, remaining: 1 };
    });
    const body = new ReadableStream<Uint8Array>({ async start(controller) {
      await admitted;
      clock.mockReturnValue(initial + 3_000);
      controller.enqueue(new TextEncoder().encode(JSON.stringify(CHAT))); controller.close();
    } });
    const response = await POST(new Request("https://gateway.test/api/v1/openai/v1/chat/completions", {
      method: "POST", headers: { authorization: "Bearer visa", "content-type": "application/json" },
      body, duplex: "half",
    } as RequestInit), { params: Promise.resolve({ provider: "openai", path: ["v1", "chat", "completions"] }) });
    await response.text(); await drain();
    expect([200, 401, 403]).toContain(response.status);
    expect(verifyVisaMock).toHaveBeenCalled();
    expect(attack.delegationRead).toHaveBeenCalled();
    for (const [hold] of openHoldMock.mock.calls) expect(hold.nowMs).toBeGreaterThan(expiry * 1000);
  });
  it("B5-05 expired delegation cannot reserve after a slow upload", () => {
    expect(openHoldMock).not.toHaveBeenCalled();
  });
});

import { estimateTokenUsage } from "@/lib/pricing";
import { requestedOutputTokens } from "@/lib/output-limit";




function delegatedClaims(exp: number, visaExp = exp) {
  return { ...baseClaims, ver: 3, scope: [...SCOPES, { provider: "groq", models: ["openai/gpt-oss-20b"] }], exp: visaExp,
    act: { sub: "W".repeat(43), dlg: "jti-0000000000000001", dep: 1, ch: "c".repeat(43) },
    dc: [{ dlg: "jti-0000000000000001", cap: 50_000_000, iat: Math.floor(Date.now() / 1000) - 5, exp }],
  };
}

it("B5-05 normal delegated call with distant expiry succeeds unchanged", async () => {
  verifyVisaMock.mockResolvedValue(delegatedClaims(Math.floor(Date.now() / 1000) + 600));
  const response = await call(CHAT);
  await response.text(); await drain();
  expect(response.status).toBe(200);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(openHoldMock).toHaveBeenCalledTimes(1);
  expect(settleHoldMock).toHaveBeenCalledWith(expect.objectContaining({ outcome: "complete", tokens: 2 }));
});

it.each(["link", "visa"])("B5-05 failover releases its hold when %s expires before its forced check", async (expires) => {
  const initial = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(initial);
  const now = Math.floor(initial / 1000);
  verifyVisaMock.mockResolvedValue(delegatedClaims(expires === "link" ? now + 1 : now + 600, expires === "visa" ? now + 1 : now + 600));
  fallbacks.read.mockResolvedValue([{ provider: "groq", model: "openai/gpt-oss-20b" }]);
  openHoldMock.mockImplementation(async () => {
    if (openHoldMock.mock.calls.length === 2) clock.mockReturnValue(initial + 3_000);
    return { ok: true, reserved: 1 };
  });
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { type: "insufficient_quota", code: "insufficient_quota" } }), {
    status: 429, headers: { "content-type": "application/json" },
  }));
  const response = await call(CHAT);
  await response.text(); await drain();
  expect(response.status).toBe(403);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(openHoldMock).toHaveBeenCalledTimes(2);
  const fallback = openHoldMock.mock.calls[1]![0];
  expect(settleHoldMock).toHaveBeenCalledWith(expect.objectContaining({ attemptId: fallback.attemptId, outcome: "not_dispatched" }));
});

it.each([1000, 2500])("B5-04 rebuild with %i open holds restores the exact sum or refuses before writing", async (count) => {
  const ids = Array.from({ length: count }, (_, i) => `open-${i}`);
  storage.zrange.mockImplementation(async (_key: string, start: number, end: number) => ids.slice(start, end + 1));
  storage.hgetall.mockResolvedValue({ st: "open", et: "2", ec: "300", cr: String(Date.now()), ph: "pre_dispatch" });
  storage.eval.mockResolvedValue([count * 2, count * 300, 1]);
  const { rebuildBudgetState } = await vi.importActual<typeof import("@/lib/state/holds")>("@/lib/state/holds");
  if (count > 1000) {
    await expect(rebuildBudgetState({ agentId: "agent-id", epoch: "recovery", spentTokens: 0, spentMicrocents: 0 })).rejects.toThrow(/too many open holds/i);
    expect(storage.eval).not.toHaveBeenCalled();
  } else {
    const result = await rebuildBudgetState({ agentId: "agent-id", epoch: "recovery", spentTokens: 0, spentMicrocents: 0 });
    expect(result).toMatchObject({ computedReservedTokens: count * 2, computedReservedMicrocents: count * 300, truncated: false });
    expect(storage.eval.mock.calls[0]![2].slice(3, 5)).toEqual([String(count * 2), String(count * 300)]);
  }
});

it("B5-02 a cached period limit keeps its caps, epoch and charge", async () => {
  getCachedAgentPolicyMock.mockResolvedValue(JSON.stringify({ p: {}, s: null, bk: true, bt: null, bc: null,
    be: "epoch-existing", bs: true, pdk: true, pdp: "day", pdc: 80 }));
  const response = await call(CHAT);
  await response.text(); await drain();
  expect(response.status).toBe(200);
  expect(openHoldMock).toHaveBeenCalledWith(expect.objectContaining({
    periodLimit: { mode: "set", kind: "day", capMicrocents: 80_000_000 },
    budgetState: { epoch: "epoch-existing", established: true },
  }));
  expect(settleHoldMock).toHaveBeenCalledWith(expect.objectContaining({ outcome: "complete", tokens: 2, microcents: 75 }));
});


it.each(["link", "visa"])("B5-05 period-seed retry refuses when %s expires during the ledger read", async (expires) => {
  const initial = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(initial);
  const now = Math.floor(initial / 1000);
  verifyVisaMock.mockResolvedValue(delegatedClaims(expires === "link" ? now + 1 : now + 600, expires === "visa" ? now + 1 : now + 600));
  getCachedAgentPolicyMock.mockResolvedValue(JSON.stringify({ p: {}, s: null, bk: true, bt: null, bc: null,
    be: "epoch-existing", bs: true, pdk: true, pdp: "day", pdc: 80 }));
  openHoldMock.mockResolvedValueOnce({ ok: false, needsPeriodSeed: true });
  serviceClientMock().rpc.mockImplementation(async (name: string) => {
    if (name === "agent_period_spend") {
      clock.mockReturnValue(initial + 3_000);
      return { data: [{ spent_microcents: 0 }], error: null };
    }
    return { data: KEY, error: null };
  });
  const response = await call(CHAT);
  await drain();
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: "invalid_visa" });
  expect(openHoldMock).toHaveBeenCalledTimes(1);
  expect(serviceClientMock().rpc).toHaveBeenCalledWith("agent_period_spend", expect.any(Object));
  expect(fetchMock).not.toHaveBeenCalled();
  // The seed request reserved nothing, so no release or settlement is due.
  expect(settleHoldMock).not.toHaveBeenCalled();
});
