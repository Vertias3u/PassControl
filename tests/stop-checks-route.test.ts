// A refused call never reaches the provider key and never goes upstream.
//
// proofs/stops proves what the gate DECIDES, for every input. This file ties
// that to the proxy route: seeded random stop states are fired at the real
// route handler, the model below says whether the gate admits each one, and the
// route must then have resolved no key and sent nothing upstream for every call
// the model refuses.
//
// The model is a TypeScript copy of proofs/stops/Stops/Model.lean, function for
// function. Change one and the other must change with it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const establishBudgetStateMock = vi.fn();

const {
  verifyVisaMock,
  serviceClientMock,
  rpcMock,
  openHoldMock,
  settleHoldMock,
  getCachedKeyMock,
  setCachedKeyMock,
  getCachedAgentPolicyMock,
  setCachedAgentPolicyMock,
  readKillStateMock,
  realKillswitch,
  isSuspendedMock,
  writeLogMock,
  mirrorSpendMock,
  rateLimitMock,
  fetchMock,
  readFallbacksMock,
  readProvidersWithKeysMock,
} = vi.hoisted(() => {
  return {
    verifyVisaMock: vi.fn(),
    serviceClientMock: vi.fn(),
    rpcMock: vi.fn(),
    openHoldMock: vi.fn(),
    settleHoldMock: vi.fn(),
    getCachedKeyMock: vi.fn(),
    setCachedKeyMock: vi.fn(),
    getCachedAgentPolicyMock: vi.fn(),
    setCachedAgentPolicyMock: vi.fn(),
    readKillStateMock: vi.fn(),
    // The real readKillState, for the states where the read itself must fail.
    realKillswitch: { readKillState: null as null | ((userId: string | null) => Promise<unknown>) },
    isSuspendedMock: vi.fn(),
    writeLogMock: vi.fn(),
    mirrorSpendMock: vi.fn(),
    rateLimitMock: vi.fn(),
    fetchMock: vi.fn(),
    readFallbacksMock: vi.fn(),
    readProvidersWithKeysMock: vi.fn(),
  };
});

// The harness of tests/proxy-sdk-shape.test.ts, with three additions: the Redis
// client throws (so the real kill read fails when a state asks for that), and
// the fallback list and the providers-with-keys list are settable.
vi.mock("server-only", () => ({}));
vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));
vi.mock("@/lib/auth/visa", () => ({
  extractVisaToken: (headers: Headers) => headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "",
  verifyVisa: (...args: unknown[]) => verifyVisaMock(...args),
}));
vi.mock("@/lib/state/killswitch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/state/killswitch")>();
  realKillswitch.readKillState = actual.readKillState;
  return {
    ...actual,
    readKillState: (...args: unknown[]) => readKillStateMock(...args),
  };
});
vi.mock("@/lib/state/redis", () => ({
  // The client the real readKillState asks for. It is down.
  redis: () => {
    throw new Error("redis unreachable");
  },
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
    consumeDispatchPermission: async () => ({ granted: true }),
    settleKnown: (p: Record<string, unknown>) => settle("complete", p),
    settleUnknown: (p: Record<string, unknown>) => settle("usage_unknown", p),
    releaseUndispatched: (p: Record<string, unknown>) => settle("not_dispatched", p),
    establishBudgetState: (...args: unknown[]) => establishBudgetStateMock(...args),
  };
});
vi.mock("@/lib/state/fallbacks", () => ({
  readCurrentAgentFallbacks: (...args: unknown[]) => readFallbacksMock(...args),
}));
vi.mock("@/lib/providers/available", () => ({
  readProvidersWithKeys: (...args: unknown[]) => readProvidersWithKeysMock(...args),
}));
vi.mock("@/lib/state/delegation", () => ({ readDelegationRevocation: async () => false }));
vi.mock("@/lib/supabase", () => ({ serviceClient: () => serviceClientMock() }));
vi.mock("@/lib/crypto/aesgcm", () => ({ seal: async () => "sealed", open: async (v: string) => v }));
vi.mock("@/lib/log", () => ({
  writeLog: (...args: unknown[]) => writeLogMock(...args),
  mirrorSpend: (...args: unknown[]) => mirrorSpendMock(...args),
}));
vi.mock("@/lib/ratelimit", () => ({ rateLimit: (...args: unknown[]) => rateLimitMock(...args) }));

