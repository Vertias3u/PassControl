// "A stopped call never reaches a key", for the SERVICE proxy: the second place
// PassControl injects a real credential (app/api/v1/svc/[service]/[...path]/route.ts).
//
// The proofs in proofs/stops/Stops/Service.lean are about a model of that route: an
// ordered list of checks, each an early return, then the key read, then the send.
// This file ties the model to the code. Seeded random states, several stops armed at
// once, go through the REAL route handler on the mock harness of
// tests/proxy-service.test.ts, and a TypeScript copy of the model says, for each one,
// which check refuses and whether the key may be read.
//
// The block marked MODEL mirrors Service.lean definition for definition. Change one,
// change the other.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  verifyVisa: vi.fn(),
  authenticateDirectAgentKey: vi.fn(),
  readKillState: vi.fn(),
  isSuspended: vi.fn(),
  readPolicy: vi.fn(),
  writeLog: vi.fn(),
  rateLimit: vi.fn(),
  rateLimitFailClosed: vi.fn(),
  captureSecurityEvent: vi.fn(),
  signReceipt: vi.fn(),
  fetch: vi.fn(),
  rpc: vi.fn(),
  rulesRead: vi.fn(),
  awaitApproval: vi.fn(),
  existingApproval: vi.fn(),
}));

vi.mock("@/lib/mission/gate", () => ({ resolveCallMission: async () => ({ kind: "none" }) }));
vi.mock("server-only", () => ({}));
vi.mock("@vercel/functions", () => ({ waitUntil: (promise: unknown) => promise }));
vi.mock("@/lib/auth/visa", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/visa")>()),
  verifyVisa: (...a: unknown[]) => h.verifyVisa(...a),
}));
vi.mock("@/lib/auth/direct-key", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/direct-key")>()),
  authenticateDirectAgentKey: (...a: unknown[]) => h.authenticateDirectAgentKey(...a),
}));
vi.mock("@/lib/state/killswitch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/state/killswitch")>()),
  readKillState: (...a: unknown[]) => h.readKillState(...a),
}));
vi.mock("@/lib/state/redis", () => ({
  isSuspended: (...a: unknown[]) => h.isSuspended(...a),
  touchLastSeen: vi.fn(async () => undefined),
  claimNonce: vi.fn(async () => true),
  flagPassportSecretExposed: vi.fn(async () => undefined),
  // The Redis client the REAL kill read asks for: unreachable, so that read throws.
  redis: () => {
    throw new Error("redis unreachable");
  },
}));
vi.mock("@/lib/state/policy", () => ({
  readCurrentAgentPolicyAndShadow: (...a: unknown[]) => h.readPolicy(...a),
}));
vi.mock("@/lib/supabase", () => ({
  serviceClient: () => ({
    rpc: (...a: unknown[]) => h.rpc(...a),
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () => h.rulesRead(table),
      };
      return chain;
    },
  }),
}));
vi.mock("@/lib/log", () => ({ writeLog: (...a: unknown[]) => h.writeLog(...a) }));
vi.mock("@/lib/ratelimit", () => ({
  rateLimit: (...a: unknown[]) => h.rateLimit(...a),
  rateLimitFailClosed: (...a: unknown[]) => h.rateLimitFailClosed(...a),
}));
vi.mock("@/lib/observability", () => ({
  captureError: vi.fn(async () => undefined),
  captureSecurityEvent: (...a: unknown[]) => h.captureSecurityEvent(...a),
  logFailOpen: vi.fn(),
}));
vi.mock("@/lib/receipt", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/receipt")>()),
  signReceipt: (...a: unknown[]) => h.signReceipt(...a),
}));
vi.mock("@/lib/owner/current", () => ({ readCurrentOwner: async () => null }));
vi.mock("@/lib/approvals/gate", () => ({
  approvalWaitMs: () => 0,
  awaitApproval: (...a: unknown[]) => h.awaitApproval(...a),
  existingApproval: (...a: unknown[]) => h.existingApproval(...a),
}));

