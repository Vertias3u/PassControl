// B2 dispatch revocation regression tests.
// Route harness adapted from proxy-receipt.test.ts; only network/state boundaries mocked.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import OpenAI from "openai";
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
vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));
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
  redis: () => ({ smembers: async () => [], mget: async (...keys: string[]) => {
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

function call(body: Record<string, unknown>) {
  return POST(
    new Request("https://gateway.test/api/v1/openai/v1/chat/completions?provider=openai&path=v1&path=chat&path=completions", {
      method: "POST",
      headers: { authorization: "Bearer visa", "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ provider: "openai", path: ["v1", "chat", "completions"] }) }
  );
}

const CHAT = { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] };

beforeEach(() => {
  vi.resetAllMocks();
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


import { GET as serviceGET } from "@/app/api/v1/svc/[service]/[...path]/route";
const KEY = "sk-proj-7Hx2Qa9Lm4Jv8Bc3Np6Wr0Ty5Dg1Fs";
const upstream = (body: string, status = 400, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "content-type": "application/json", ...headers } });
const SERVICE_TOKEN = "ghp_7Hx2Qa9Lm4Jv8Bc3Np6Wr0Ty5Dg1FsAa9Bb0C";
async function serviceCall() {
  serviceClientMock().rpc.mockResolvedValue({ data: SERVICE_TOKEN, error: null });
  return serviceGET(new Request("https://gateway.test/api/v1/svc/github/user?service=github&path=user", {
    headers: { authorization: "Bearer visa" },
  }), { params: Promise.resolve({ service: "github", path: ["user"] }) });
}

const FALLBACK = { provider: "groq", model: "openai/gpt-oss-20b" };
const SCOPES = [{ provider: "openai", models: ["gpt-4o-mini"] }, { provider: "groq", models: [FALLBACK.model] }];
const OK = JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } });
const QUOTA = JSON.stringify({ error: { type: "insufficient_quota", code: "insufficient_quota" } });
afterEach(() => {
  vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
  // Keep infrastructure/precondition failures visible after each test.
  expect(attack.harnessErrors).toEqual([]);
});

// Assertions proving the attack reached its intended boundary throw explicitly:
// Keep broken harness assertions distinct from the dispatch assertions.
function requireAttack(condition: unknown, message: string): asserts condition {
  if (!condition) { attack.harnessErrors.push(message); throw new Error("B2 HARNESS: " + message); }
}
function hosts() { return fetchMock.mock.calls.map(c => new URL(String(c[0])).host); }

it("B2-01 slow provider body cannot dispatch after tenant stop", async () => {
  let release!: () => void;
  const ready = new Promise<void>(r => { release = r; });
  let finish!: () => void;
  const stalled = new Promise<void>(r => { finish = r; });
  // A rate-limit response marks that the real route passed its stop gate.
  rateLimitMock.mockImplementation(async () => { release(); return { success: true, remaining: 1 }; });
  const body = new ReadableStream<Uint8Array>({ async start(c) {
    await stalled;
    c.enqueue(new TextEncoder().encode(JSON.stringify(CHAT))); c.close();
  } });
  const req = new Request("https://gateway.test/api/v1/openai/v1/chat/completions?provider=openai&path=v1&path=chat&path=completions", {
    method: "POST", headers: { authorization: "Bearer visa", "content-type": "application/json" }, body,
    duplex: "half",
  } as RequestInit);
  const pending = POST(req, { params: Promise.resolve({ provider: "openai", path: ["v1", "chat", "completions"] }) });
  await ready;
  requireAttack(readKillStateMock.mock.calls.length === 1 && fetchMock.mock.calls.length === 0, "not stalled before dispatch");
  readKillStateMock.mockResolvedValue({ platformKill: false, userKill: true, denylist: [] });
  finish();
  await pending;
  const sent = fetchMock.mock.calls.length;
  requireAttack((await call(CHAT)).status === 403 && fetchMock.mock.calls.length === sent, "new provider request did not honor tenant stop");
  expect(fetchMock).not.toHaveBeenCalled();
});

it("B2-02 Telegram approval after service stop cannot dispatch", async () => {
  const db = serviceClientMock();
  db.from = () => {
    const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: {
      service_rules: { github: { allow: [{ method: "GET", path: "/user", ask: true }], max_requests_per_hour: 50 } },
    }, error: null }) }; return chain;
  };
  attack.approvalCheck.mockResolvedValueOnce({ state: "pending", id: "question" }).mockResolvedValue({ state: "approved", id: "question" });
  attack.telegramPoll.mockImplementation(async () => {
    requireAttack(fetchMock.mock.calls.length === 0, "already dispatched before Telegram poll");
    readKillStateMock.mockResolvedValue({ platformKill: false, userKill: false, denylist: [], serviceKill: true });
    return { state: "ok" };
  });
  await serviceCall();
  requireAttack(attack.telegramPoll.mock.calls.length === 1, "did not reach real approval wait");
  const sent = fetchMock.mock.calls.length;
  requireAttack((await serviceCall()).status === 403 && fetchMock.mock.calls.length === sent, "new service request did not honor service stop");
  expect(fetchMock).not.toHaveBeenCalled();
});