// The final gate as a backstop (2026-11-10). Off unless a test sets it: when set, the
// LAST evaluation before the key (the only one handed a successful reserve) answers
// "denied by <step>" although every earlier check passed. That is the disagreement
// `staged_gates_agree` proves cannot happen today; the route must still refuse on it.
const finalGateOverride = vi.hoisted(() => ({ deniedBy: null as null | string }));
vi.mock("@/lib/gate", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/gate")>();
  return {
    ...real,
    evaluateGate: (input: Parameters<typeof real.evaluateGate>[0]) => {
      const out = real.evaluateGate(input);
      if (finalGateOverride.deniedBy && input.budget?.ok === true && !out.deniedBy) {
        return { ...out, verdict: "deny" as const, deniedBy: finalGateOverride.deniedBy as NonNullable<typeof out.deniedBy> };
      }
      return out;
    },
  };
});

import { POST } from "@/app/api/v1/[provider]/[...path]/route";

// ───────────────────────────────────────────────────────────────────────────
// The model. A copy of proofs/stops/Stops/Model.lean.
// ───────────────────────────────────────────────────────────────────────────

type Step = "kill" | "suspend" | "scope" | "endpoint" | "policy" | "budget";

/** `order`. */
const ORDER: readonly Step[] = ["kill", "suspend", "scope", "endpoint", "policy", "budget"];

type Outcome = { k: "pass" } | { k: "fail"; rule: string } | { k: "wait" } | { k: "exempt" };
const PASS: Outcome = { k: "pass" };
const WAIT: Outcome = { k: "wait" };
const EXEMPT: Outcome = { k: "exempt" };
const fail = (rule: string): Outcome => ({ k: "fail", rule });

interface ModelKillState {
  platformKill: boolean;
  userKill: boolean;
  denylist: string[];
  recordedSessionStops: Array<[agentId: string, sessionId: string]>;
}

interface ModelGateInput {
  agentId: string;
  killState: ModelKillState | null;
  suspended: boolean | null;
  scopes: { ruleMatch: boolean; subagentRestricted: boolean; subagentMatch: boolean } | null;
  modelListing: boolean;
  endpoint: {
    allowed: boolean;
    modelRouter: boolean;
    searchModel: boolean;
    dollarLimited: boolean;
    requiresEndpoint: boolean;
    unpricedModel: boolean;
  };
  policy: "unreadable" | { allowed: boolean; hourly: boolean } | null;
  policyFailClosed: boolean;
  now: boolean;
  policyRateLimit: { success: boolean; unreadable: boolean } | null;
  budget: boolean | null;
}

/** `isBlocked`. */
function isBlockedModel(st: ModelKillState, agentId: string): boolean {
  return st.platformKill || st.userKill || st.denylist.includes(agentId);
}

/** `killOutcome`. */
function killOutcome(i: ModelGateInput): Outcome {
  if (i.killState === null) return WAIT;
  const st = i.killState;
  if (st.platformKill) return fail("kill:platform");
  if (st.userKill) return fail("kill:tenant");
  if (st.denylist.includes(i.agentId)) return fail("kill:denylist");
  return PASS;
}

/** `suspendOutcome`. */
function suspendOutcome(i: ModelGateInput): Outcome {
  if (i.suspended === null) return WAIT;
  return i.suspended ? fail("suspend:active") : PASS;
}

/** `scopeOutcome`. */
function scopeOutcome(i: ModelGateInput): Outcome {
  if (i.scopes === null) return WAIT;
  const s = i.scopes;
  if (i.modelListing) return EXEMPT;
  if (!s.ruleMatch) return fail("scope:no_match");
  if (s.subagentRestricted && !s.subagentMatch) return fail("scope:subagent_no_match");
  return PASS;
}

/** `endpointOutcome`. */
function endpointOutcome(i: ModelGateInput): Outcome {
  if (!i.endpoint.allowed) return fail("endpoint:no_match");
  if (i.endpoint.modelRouter) return fail("endpoint:model_router");
  if (i.endpoint.searchModel) return fail("endpoint:openai_search_model");
  if (i.endpoint.dollarLimited && i.endpoint.requiresEndpoint) return fail("endpoint:unpriced_endpoint");
  if (i.endpoint.dollarLimited && !i.modelListing && i.endpoint.unpricedModel) {
    return fail("endpoint:unpriced_model");
  }
  return PASS;
}