import { GET, POST } from "@/app/api/v1/svc/[service]/[...path]/route";
import { matchServiceRule, parseServiceRules, serviceCallAsks } from "@/lib/services/rules";
import { SERVICE_CATALOG, serviceRefusal } from "@/lib/services/catalog";

const realKillswitch = await vi.importActual<typeof import("@/lib/state/killswitch")>("@/lib/state/killswitch");

// ── MODEL (mirrors proofs/stops/Stops/Service.lean, and Model.lean where it reuses it) ──

interface KillState {
  platformKill: boolean;
  userKill: boolean;
  denylist: string[];
  recordedSessionStops: [string, string][];
}
// def isBlocked (Model.lean)
const isBlocked = (st: KillState, agentId: string) => st.platformKill || st.userKill || st.denylist.includes(agentId);

type SuspendRead = "no" | "agent" | "session";
// def withRecordedSessionStop (Model.lean)
function withRecordedSessionStop(read: SuspendRead, st: KillState, agentId: string, sessionId: string | null): SuspendRead {
  if (read === "no" && sessionId !== null) {
    if (sessionId === "") return "no";
    return st.recordedSessionStops.some(([a, s]) => a === agentId && s === sessionId) ? "session" : "no";
  }
  return read;
}
// def routeSuspended (Model.lean)
const routeSuspended = (read: SuspendRead, st: KillState, agentId: string, sessionId: string | null, principal: boolean) =>
  withRecordedSessionStop(read, st, agentId, sessionId) !== "no" || principal;

interface Env { killSwitchFailClosed: string | null }
// def Env.killClosed (Model.lean)
const killClosed = (env: Env) => env.killSwitchFailClosed === "true";

interface RedisKill { platform: boolean; tenant: boolean; denylist: string[] }
// structure SvcRedis
interface SvcRedis { base: RedisKill; services: string[] }
// inductive SvcKillRead
type SvcKillRead =
  | { kind: "redisFailed" }
  | { kind: "loaded"; r: SvcRedis }
  | { kind: "recordFailed"; r: SvcRedis }
  | { kind: "reloaded"; r: SvcRedis; tenantStop: boolean; sessions: [string, string][]; serviceStops: string[] };

const redisState = (r: RedisKill): KillState => ({
  platformKill: r.platform, userKill: r.tenant, denylist: r.denylist, recordedSessionStops: [],
});
// def readKillState (Model.lean), through SvcKillRead.base
function readKillState(env: Env, read: SvcKillRead): KillState {
  switch (read.kind) {
    case "redisFailed":
      return { platformKill: killClosed(env), userKill: false, denylist: [], recordedSessionStops: [] };
    case "loaded":
      return redisState(read.r.base);
    case "recordFailed":
      return killClosed(env) ? { ...redisState(read.r.base), platformKill: true } : redisState(read.r.base);
    case "reloaded":
      return {
        ...redisState(read.r.base),
        userKill: read.r.base.tenant || read.tenantStop,
        recordedSessionStops: read.sessions,
      };
  }
}
// def readServiceKill
function readServiceKill(service: string, read: SvcKillRead): boolean {
  switch (read.kind) {
    case "redisFailed": return false;
    case "loaded": return read.r.services.includes(service);
    case "recordFailed": return read.r.services.includes(service);
    case "reloaded": return read.r.services.includes(service) || read.serviceStops.includes(service);
  }
}

type Door = "passport" | "directKey";
type RulesRead = "unreadable" | "malformed" | "noRules" | "matched" | "unmatched";
type CapRead = "ok" | "exhausted" | "unreadable";
type Approval = "approved" | "pending" | "denied" | "full" | "unavailable";
type DecryptRead = "failed" | "noToken" | "token";