function delegatedClaims() {
  const now = Math.floor(Date.now() / 1000);
  return { ...baseClaims, ver: 3, scope: SCOPES,
    act: { sub: "W".repeat(43), dlg: "jti-0000000000000001", dep: 1, ch: "c".repeat(43) },
    dc: [{ dlg: "jti-0000000000000001", cap: 50_000_000, iat: now - 5, exp: now + 600 }],
  };
}
it("B2-03 delegation revoked after primary cannot start fallback", async () => {
  verifyVisaMock.mockResolvedValue(delegatedClaims());
  fallbacks.read.mockResolvedValue([FALLBACK]);
  fetchMock.mockImplementationOnce(async () => {
    attack.revoked = true; // real readDelegationRevocation will now refuse
    return upstream(QUOTA, 429);
  }).mockImplementation(async () => upstream(OK, 200));
  const response = await call(CHAT);
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ error: "delegation_revoked" });
  expect(openHoldMock).toHaveBeenCalledTimes(2);
  expect(settleHoldMock).toHaveBeenCalledTimes(2);
  expect(settleHoldMock.mock.calls[1]![0]).toMatchObject({ outcome: "not_dispatched" });
  requireAttack(hosts()[0] === "api.openai.com", "primary not dispatched");
  const sent = hosts();
  requireAttack((await call(CHAT)).status === 403 && hosts().length === sent.length, "new worker request did not honor revocation");
  expect(sent).toEqual(["api.openai.com"]);
});





const DIRECT_KEY = "pc_agent_" + "A".repeat(43);
function directCall() {
  return POST(new Request("https://gateway.test/api/v1/openai/v1/chat/completions?provider=openai&path=v1&path=chat&path=completions", {
    method: "POST", headers: { authorization: `Bearer ${DIRECT_KEY}`, "content-type": "application/json" }, body: JSON.stringify(CHAT),
  }), { params: Promise.resolve({ provider: "openai", path: ["v1", "chat", "completions"] }) });
}
it("B2-05 Direct Agent Key revoked after primary cannot start fallback", async () => {
  let revoked = false;
  const rpc = serviceClientMock().rpc;
  rpc.mockImplementation(async (name: string) => name === "authenticate_direct_agent_key" ? { data: revoked ? [] : [{
    key_id: "key-id", agent_id: baseClaims.agid, user_id: baseClaims.uid, agent_status: "active",
    allowed_scopes: SCOPES, budget_tokens: null, budget_cents: null, spent_tokens: 0, spent_microcents: 0,
  }], error: null } : { data: KEY, error: null });
  fallbacks.read.mockResolvedValue([FALLBACK]);
  fetchMock.mockImplementationOnce(async () => { revoked = true; return upstream(QUOTA, 429); })
    .mockImplementation(async () => upstream(OK, 200));
  const response = await directCall();
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({ error: "invalid_credential" });
  requireAttack(hosts()[0] === "api.openai.com", "direct primary did not authenticate and dispatch");
  const attempts = hosts();
  // Confirm actual authenticator is uncached: a new request with the SAME token
  // sees the revoked database record and cannot send anything further.
  const refused = await directCall();
  requireAttack(refused.status === 401 && hosts().length === attempts.length, "fresh direct request was not refused");
  requireAttack(rpc.mock.calls.filter((c: unknown[]) => c[0] === "authenticate_direct_agent_key").length >= 2, "unexpected direct authentication reads");
  expect(attempts).toEqual(["api.openai.com"]);
  expect(rpc.mock.calls.filter((c: unknown[]) => c[0] === "authenticate_direct_agent_key")).toHaveLength(3);
});