/** `policyOutcome`. */
function policyOutcome(i: ModelGateInput): Outcome {
  if (i.policy === null) return WAIT;
  if (i.policy === "unreadable") return i.policyFailClosed ? fail("policy:unreadable") : PASS;
  const d = i.policy;
  if (!i.now) return WAIT;
  if (!d.allowed) return fail("policy:rule");
  if (d.hourly) {
    if (i.policyRateLimit === null) return WAIT;
    const rl = i.policyRateLimit;
    if (rl.success) return PASS;
    if (rl.unreadable) return PASS;
    return fail("max_requests_per_hour");
  }
  return PASS;
}

/** `budgetOutcome`. */
function budgetOutcome(i: ModelGateInput): Outcome {
  if (i.budget === null) return WAIT;
  return i.budget ? PASS : fail("budget");
}

/** `outcome`. */
function outcome(s: Step, i: ModelGateInput): Outcome {
  switch (s) {
    case "kill":
      return killOutcome(i);
    case "suspend":
      return suspendOutcome(i);
    case "scope":
      return scopeOutcome(i);
    case "endpoint":
      return endpointOutcome(i);
    case "policy":
      return policyOutcome(i);
    case "budget":
      return budgetOutcome(i);
  }
}

interface ModelEvaluation {
  verdict: "allow" | "deny";
  deniedBy: Step | null;
  complete: boolean;
}

/** `Acc.apply`, `run` and `evaluateGate`. */
function evaluateGateModel(i: ModelGateInput): ModelEvaluation {
  let deniedBy: Step | null = null;
  let pending = false;
  for (const s of ORDER) {
    if (deniedBy !== null || pending) continue;
    const o = outcome(s, i);
    if (o.k === "fail") deniedBy = s;
    else if (o.k === "wait") pending = true;
  }
  return { verdict: deniedBy !== null ? "deny" : "allow", deniedBy, complete: !pending };
}

/** `admits`. */
function admits(i: ModelGateInput): boolean {
  const g = evaluateGateModel(i);
  return g.verdict === "allow" && g.complete;
}

type SuspendRead = "no" | "agent" | "session";

/** `withRecordedSessionStop`. */
function withRecordedSessionStopModel(
  read: SuspendRead,
  st: ModelKillState,
  agentId: string,
  sessionId: string | null
): SuspendRead {
  if (read === "no" && sessionId !== null) {
    if (sessionId === "") return "no";
    if (st.recordedSessionStops.some(([a, s]) => a === agentId && s === sessionId)) return "session";
    return "no";
  }
  return read;
}

/** `routeSuspended`. */
function routeSuspendedModel(
  read: SuspendRead,
  st: ModelKillState,
  agentId: string,
  sessionId: string | null,
  principalSuspended: boolean
): boolean {
  return withRecordedSessionStopModel(read, st, agentId, sessionId) !== "no" || principalSuspended;
}

/** `Env`: `null` is unset. */
interface ModelEnv {
  killSwitchFailClosed: string | null;
}

/** `Env.killClosed`. */
const killClosed = (env: ModelEnv): boolean => env.killSwitchFailClosed === "true";

interface RedisKill {
  platform: boolean;
  tenant: boolean;
  denylist: string[];
}

/** `KillRead`. `recordFailed` needs a real record to fail and is left to the proof. */
type KillRead =
  | { kind: "redisFailed" }
  | { kind: "loaded"; r: RedisKill }
  | { kind: "reloaded"; r: RedisKill; tenantStop: boolean; sessions: Array<[string, string]> };