// structure Input
interface Input {
  env: Env;
  door: Door;
  service: string;
  knownService: boolean;
  pathOk: boolean;
  authenticated: boolean;
  senderProofOk: boolean;
  agentId: string;
  sessionId: string | null;
  keySuspended: boolean;
  killRead: SvcKillRead;
  suspendRead: SuspendRead;
  missionRefuses: boolean;
  rateLimitOk: boolean;
  catalogRefuses: boolean;
  rules: RulesRead;
  cap: CapRead;
  isWrite: boolean;
  mediaTypeOk: boolean;
  bodyWithinBound: boolean;
  queryOk: boolean;
  asks: boolean;
  askedBefore: boolean;
  pathTooLong: boolean;
  previewTooLarge: boolean;
  awaited: Approval;
  existing: Approval | null;
  decrypt: DecryptRead;
  tokenShapeOk: boolean;
}

// def killState / serviceKill / principalSuspended / suspended
const killState = (i: Input) => readKillState(i.env, i.killRead);
const serviceKill = (i: Input) => readServiceKill(i.service, i.killRead);
const principalSuspended = (i: Input) => i.door === "directKey" && i.keySuspended;
const suspended = (i: Input) =>
  routeSuspended(i.suspendRead, killState(i), i.agentId, i.sessionId, principalSuspended(i));
// def revocationRefuses, in the form `revocation_refuses_iff` proves it equal to
const revocationRefuses = (i: Input) => isBlocked(killState(i), i.agentId) || suspended(i) || serviceKill(i);

// def approvalState / approvalHolds
const approvalState = (i: Input): Approval | null =>
  i.asks ? i.awaited : i.previewTooLarge || i.pathTooLong ? null : i.existing;
const approvalHolds = (i: Input) => {
  const s = approvalState(i);
  return s !== null && s !== "approved";
};

// inductive Check
type Check =
  | "unknownService" | "invalidPath" | "authenticate" | "senderProof" | "revocation" | "mission"
  | "rateLimit" | "catalog" | "rulesUnreadable" | "rulesMalformed" | "rulesNotAllowed"
  | "capUnreadable" | "capExhausted" | "mediaType" | "bodyTooLarge" | "invalidQuery"
  | "approvalPathTooLong" | "approvalTooLarge" | "approval"
  | "credentialUnavailable" | "noToken" | "tokenShape"
  ;

// def refuses
function refuses(i: Input, c: Check): boolean {
  switch (c) {
    case "unknownService": return !i.knownService;
    case "invalidPath": return !i.pathOk;
    case "authenticate": return !i.authenticated;
    case "senderProof": return i.door === "passport" && !i.senderProofOk;
    case "revocation": return revocationRefuses(i);
    case "mission": return i.missionRefuses;
    case "rateLimit": return !i.rateLimitOk;
    case "catalog": return i.catalogRefuses;
    case "rulesUnreadable": return i.rules === "unreadable";
    case "rulesMalformed": return i.rules === "malformed";
    case "rulesNotAllowed": return i.rules === "noRules" || i.rules === "unmatched";
    case "capUnreadable": return i.cap === "unreadable";
    case "capExhausted": return i.cap === "exhausted";
    case "mediaType": return i.isWrite && !i.mediaTypeOk;
    case "bodyTooLarge": return i.isWrite && !i.bodyWithinBound;
    case "invalidQuery": return !i.queryOk;
    case "approvalPathTooLong": return i.asks && i.pathTooLong;
    case "approvalTooLarge": return i.asks && (i.previewTooLarge || i.pathTooLong);
    case "approval": return (i.asks || i.askedBefore) && approvalHolds(i);
    case "credentialUnavailable": return i.decrypt === "failed";
    case "noToken": return i.decrypt === "noToken";
    case "tokenShape": return !i.tokenShapeOk;
  }
}

// def beforeKey
const beforeKey: Check[] = [
  "unknownService", "invalidPath", "authenticate", "senderProof", "revocation", "mission",
  "rateLimit", "catalog", "rulesUnreadable", "rulesMalformed", "rulesNotAllowed",
  "capUnreadable", "capExhausted", "mediaType", "bodyTooLarge", "invalidQuery",
  "approvalPathTooLong", "approvalTooLarge", "approval",
];
// def afterKey
const afterKey: Check[] = [
  "credentialUnavailable", "noToken", "tokenShape",
];