// Advance the route's clock at the body read, without sleeping or changing timers
// used by approval/timeout code. Admission has already read all authority here.
function slowUpload(change: () => void, token = "visa") {
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now);
  let release!: () => void;
  const ready = new Promise<void>(r => { release = r; });
  rateLimitMock.mockImplementation(async (key: string) => { if (key === `proxy:${baseClaims.agid}`) release(); return { success: true, remaining: 1 }; });
  const body = new ReadableStream<Uint8Array>({ async start(controller) {
    await ready;
    vi.spyOn(Date, "now").mockReturnValue(now + 2_001);
    change();
    controller.enqueue(new TextEncoder().encode(JSON.stringify(CHAT))); controller.close();
  } });
  const req = new Request("https://gateway.test/api/v1/openai/v1/chat/completions", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body, duplex: "half",
  } as RequestInit);
  return POST(req, { params: Promise.resolve({ provider: "openai", path: ["v1", "chat", "completions"] }) });
}
function directRpc() {
  let revoked = false;
  const rpc = serviceClientMock().rpc;
  rpc.mockImplementation(async (name: string) => name === "authenticate_direct_agent_key" ? { data: revoked ? [] : [{
    key_id: "key-id", agent_id: baseClaims.agid, user_id: baseClaims.uid, agent_status: "active",
    allowed_scopes: SCOPES, budget_tokens: null, budget_cents: null, spent_tokens: 0, spent_microcents: 0,
  }], error: null } : { data: KEY, error: null });
  return { rpc, revoke: () => { revoked = true; } };
}
it("slow first upload rechecks delegation and releases its hold", async () => {
  verifyVisaMock.mockResolvedValue(delegatedClaims());
  const response = await slowUpload(() => { attack.revoked = true; });
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ error: "delegation_revoked" });
  expect(fetchMock).not.toHaveBeenCalled();
  expect(getCachedKeyMock).not.toHaveBeenCalled();
  expect(openHoldMock).toHaveBeenCalledTimes(1);
  expect(settleHoldMock).toHaveBeenCalledTimes(1);
  expect(settleHoldMock).toHaveBeenCalledWith(expect.objectContaining({ outcome: "not_dispatched" }));
  expect(writeLogMock).toHaveBeenCalledWith(expect.objectContaining({ status: "blocked_delegation_revoked" }));
  expect(signReceiptMock).toHaveBeenCalled();
});

it("slow first upload rechecks Direct Agent Key", async () => {
  const key = directRpc();
  const response = await slowUpload(key.revoke, DIRECT_KEY);
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({ error: "invalid_credential" });
  expect(fetchMock).not.toHaveBeenCalled();
  expect(getCachedKeyMock).not.toHaveBeenCalled();
  expect(key.rpc.mock.calls.filter((c: unknown[]) => c[0] === "authenticate_direct_agent_key")).toHaveLength(2);
});



it("ordinary service with no stop forwards unchanged", async () => {
  expect((await serviceCall()).status).toBe(200);
  expect(hosts()).toEqual(["api.github.com"]);
  expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: "GET", redirect: "manual" });
});
for (const closed of [false, true]) {
  it(`Redis recheck failure uses admission posture (closed=${closed})`, async () => {
    attack.realKills = true;
    vi.stubEnv("KILL_SWITCH_FAIL_CLOSED", closed ? "true" : "false");
    const response = await slowUpload(() => { attack.redisFailure = true; });
    expect(response.status).toBe(closed ? 403 : 200);
    const sent = fetchMock.mock.calls.length;
    // Same real kill reader, failed on admission rather than at dispatch.
    expect((await call(CHAT)).status).toBe(closed ? 403 : 200);
    expect(fetchMock.mock.calls.length - sent).toBe(closed ? 0 : 1);
  });
}
it("unreadable delegation at recheck fails closed", async () => {
  verifyVisaMock.mockResolvedValue(delegatedClaims());
  expect((await slowUpload(() => { attack.redisFailure = true; })).status).toBe(503);
  expect(fetchMock).not.toHaveBeenCalled();
});