/** `readKillState`. */
function readKillStateModel(env: ModelEnv, read: KillRead): ModelKillState {
  switch (read.kind) {
    case "redisFailed":
      return killClosed(env)
        ? { platformKill: true, userKill: false, denylist: [], recordedSessionStops: [] }
        : { platformKill: false, userKill: false, denylist: [], recordedSessionStops: [] };
    case "loaded":
      return {
        platformKill: read.r.platform,
        userKill: read.r.tenant,
        denylist: read.r.denylist,
        recordedSessionStops: [],
      };
    case "reloaded":
      return {
        platformKill: read.r.platform,
        userKill: read.r.tenant || read.tenantStop,
        denylist: read.r.denylist,
        recordedSessionStops: read.sessions,
      };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Scenarios
// ───────────────────────────────────────────────────────────────────────────

const AGENT = "agent-id";
const OTHER_AGENT = "another-agent";
const SESSION = "11111111-2222-4333-8444-555555555555";
const OTHER_SESSION = "99999999-2222-4333-8444-555555555555";
const IN_SCOPE_MODEL = "gpt-4o-mini";
const OUT_OF_SCOPE_MODEL = "gpt-4o";
const FALLBACK = { provider: "groq", model: "llama-3.3-70b-versatile" };
const KEY_RPCS = new Set(["get_provider_key", "get_provider_key_for_credential"]);

const baseClaims = {
  sub: "passport-id",
  agid: AGENT,
  uid: "user-id",
  jti: "jti-1",
  bt: null,
  bc: null,
  st: 0,
  sc: 0,
  ver: 1,
  scope: [
    { provider: "openai", models: [IN_SCOPE_MODEL] },
    { provider: "groq", models: [FALLBACK.model] },
  ],
};

/** A small seeded generator (mulberry32), so a failure names a seed that replays. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    chance: (p: number) => next() < p,
    pick: <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!,
  };
}

/** One stop state: what the reads return, and under which environment. */
interface StopState {
  env: ModelEnv;
  killRead: KillRead;
  suspendRead: SuspendRead;
  sessionId: string | null;
}

interface Scenario extends StopState {
  model: string;
  endpointAllowed: boolean;
  /** The agent's live policy has a deny rule that names the requested model. */
  policyDenies: boolean;
  budgetOk: boolean;
}

// Every spelling the variable is likely to be given. Only the first one closes.
const ENV_VALUES: ReadonlyArray<string | null> = ["true", null, null, "false", "TRUE", "1"];

function randomStopState(r: ReturnType<typeof rng>): StopState {
  const env: ModelEnv = { killSwitchFailClosed: r.pick(ENV_VALUES) };
  const sessionId = r.chance(0.5) ? SESSION : null;
  const redis: RedisKill = {
    platform: r.chance(0.12),
    tenant: r.chance(0.12),
    denylist: r.pick([[], [], [], [AGENT], [OTHER_AGENT], [OTHER_AGENT, AGENT]]),
  };
  const kind = r.pick(["loaded", "loaded", "loaded", "reloaded", "redisFailed"] as const);
  const killRead: KillRead =
    kind === "redisFailed"
      ? { kind }
      : kind === "loaded"
        ? { kind, r: redis }
        : {
            kind,
            r: redis,
            tenantStop: r.chance(0.2),
            sessions: r.pick([
              [],
              [[AGENT, SESSION]],
              [[OTHER_AGENT, SESSION]],
              [[AGENT, OTHER_SESSION]],
            ] as Array<Array<[string, string]>>),
          };
  const suspendRead = r.pick(["no", "no", "no", "no", "agent", "session"] as const);
  return { env, killRead, suspendRead, sessionId };
}

function randomScenario(seed: number): Scenario {
  const r = rng(seed);
  return {
    ...randomStopState(r),
    model: r.chance(0.2) ? OUT_OF_SCOPE_MODEL : IN_SCOPE_MODEL,
    endpointAllowed: r.chance(0.9),
    policyDenies: r.chance(0.15),
    budgetOk: r.chance(0.8),
  };
}

/** The gate input the model is asked about, for one attempt of one scenario. */
function gateInputFor(
  s: StopState,
  rest: { inScope: boolean; endpointAllowed: boolean; policyDenies: boolean; budgetOk: boolean }
): ModelGateInput {
  const killState = readKillStateModel(s.env, s.killRead);
  return {
    agentId: AGENT,
    killState,
    suspended: routeSuspendedModel(s.suspendRead, killState, AGENT, s.sessionId, false),
    scopes: { ruleMatch: rest.inScope, subagentRestricted: false, subagentMatch: false },
    modelListing: false,
    endpoint: {
      allowed: rest.endpointAllowed,
      modelRouter: false,
      searchModel: false,
      dollarLimited: false,
      requiresEndpoint: false,
      unpricedModel: false,
    },
    // The harness serves a readable policy with no hourly limit: empty, or one deny rule.
    policy: { allowed: !rest.policyDenies, hourly: false },
    policyFailClosed: false,
    now: true,
    policyRateLimit: null,
    budget: rest.budgetOk,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Driving the real route
// ───────────────────────────────────────────────────────────────────────────

const CLEAR = { platformKill: false, userKill: false, denylist: [] as string[] };

/** What the mocked kill read answers for a state. A failed read runs the REAL function. */
function killReadAnswer(s: StopState): () => Promise<unknown> {
  if (s.killRead.kind === "redisFailed") return () => realKillswitch.readKillState!("user-id");
  const st = readKillStateModel(s.env, s.killRead);
  const answer = {
    platformKill: st.platformKill,
    userKill: st.userKill,
    denylist: st.denylist,
    ...(st.recordedSessionStops.length
      ? { recordedSessionStops: st.recordedSessionStops.map(([agentId, sessionId]) => ({ agentId, sessionId })) }
      : {}),
  };
  return async () => answer;
}

/** The cached policy row: empty, or one deny rule naming the model every scenario requests in scope. */
const policyRow = (denies: boolean) =>
  JSON.stringify({ p: denies ? { deny: [{ provider: "openai", models: [IN_SCOPE_MODEL] }] } : {}, s: null });

const suspendAnswer = (read: SuspendRead): boolean | "session" =>
  read === "no" ? false : read === "agent" ? true : "session";

function setEnv(env: ModelEnv) {
  if (env.killSwitchFailClosed === null) delete process.env.KILL_SWITCH_FAIL_CLOSED;
  else process.env.KILL_SWITCH_FAIL_CLOSED = env.killSwitchFailClosed;
}

function upstream(body: string, status: number) {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

const OK_BODY = JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } });
const QUOTA_BODY = JSON.stringify({
  error: { message: "quota", type: "insufficient_quota", code: "insufficient_quota" },
});

async function callProxy(opts: { model: string; path: string[]; sessionId: string | null }) {
  const headers: Record<string, string> = { authorization: "Bearer visa", "content-type": "application/json" };
  if (opts.sessionId) headers["x-claude-code-session-id"] = opts.sessionId;
  return POST(
    new Request(`https://gateway.test/api/v1/openai/${opts.path.join("/")}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: opts.model, max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
    }),
    { params: Promise.resolve({ provider: "openai", path: opts.path }) }
  );
}

/** How many times the route asked for a provider key, by each of the three ways. */
function keyTouches() {
  return {
    cache: getCachedKeyMock.mock.calls.length,
    rpc: rpcMock.mock.calls.filter(([name]) => KEY_RPCS.has(String(name))).length,
    fetch: fetchMock.mock.calls.length,
  };
}

/** The position of a mock's first call among all mock calls in this test. */
const firstCall = (m: { mock: { invocationCallOrder: number[] } }) => m.mock.invocationCallOrder[0] ?? -1;

function firstKeyRpcCall(): number {
  const index = rpcMock.mock.calls.findIndex(([name]) => KEY_RPCS.has(String(name)));
  return index < 0 ? -1 : rpcMock.mock.invocationCallOrder[index]!;
}

const savedEnv = process.env.KILL_SWITCH_FAIL_CLOSED;

function resetHarness() {
  for (const m of [
    verifyVisaMock, serviceClientMock, rpcMock, openHoldMock, settleHoldMock, getCachedKeyMock,
    setCachedKeyMock, getCachedAgentPolicyMock, setCachedAgentPolicyMock, readKillStateMock,
    isSuspendedMock, writeLogMock, mirrorSpendMock, rateLimitMock, fetchMock, readFallbacksMock,
    readProvidersWithKeysMock,
  ]) {
    m.mockReset();
  }
  verifyVisaMock.mockResolvedValue(baseClaims);
  rpcMock.mockImplementation(async () => ({ data: "provider-key", error: null }));
  serviceClientMock.mockReturnValue({ rpc: rpcMock });
  openHoldMock.mockResolvedValue({ ok: true, reserved: 1 });
  settleHoldMock.mockResolvedValue(undefined);
  getCachedKeyMock.mockResolvedValue(null);
  setCachedKeyMock.mockResolvedValue(undefined);
  getCachedAgentPolicyMock.mockResolvedValue(JSON.stringify({ p: {}, s: null }));
  setCachedAgentPolicyMock.mockResolvedValue(undefined);
  readKillStateMock.mockResolvedValue(CLEAR);
  isSuspendedMock.mockResolvedValue(false);
  writeLogMock.mockResolvedValue(undefined);
  mirrorSpendMock.mockResolvedValue(undefined);
  rateLimitMock.mockResolvedValue({ success: true, remaining: 1 });
  readFallbacksMock.mockResolvedValue([]);
  readProvidersWithKeysMock.mockResolvedValue(["openai", "groq"]);
  fetchMock.mockImplementation(async () => upstream(OK_BODY, 200));
  vi.stubGlobal("fetch", fetchMock);
}

beforeEach(resetHarness);

afterEach(() => {
  if (savedEnv === undefined) delete process.env.KILL_SWITCH_FAIL_CLOSED;
  else process.env.KILL_SWITCH_FAIL_CLOSED = savedEnv;
});

const SCENARIOS = 400;
const FAILOVERS = 150;

describe("a refused call never reaches the provider key", () => {
  it(`holds for ${SCENARIOS} seeded stop states, with the proved gate as the oracle`, async () => {
    const seen = new Map<string, number>();
    const count = (what: string) => seen.set(what, (seen.get(what) ?? 0) + 1);

    for (let seed = 1; seed <= SCENARIOS; seed++) {
      const s = randomScenario(seed);
      const label = `seed ${seed}: ${JSON.stringify(s)}`;
      resetHarness();
      setEnv(s.env);
      readKillStateMock.mockImplementation(killReadAnswer(s));
      isSuspendedMock.mockResolvedValue(suspendAnswer(s.suspendRead));
      if (!s.budgetOk) openHoldMock.mockResolvedValue({ ok: false, reason: "tokens", reserved: 0 });
      getCachedAgentPolicyMock.mockResolvedValue(policyRow(s.policyDenies));

      const input = gateInputFor(s, {
        inScope: s.model === IN_SCOPE_MODEL,
        endpointAllowed: s.endpointAllowed,
        policyDenies: s.policyDenies,
        budgetOk: s.budgetOk,
      });
      const expected = evaluateGateModel(input);

      const res = await callProxy({
        model: s.model,
        path: s.endpointAllowed ? ["chat", "completions"] : ["not", "an", "endpoint"],
        sessionId: s.sessionId,
      });
      const touched = keyTouches();

      if (!admits(input)) {
        // The claim: no cache read, no Vault RPC, nothing upstream.
        expect(touched, label).toEqual({ cache: 0, rpc: 0, fetch: 0 });
        expect(res.status, label).toBe(expected.deniedBy === "budget" ? 402 : 403);
        const body = await res.text();
        expect(body, label).not.toContain("provider-key");
        if (expected.deniedBy === "kill" || expected.deniedBy === "suspend") {
          // One opaque code for both, so a caller cannot probe which control fired.
          expect(body, label).toContain("blocked_suspended");
        }
        if (expected.deniedBy === "scope") expect(body, label).toContain("blocked_scope");
        if (expected.deniedBy === "policy") expect(body, label).toContain("blocked_policy");
        if (expected.deniedBy === "budget") expect(body, label).toContain("blocked_budget");
        if (expected.deniedBy !== "budget") {
          // Refused before the budget step: nothing was reserved either.
          expect(openHoldMock, label).not.toHaveBeenCalled();
        }
        count(`refused:${expected.deniedBy}`);
      } else {
        expect(res.status, label).toBe(200);
        expect(touched, label).toEqual({ cache: 1, rpc: 1, fetch: 1 });
        // The key is resolved only after the kill, suspension and scope reads
        // (the scope arrives with the verified credential), and after the reserve.
        const kill = firstCall(readKillStateMock);
        const suspend = firstCall(isSuspendedMock);
        const visa = firstCall(verifyVisaMock);
        const reserve = firstCall(openHoldMock);
        const cache = firstCall(getCachedKeyMock);
        const rpc = firstKeyRpcCall();
        const sent = firstCall(fetchMock);
        expect(Math.min(visa, kill, suspend, reserve), label).toBeGreaterThan(0);
        expect(Math.max(visa, kill, suspend), label).toBeLessThan(reserve);
        expect(reserve, label).toBeLessThan(cache);
        expect(cache, label).toBeLessThan(rpc);
        expect(rpc, label).toBeLessThan(sent);
        count("admitted");
      }
      if (s.killRead.kind === "redisFailed") {
        count(killClosed(s.env) ? "kill read failed, closed" : "kill read failed, open");
        // The failed read is the real function's own answer, checked against the model.
        const real = (await realKillswitch.readKillState!("user-id")) as { platformKill: boolean };
        expect(real.platformKill, label).toBe(readKillStateModel(s.env, s.killRead).platformKill);
      }
      if (s.suspendRead === "session") count("session stop");
      if (s.killRead.kind === "reloaded" && s.sessionId !== null && s.suspendRead === "no" &&
          s.killRead.sessions.some(([a, id]) => a === AGENT && id === s.sessionId)) {
        count("recorded session stop");
      }
    }

    // The generator must not quietly stop producing a category.
    for (const category of [
      "refused:kill", "refused:suspend", "refused:scope", "refused:endpoint", "refused:policy",
      "refused:budget",
      "admitted", "kill read failed, closed", "kill read failed, open", "session stop",
      "recorded session stop",
    ]) {
      expect(seen.get(category) ?? 0, `${category} in ${JSON.stringify([...seen])}`).toBeGreaterThan(5);
    }
  });

  it("refuses on each single stop alone, everything else clear", async () => {
    const clearRedis: RedisKill = { platform: false, tenant: false, denylist: [] };
    const base: Scenario = {
      env: { killSwitchFailClosed: null },
      killRead: { kind: "loaded", r: clearRedis },
      suspendRead: "no",
      sessionId: SESSION,
      model: IN_SCOPE_MODEL,
      endpointAllowed: true,
      policyDenies: false,
      budgetOk: true,
    };
    const single: Array<[string, Partial<Scenario>, Step | null]> = [
      ["nothing armed", {}, null],
      ["platform kill", { killRead: { kind: "loaded", r: { ...clearRedis, platform: true } } }, "kill"],
      ["tenant kill", { killRead: { kind: "loaded", r: { ...clearRedis, tenant: true } } }, "kill"],
      ["denylist", { killRead: { kind: "loaded", r: { ...clearRedis, denylist: [AGENT] } } }, "kill"],
      ["another agent on the denylist", { killRead: { kind: "loaded", r: { ...clearRedis, denylist: [OTHER_AGENT] } } }, null],
      ["agent suspension", { suspendRead: "agent" }, "suspend"],
      ["session stop", { suspendRead: "session" }, "suspend"],
      ["session stop reloaded from the record", { killRead: { kind: "reloaded", r: clearRedis, tenantStop: false, sessions: [[AGENT, SESSION]] } }, "suspend"],
      ["another session's recorded stop", { killRead: { kind: "reloaded", r: clearRedis, tenantStop: false, sessions: [[AGENT, OTHER_SESSION]] } }, null],
      ["tenant stop reloaded from the record", { killRead: { kind: "reloaded", r: clearRedis, tenantStop: true, sessions: [] } }, "kill"],
      ["out-of-scope model", { model: OUT_OF_SCOPE_MODEL }, "scope"],
      ["policy deny rule", { policyDenies: true }, "policy"],
      ["budget exhausted", { budgetOk: false }, "budget"],
      ["kill read throws, default posture", { killRead: { kind: "redisFailed" } }, null],
      ["kill read throws, KILL_SWITCH_FAIL_CLOSED=false", { killRead: { kind: "redisFailed" }, env: { killSwitchFailClosed: "false" } }, null],
      ["kill read throws, KILL_SWITCH_FAIL_CLOSED=true", { killRead: { kind: "redisFailed" }, env: { killSwitchFailClosed: "true" } }, "kill"],
    ];
    for (const [name, change, deniedBy] of single) {
      const s: Scenario = { ...base, ...change };
      resetHarness();
      setEnv(s.env);
      readKillStateMock.mockImplementation(killReadAnswer(s));
      isSuspendedMock.mockResolvedValue(suspendAnswer(s.suspendRead));
      if (!s.budgetOk) openHoldMock.mockResolvedValue({ ok: false, reason: "tokens", reserved: 0 });
      getCachedAgentPolicyMock.mockResolvedValue(policyRow(s.policyDenies));
      const input = gateInputFor(s, {
        inScope: s.model === IN_SCOPE_MODEL,
        endpointAllowed: true,
        policyDenies: s.policyDenies,
        budgetOk: s.budgetOk,
      });

      // The table above is written by hand; the model must agree with it first.
      expect.soft(evaluateGateModel(input).deniedBy, name).toBe(deniedBy);

      await callProxy({ model: s.model, path: ["chat", "completions"], sessionId: s.sessionId });
      // Soft, so one run reports every row that is wrong and not only the first.
      expect.soft(keyTouches(), name).toEqual(
        deniedBy === null ? { cache: 1, rpc: 1, fetch: 1 } : { cache: 0, rpc: 0, fetch: 0 }
      );
    }
  });
});

describe("failover re-checks the stops before it touches a second key", () => {
  it(`holds for ${FAILOVERS} seeded stops armed after the primary upstream failed`, async () => {
    let stopped = 0;
    let wentOn = 0;
    for (let seed = 1; seed <= FAILOVERS; seed++) {
      const r = rng(seed * 7919);
      // Stops are armed when primary returns; all reads before its dispatch are clear.
      const fresh = randomStopState(r);
      const primaryStatus = r.pick([429, 500, 503]);
      const label = `seed ${seed}: ${JSON.stringify({ fresh, primaryStatus })}`;
      resetHarness();
      setEnv(fresh.env);
      readFallbacksMock.mockResolvedValue([FALLBACK]);
      readKillStateMock.mockResolvedValue(CLEAR);
      isSuspendedMock.mockResolvedValue(false);
      fetchMock
        .mockReset()
        .mockImplementationOnce(async () => {
          readKillStateMock.mockImplementation(killReadAnswer(fresh));
          isSuspendedMock.mockResolvedValue(suspendAnswer(fresh.suspendRead));
          return upstream(primaryStatus === 429 ? QUOTA_BODY : "{}", primaryStatus);
        })
        .mockImplementation(async () => upstream(OK_BODY, 200));

      const fallbackInput = gateInputFor(fresh, {
        inScope: true,
        endpointAllowed: true,
        policyDenies: false,
        budgetOk: true,
      });

      await callProxy({ model: IN_SCOPE_MODEL, path: ["chat", "completions"], sessionId: fresh.sessionId });
      const touched = keyTouches();

      if (!admits(fallbackInput)) {
        // Armed between the attempts: no second key, no second send.
        expect(touched, label).toEqual({ cache: 1, rpc: 1, fetch: 1 });
        stopped++;
      } else {
        // The control: the same setup with nothing armed does fail over, so the
        // stop is what held the second attempt back and not a broken fallback.
        expect(touched, label).toEqual({ cache: 2, rpc: 2, fetch: 2 });
        expect(new URL(String(fetchMock.mock.calls[1]![0])).host, label).toBe("api.groq.com");
        wentOn++;
      }
    }
    expect(stopped).toBeGreaterThan(20);
    expect(wentOn).toBeGreaterThan(20);
  });
});

describe("the final gate is a backstop, not only a budget check", () => {
  it.each(["kill", "suspend", "scope", "endpoint", "policy"])(
    "refuses, releases the hold and touches no key when only the final gate says %s",
    async (step) => {
      finalGateOverride.deniedBy = step;
      try {
        const res = await callProxy({ model: IN_SCOPE_MODEL, path: ["chat", "completions"], sessionId: null });
        expect(res.status).toBe(403);
        expect(keyTouches()).toEqual({ cache: 0, rpc: 0, fetch: 0 });
        expect(settleHoldMock).toHaveBeenCalledWith(expect.objectContaining({ outcome: "not_dispatched" }));
      } finally {
        finalGateOverride.deniedBy = null;
      }
    }
  );
});