// def firstRefusal
const firstRefusal = (i: Input, l: Check[]): Check | null => l.find((c) => refuses(i, c)) ?? null;

interface Result { refusedBy: Check | null; keyRead: boolean; sent: boolean }
// def route
function route(i: Input): Result {
  const before = firstRefusal(i, beforeKey);
  if (before !== null) return { refusedBy: before, keyRead: false, sent: false };
  const after = firstRefusal(i, afterKey);
  if (after !== null) return { refusedBy: after, keyRead: true, sent: false };
  return { refusedBy: null, keyRead: true, sent: true };
}

// ── END MODEL ───────────────────────────────────────────────────────────────

const TOKEN = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB";
const VISA = "visa.token.value";
const DIRECT_KEY = `pc_agent_${"k".repeat(43)}`;
const AGENT = "11111111-1111-4111-8111-111111111111";
const OTHER_AGENT = "33333333-3333-4333-8333-333333333333";
const TENANT = "22222222-2222-4222-8222-222222222222";
const ORIGIN = "https://gw.example";
const SESSION = "session-aaaa-1111";
const OTHER_SESSION = "session-bbbb-2222";
const SERVICE = "github";
const OTHER_SERVICE = "telegram";

const RULE_SETS = {
  read: { github: { allow: [{ method: "GET", path: "/repos/acme/*/issues" }], max_requests_per_hour: 50 } },
  other: { github: { allow: [{ method: "GET", path: "/user" }], max_requests_per_hour: 50 } },
  ask: { github: { allow: [{ method: "GET", path: "/repos/acme/*/issues", ask: true }], max_requests_per_hour: 50 } },
  malformed: { github: { allow: "everything" } },
  none: null,
} as const;
type RuleSet = keyof typeof RULE_SETS | "unreadable";

/** One state of the world: what every read answers, and how the call comes in. */
interface Scenario {
  env: Env;
  door: Door;
  keySuspended: boolean;
  killRead: SvcKillRead;
  suspendRead: SuspendRead;
  sessionId: string | null;
  rateLimitOk: boolean;
  /** The never list: GitHub's GraphQL endpoint, refused whatever the rules say. */
  neverListed: boolean;
  ruleSet: RuleSet;
  cap: CapRead;
  awaited: Approval;
  decrypt: DecryptRead;
}

const CLEAR: Scenario = {
  env: { killSwitchFailClosed: null },
  door: "passport",
  keySuspended: false,
  killRead: { kind: "loaded", r: { base: { platform: false, tenant: false, denylist: [] }, services: [] } },
  suspendRead: "no",
  sessionId: null,
  rateLimitOk: true,
  neverListed: false,
  ruleSet: "read",
  cap: "ok",
  awaited: "approved",
  decrypt: "token",
};

const callShape = (s: Scenario) =>
  s.neverListed
    ? { method: "POST", path: "/graphql", segments: ["graphql"] }
    : { method: "GET", path: "/repos/acme/web/issues", segments: ["repos", "acme", "web", "issues"] };

/** The model's input for a scenario. The helpers' answers come from the real helpers (V1). */
function inputFor(s: Scenario): Input {
  const { method, segments } = callShape(s);
  let rules: RulesRead = "unreadable";
  let asks = false;
  if (s.ruleSet !== "unreadable") {
    const read = parseServiceRules(RULE_SETS[s.ruleSet], SERVICE);
    if (read.kind === "malformed") rules = "malformed";
    else if (read.kind !== "rules") rules = "noRules";
    else {
      rules = matchServiceRule(read.rules, method, segments) ? "matched" : "unmatched";
      asks = serviceCallAsks(read.rules, method, segments);
    }
  }
  return {
    env: s.env,
    door: s.door,
    service: SERVICE,
    knownService: true,
    pathOk: true,
    authenticated: true,
    senderProofOk: true,
    agentId: AGENT,
    sessionId: s.sessionId,
    keySuspended: s.keySuspended,
    killRead: s.killRead,
    suspendRead: s.suspendRead,
    missionRefuses: false,
    rateLimitOk: s.rateLimitOk,
    catalogRefuses: serviceRefusal(SERVICE_CATALOG[SERVICE], method, segments) !== null,
    rules,
    cap: s.cap,
    isWrite: method !== "GET",
    mediaTypeOk: true,
    bodyWithinBound: true,
    queryOk: true,
    asks,
    askedBefore: false,
    pathTooLong: false,
    previewTooLarge: false,
    awaited: s.awaited,
    existing: null,
    decrypt: s.decrypt,
    tokenShapeOk: true,
  };
}