it("unreadable Direct Agent Key at recheck is not authenticated", async () => {
  const key = directRpc();
  expect((await slowUpload(() => { key.rpc.mockRejectedValue(new Error("database unavailable")); }, DIRECT_KEY)).status).toBe(503);
  expect(fetchMock).not.toHaveBeenCalled();
});

it("stop during dispatch permission prevents the send and settles known zero once", async () => {
  dispatchPermissionMock.mockImplementation(async () => {
    readKillStateMock.mockResolvedValue({ platformKill: false, userKill: true, denylist: [] });
    return { granted: true };
  });
  expect((await call(CHAT)).status).toBe(403);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(openHoldMock).toHaveBeenCalledTimes(1);
  expect(settleHoldMock).toHaveBeenCalledTimes(1);
  expect(settleHoldMock).toHaveBeenCalledWith(expect.objectContaining({ outcome: "complete", tokens: 0, microcents: 0 }));
  expect(writeLogMock).toHaveBeenCalledWith(expect.objectContaining({ status: "blocked_killed" }));
  expect(signReceiptMock).toHaveBeenCalled();
});
it("service rechecks a stop armed during token resolution", async () => {
  const db = serviceClientMock();
  db.rpc.mockImplementation(async () => {
    readKillStateMock.mockResolvedValue({ platformKill: false, userKill: false, denylist: [], serviceKill: true });
    return { data: SERVICE_TOKEN, error: null };
  });
  const response = await serviceGET(new Request("https://gateway.test/api/v1/svc/github/user", { headers: { authorization: "Bearer visa" } }), { params: Promise.resolve({ service: "github", path: ["user"] }) });
  expect(response.status).toBe(403);
  expect(fetchMock).not.toHaveBeenCalled();
});
function askService(change: () => void, token = "visa") {
  const db = serviceClientMock();
  db.from = () => {
    const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: {
      service_rules: { github: { allow: [{ method: "GET", path: "/user", ask: true }], max_requests_per_hour: 50 } },
    }, error: null }) }; return chain;
  };
  attack.approvalCheck.mockResolvedValueOnce({ state: "pending", id: "question" }).mockResolvedValue({ state: "approved", id: "question" });
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now);
  attack.telegramPoll.mockImplementation(async () => {
    vi.spyOn(Date, "now").mockReturnValue(now + 2_001);
    change();
    return { state: "ok" };
  });
  return serviceGET(new Request("https://gateway.test/api/v1/svc/github/user", { headers: { authorization: `Bearer ${token}` } }), { params: Promise.resolve({ service: "github", path: ["user"] }) });
}
it("service reauthenticates Direct Agent Key after a slow approval", async () => {
  const key = directRpc();
  expect((await askService(key.revoke, DIRECT_KEY)).status).toBe(401);
  expect(attack.telegramPoll).toHaveBeenCalledTimes(1);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(key.rpc.mock.calls.filter((c: unknown[]) => c[0] === "authenticate_direct_agent_key")).toHaveLength(2);
  expect(key.rpc.mock.calls.filter((c: unknown[]) => c[0] === "get_provider_key")).toHaveLength(0);
});

for (const closed of [false, true]) {
  it(`service Redis recheck failure matches admission posture (closed=${closed})`, async () => {
    attack.realKills = true;
    vi.stubEnv("KILL_SWITCH_FAIL_CLOSED", closed ? "true" : "false");
    expect((await askService(() => { attack.redisFailure = true; })).status).toBe(closed ? 403 : 200);
    expect((await serviceCall()).status).toBe(closed ? 403 : 200);
  });
}



it("a stop armed during a slow authority recheck still prevents dispatch", async () => {
  const key = directRpc();
  const authenticate = key.rpc.getMockImplementation()!;
  let reads = 0;
  key.rpc.mockImplementation(async (...args: unknown[]) => {
    if (args[0] === "authenticate_direct_agent_key" && ++reads === 2) {
      readKillStateMock.mockResolvedValue({ platformKill: false, userKill: true, denylist: [] });
    }
    return authenticate(...args);
  });
  expect((await slowUpload(() => {}, DIRECT_KEY)).status).toBe(403);
  expect(fetchMock).not.toHaveBeenCalled();
});