/** The error code the route answers with, for the check the model names. */
function expectedCode(check: Check, s: Scenario): string {
  switch (check) {
    case "revocation": return "blocked_suspended";
    case "rateLimit": return "rate_limited";
    case "catalog": return "service_endpoint_refused";
    case "rulesUnreadable": return "service_rules_unavailable";
    case "rulesMalformed": return "service_rules_invalid";
    case "rulesNotAllowed": return "service_call_not_allowed";
    case "capUnreadable": return "service_rate_limit_unavailable";
    case "capExhausted": return "service_rate_limited";
    case "approval":
      return { pending: "approval_pending", denied: "approval_denied", full: "approval_queue_full",
        unavailable: "approval_unavailable", approved: "?" }[s.awaited];
    case "credentialUnavailable": return "credential_unavailable";
    case "noToken": return "no_service_credential";
    default: throw new Error(`the harness never arms ${check}`);
  }
}

// ── Driving the real route ──────────────────────────────────────────────────

function arm(s: Scenario) {
  if (s.env.killSwitchFailClosed === null) delete process.env.KILL_SWITCH_FAIL_CLOSED;
  else process.env.KILL_SWITCH_FAIL_CLOSED = s.env.killSwitchFailClosed;

  if (s.killRead.kind === "redisFailed") {
    // The REAL readKillState, against a Redis client that throws.
    h.readKillState.mockImplementation((userId: string, options: { service?: string }) =>
      realKillswitch.readKillState(userId, options)
    );
  } else {
    const st = readKillState(s.env, s.killRead);
    h.readKillState.mockResolvedValue({
      platformKill: st.platformKill,
      userKill: st.userKill,
      denylist: st.denylist,
      serviceKill: readServiceKill(SERVICE, s.killRead),
      ...(st.recordedSessionStops.length
        ? { recordedSessionStops: st.recordedSessionStops.map(([agentId, sessionId]) => ({ agentId, sessionId })) }
        : {}),
    });
  }
  h.isSuspended.mockResolvedValue(s.suspendRead === "no" ? false : s.suspendRead === "agent" ? true : "session");
  h.authenticateDirectAgentKey.mockResolvedValue({
    kind: "direct_key", keyId: "key-id", agentId: AGENT, userId: TENANT, scopes: [],
    budgetTokens: null, budgetCents: null, spentTokens: 0, spentMicrocents: 0, suspended: s.keySuspended,
  });
  h.rateLimit.mockResolvedValue(s.rateLimitOk ? { success: true, remaining: 10 } : { success: false, remaining: 0 });
  h.rateLimitFailClosed.mockImplementation(async (key: string) => {
    // The Direct Agent Key door has its own pre-auth limiter; only the hourly cap is armed.
    if (!key.startsWith("svc-cap:")) return { success: true, remaining: 10 };
    if (s.cap === "ok") return { success: true, remaining: 10 };
    return s.cap === "unreadable" ? { success: false, remaining: 0, unreadable: true } : { success: false, remaining: 0 };
  });
  if (s.ruleSet === "unreadable") h.rulesRead.mockResolvedValue({ data: null, error: { message: "db down" } });
  else h.rulesRead.mockResolvedValue({ data: { service_rules: RULE_SETS[s.ruleSet], name: "Agent" }, error: null });
  h.awaitApproval.mockResolvedValue(s.awaited === "approved" ? { state: "approved", id: "approval-id" } : { state: s.awaited });
  h.existingApproval.mockResolvedValue({ state: "none" });
  h.rpc.mockImplementation(async (name: string) => {
    if (!String(name).startsWith("get_provider_key")) return { data: null, error: null };
    if (s.decrypt === "failed") return { data: null, error: { message: "vault down" } };
    return { data: s.decrypt === "token" ? TOKEN : null, error: null };
  });
}

async function callRoute(s: Scenario): Promise<Response> {
  const { method, path, segments } = callShape(s);
  // Shaped the way Next hands it over: the route's own params re-appended to the search.
  const injected = [`service=${SERVICE}`, ...segments.map((seg) => `path=${seg}`)].join("&");
  const headers: Record<string, string> =
    s.door === "passport" ? { authorization: `Bearer ${VISA}` } : { "x-api-key": DIRECT_KEY };
  if (s.sessionId) headers["x-claude-code-session-id"] = s.sessionId;
  if (method === "POST") headers["content-type"] = "application/json";
  const req = new Request(`${ORIGIN}/api/v1/svc/${SERVICE}${path}?${injected}`, {
    method,
    headers,
    ...(method === "POST" ? { body: JSON.stringify({ query: "{ viewer { login } }" }) } : {}),
  });
  const ctx = { params: Promise.resolve({ service: SERVICE, path: segments }) };
  return method === "POST" ? POST(req, ctx) : GET(req, ctx);
}

const keyReadOrders = () =>
  h.rpc.mock.calls
    .map(([name], index) => (String(name).startsWith("get_provider_key") ? h.rpc.mock.invocationCallOrder[index]! : -1))
    .filter((order) => order >= 0);

/** Run one scenario through the real route and hold it to the model. Returns the model's verdict. */
async function check(s: Scenario, label: string): Promise<Result> {
  resetHarness();
  arm(s);
  const model = route(inputFor(s));
  const res = await callRoute(s);
  const keys = keyReadOrders();
  const sends = h.fetch.mock.invocationCallOrder;

  if (!model.keyRead) {
    // Refused before step 7: the key is never asked for and nothing leaves.
    expect(keys.length, `${label}: refused by ${model.refusedBy}, yet the key was read`).toBe(0);
    expect(sends.length, `${label}: refused by ${model.refusedBy}, yet a call was sent`).toBe(0);
  } else {
    expect(keys.length, `${label}: the key read`).toBe(1);
    expect(sends.length, `${label}: sends`).toBe(model.sent ? 1 : 0);
    // The key read comes after the kill and suspension reads.
    expect(h.readKillState.mock.invocationCallOrder[0]!, `${label}: kill read before the key`).toBeLessThan(keys[0]!);
    expect(h.isSuspended.mock.invocationCallOrder[0]!, `${label}: suspension read before the key`).toBeLessThan(keys[0]!);
    if (model.sent) expect(keys[0]!, `${label}: key before the send`).toBeLessThan(sends[0]!);
  }

  if (model.refusedBy === null) {
    expect(res.status, `${label}: admitted`).toBe(200);
  } else {
    const body = (await res.json()) as { error?: string };
    expect(body.error, `${label}: which check refused`).toBe(expectedCode(model.refusedBy, s));
  }
  // The kill read always names this service, on both doors.
  if (h.readKillState.mock.calls.length > 0) {
    expect(h.readKillState.mock.calls[0]).toEqual([TENANT, { service: SERVICE }]);
  }
  return model;
}

function resetHarness() {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", h.fetch);
  h.verifyVisa.mockResolvedValue({
    agid: AGENT, uid: TENANT, sub: "passport-id", jti: "visa-jti",
    scope: [{ provider: "anthropic", models: ["claude-*"] }],
  });
  h.readPolicy.mockResolvedValue({
    policy: null, shadow: null, senderConstraintMode: "off", budget: { known: false }, period: { known: false },
  });
  h.signReceipt.mockReturnValue("signed.receipt.jws");
  h.writeLog.mockResolvedValue(undefined);
  h.fetch.mockImplementation(
    async () =>
      new Response(JSON.stringify([{ number: 1 }]), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      })
  );
}

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

// Every spelling the variable is likely to be given. Only the first one closes.
const ENV_VALUES: ReadonlyArray<string | null> = ["true", null, null, "false", "TRUE", "1"];

function randomScenario(seed: number): Scenario {
  const r = rng(seed);
  const redis: SvcRedis = {
    base: {
      platform: r.chance(0.06),
      tenant: r.chance(0.06),
      denylist: r.pick([[], [], [], [], [AGENT], [OTHER_AGENT], [OTHER_AGENT, AGENT]]),
    },
    services: r.pick([[], [], [], [OTHER_SERVICE], [SERVICE], [OTHER_SERVICE, SERVICE]]),
  };
  const kind = r.pick(["loaded", "loaded", "loaded", "loaded", "reloaded", "recordFailed", "redisFailed"] as const);
  const killRead: SvcKillRead =
    kind === "redisFailed" ? { kind }
    : kind === "loaded" || kind === "recordFailed" ? { kind, r: redis }
    : {
        kind,
        r: redis,
        tenantStop: r.chance(0.1),
        sessions: r.pick([[], [], [[AGENT, SESSION]], [[OTHER_AGENT, SESSION]], [[AGENT, OTHER_SESSION]]] as [string, string][][]),
        serviceStops: r.pick([[], [], [OTHER_SERVICE], [SERVICE]]),
      };
  return {
    env: { killSwitchFailClosed: r.pick(ENV_VALUES) },
    door: r.pick(["passport", "directKey"] as const),
    keySuspended: r.chance(0.08),
    killRead,
    suspendRead: r.pick(["no", "no", "no", "no", "no", "no", "agent", "session"] as const),
    sessionId: r.chance(0.5) ? SESSION : null,
    rateLimitOk: r.chance(0.95),
    neverListed: r.chance(0.08),
    ruleSet: r.pick(["read", "read", "read", "read", "ask", "ask", "other", "none", "malformed", "unreadable"] as const),
    cap: r.pick(["ok", "ok", "ok", "ok", "ok", "ok", "exhausted", "unreadable"] as const),
    awaited: r.pick(["approved", "approved", "pending", "denied", "full", "unavailable"] as const),
    decrypt: r.pick(["token", "token", "token", "token", "token", "noToken", "failed"] as const),
  };
}

const savedEnv = process.env.KILL_SWITCH_FAIL_CLOSED;
beforeEach(resetHarness);
afterEach(() => {
  if (savedEnv === undefined) delete process.env.KILL_SWITCH_FAIL_CLOSED;
  else process.env.KILL_SWITCH_FAIL_CLOSED = savedEnv;
});

const SCENARIOS = 600;
const loadedWith = (base: Partial<RedisKill>, services: string[] = []): SvcKillRead => ({
  kind: "loaded",
  r: { base: { platform: false, tenant: false, denylist: [], ...base }, services },
});

describe("service proxy: a refused call never reaches the tenant's token", () => {
  it(`holds for ${SCENARIOS} seeded states, with the proved model as the oracle`, async () => {
    const seen = new Map<string, number>();
    for (let seed = 1; seed <= SCENARIOS; seed++) {
      const s = randomScenario(seed);
      const model = await check(s, `seed ${seed}`);
      const what = `${s.door}:${model.refusedBy ?? "sent"}`;
      seen.set(what, (seen.get(what) ?? 0) + 1);
    }
    // Not vacuous: every armed check refused on BOTH doors, and both doors were admitted.
    const armed: (Check | "sent")[] = [
      "revocation", "rateLimit", "catalog", "rulesUnreadable", "rulesMalformed", "rulesNotAllowed",
      "capUnreadable", "capExhausted", "approval", "credentialUnavailable", "noToken",
      "sent",
    ];
    for (const door of ["passport", "directKey"] as const) {
      for (const what of armed) expect(seen.get(`${door}:${what}`) ?? 0, `never seen: ${door}:${what}`).toBeGreaterThan(0);
    }
  }, 120_000);

  // Each stop armed alone, everything else clear, on each door.
  const SINGLE: [string, Partial<Scenario>, Check | null][] = [
    ["nothing armed", {}, null],
    ["platform kill", { killRead: loadedWith({ platform: true }) }, "revocation"],
    ["tenant kill", { killRead: loadedWith({ tenant: true }) }, "revocation"],
    ["denylist names the agent", { killRead: loadedWith({ denylist: [AGENT] }) }, "revocation"],
    ["denylist names another agent", { killRead: loadedWith({ denylist: [OTHER_AGENT] }) }, null],
    ["per-service kill on this service", { killRead: loadedWith({}, [SERVICE]) }, "revocation"],
    ["per-service kill on another service", { killRead: loadedWith({}, [OTHER_SERVICE]) }, null],
    ["per-service stop only in the record, reloaded",
      { killRead: { kind: "reloaded", r: { base: { platform: false, tenant: false, denylist: [] }, services: [] }, tenantStop: false, sessions: [], serviceStops: [SERVICE] } },
      "revocation"],
    ["agent suspended", { suspendRead: "agent" }, "revocation"],
    ["session stopped", { suspendRead: "session", sessionId: SESSION }, "revocation"],
    ["session stop reloaded from the record",
      { sessionId: SESSION, killRead: { kind: "reloaded", r: { base: { platform: false, tenant: false, denylist: [] }, services: [] }, tenantStop: false, sessions: [[AGENT, SESSION]], serviceStops: [] } },
      "revocation"],
    ["kill read throws, variable unset", { killRead: { kind: "redisFailed" } }, null],
    ["kill read throws, KILL_SWITCH_FAIL_CLOSED=false", { killRead: { kind: "redisFailed" }, env: { killSwitchFailClosed: "false" } }, null],
    ["kill read throws, KILL_SWITCH_FAIL_CLOSED=true", { killRead: { kind: "redisFailed" }, env: { killSwitchFailClosed: "true" } }, "revocation"],
    ["rules deny the call", { ruleSet: "other" }, "rulesNotAllowed"],
    ["no rules for the service", { ruleSet: "none" }, "rulesNotAllowed"],
    ["rules malformed", { ruleSet: "malformed" }, "rulesMalformed"],
    ["rules row unreadable, variable unset", { ruleSet: "unreadable" }, "rulesUnreadable"],
    ["rules row unreadable, KILL_SWITCH_FAIL_CLOSED=false", { ruleSet: "unreadable", env: { killSwitchFailClosed: "false" } }, "rulesUnreadable"],
    ["never-listed path", { neverListed: true }, "catalog"],
    ["hourly cap exhausted", { cap: "exhausted" }, "capExhausted"],
    ["hourly cap unreadable, variable unset", { cap: "unreadable" }, "capUnreadable"],
    ["hourly cap unreadable, KILL_SWITCH_FAIL_CLOSED=false", { cap: "unreadable", env: { killSwitchFailClosed: "false" } }, "capUnreadable"],
    ["Ask me first, approval pending", { ruleSet: "ask", awaited: "pending" }, "approval"],
    ["Ask me first, approved", { ruleSet: "ask", awaited: "approved" }, null],
    ["token read fails", { decrypt: "failed" }, "credentialUnavailable"],
    ["no token stored", { decrypt: "noToken" }, "noToken"],
  ];
  for (const door of ["passport", "directKey"] as const) {
    it.each(SINGLE)(`${door}: %s`, async (name, overrides, expected) => {
      const model = await check({ ...CLEAR, ...overrides, door }, `${door}: ${name}`);
      expect(model.refusedBy).toBe(expected);
    });
  }

  it("a Direct Agent Key whose agent is suspended is refused at step 2", async () => {
    const model = await check({ ...CLEAR, door: "directKey", keySuspended: true }, "suspended key");
    expect(model.refusedBy).toBe("revocation");
    // The same flag on the passport door is not read: a passport has no such field.
    expect(route(inputFor({ ...CLEAR, door: "passport", keySuspended: true })).refusedBy).toBeNull();
  });
});
