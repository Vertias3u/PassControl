// Proves that fresh stop checks guard every upstream send on the LLM and
// service routes, by comparing seeded traces with the dispatch model. This
// includes admission, key resolution, dispatch permission, approval waits and
// failover qualification, plus the existing 2 s authority-cache windows.
// Mission cases live in stop-checks-dispatch-mission.test.ts (private).
// This standalone Core test uses inert mission boundaries: ordinary credentials
// have no mission and the mission gate never reads a store.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@sentry/nextjs", () => ({ init: () => undefined, captureException: () => undefined, captureMessage: vi.fn() }));
const fallbacks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/lib/state/fallbacks", () => ({ readCurrentAgentFallbacks: (...args: unknown[]) => fallbacks.read(...args) }));

const h = vi.hoisted(() => ({
  verifyVisa: vi.fn(),
  db: vi.fn(),
  openHold: vi.fn(),
  settleHold: vi.fn(),
  permit: vi.fn(),
  getCachedKey: vi.fn(),
  killState: vi.fn(),
  isSuspended: vi.fn(),
  rateLimit: vi.fn(),
  fetch: vi.fn(),
  approvalCheck: vi.fn(),
  telegramPoll: vi.fn(),
  mget: vi.fn(),
  redisDown: () => false as boolean,
}));

// Match Core's mission stubs without importing private mission internals.
vi.mock("@/lib/mission/gate", () => ({
  resolveCallMission: async ({ principal }: { principal: { kind: string; mission?: unknown } }) =>
    principal.kind === "passport" && principal.mission
      ? { kind: "refuse", status: 403, code: "mission_invalid", message: "This gateway does not operate missions." }
      : { kind: "none" },
}));
vi.mock("@/lib/mission/store", () => ({
  readActiveMissionForAgent: async () => ({ kind: "none" }),
  readMissionById: async () => ({ kind: "none" }),
  missionInForce: () => false,
}));
vi.mock("@/lib/state/mission", () => ({
  claimMissionSubagent: async () => "missing",
  recordMissionDecision: async () => undefined,
}));
vi.mock("@/lib/state/approvals", async (original) => ({
  ...await original<typeof import("@/lib/state/approvals")>(),
  checkApproval: (...args: unknown[]) => h.approvalCheck(...args),
}));
vi.mock("@/lib/alerts/approvals", () => ({
  sendApprovalPrompt: async () => undefined,
  pollTelegramDecisions: (...args: unknown[]) => h.telegramPoll(...args),
}));
vi.mock("server-only", () => ({}));
vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));
vi.mock("@/lib/auth/visa", () => ({
  extractVisaToken: (headers: Headers) => headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "",
  verifyVisa: (...args: unknown[]) => h.verifyVisa(...args),
}));
// While Redis is readable the kill state is supplied by the test. While it is
// down, the REAL reader runs against a failing Redis, so the fail-open or
// fail-closed answer is the code's own and not something this file decided.
vi.mock("@/lib/state/killswitch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/state/killswitch")>();
  return {
    ...actual,
    readKillState: (...args: Parameters<typeof actual.readKillState>) =>
      h.redisDown() ? actual.readKillState(...args) : h.killState(...args),
  };
});
vi.mock("@/lib/state/redis", () => ({
  redis: () => ({ get: async () => null, smembers: async () => [], mget: (...keys: string[]) => h.mget(...keys) }),
  touchLastSeen: async () => undefined,
  getCachedEndpoint: async () => "|",
  purgeAgentPolicy: vi.fn(),
  readCredentialFence: vi.fn(async () => null),
  isSuspended: (...args: unknown[]) => h.isSuspended(...args),
  getCachedKey: (...args: unknown[]) => h.getCachedKey(...args),
  setCachedKey: async () => undefined,
  getCachedAgentPolicy: async () => JSON.stringify({ p: {}, s: null }),
  setCachedAgentPolicy: async () => undefined,
  readPolicyFence: async () => null,
}));
vi.mock("@/lib/state/holds", () => {
  const settle = async (outcome: string, p: Record<string, unknown>) => {
    h.settleHold({ ...p, outcome });
    return { applied: true, appliedTokens: Number(p.tokens ?? 0), appliedMicrocents: Number(p.microcents ?? 0) };
  };
  return {
    openHold: (...args: unknown[]) => h.openHold(...args),
    consumeDispatchPermission: (...args: unknown[]) => h.permit(...args),
    settleKnown: (p: Record<string, unknown>) => settle("complete", p),
    settleUnknown: (p: Record<string, unknown>) => settle("usage_unknown", p),
    releaseUndispatched: (p: Record<string, unknown>) => settle("not_dispatched", p),
    establishBudgetState: async () => undefined,
  };
});
vi.mock("@/lib/supabase", () => ({ serviceClient: () => h.db() }));
vi.mock("@/lib/crypto/aesgcm", () => ({ seal: async () => "sealed", open: async (v: string) => v }));
vi.mock("@/lib/log", () => ({ writeLog: async () => undefined, mirrorSpend: async () => undefined }));
vi.mock("@/lib/ratelimit", () => ({
  rateLimitFailClosed: (...args: unknown[]) => h.rateLimit(...args),
  rateLimit: (...args: unknown[]) => h.rateLimit(...args),
}));
vi.mock("@/lib/owner/current", () => ({ readCurrentOwner: async () => null }));
vi.mock("@/lib/receipt", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/receipt")>();
  return { ...actual, signReceipt: () => "header.payload.signature" };
});

import { POST } from "@/app/api/v1/[provider]/[...path]/route";
import { GET as serviceGET } from "@/app/api/v1/svc/[service]/[...path]/route";
import { DISPATCH_AUTHORITY_MAX_AGE_MS } from "@/lib/gateway/dispatch-stops";

// ═════════════════════════════════════════════════════════════════════════════
// THE MODEL: a port of proofs/stops/Stops/Dispatch.lean, same names, same order.
// ═════════════════════════════════════════════════════════════════════════════

type Stop =
  | "platform" | "tenant" | "denylist" | "service" | "session" | "suspend"
  | "delegation" | "directKey" | "expiry";
type Source = "kill" | "suspend" | "delegation" | "directKey";
type Phase = "admission" | "beforeKey" | "atSend" | "qualify";
type Req = { route: "llm" | "service"; door: "passport" | "directKey"; delegated: boolean; asks: boolean; fallbacks: number };
type Cfg = { killClosed: boolean; rereadsExpiry: boolean; maxAge: number };
type Event = { arm: Stop } | { elapse: number } | { break: Source };
type World = { now: number; armed: Set<Stop>; broken: Set<Source> };
type Tick = { events: Event[]; ok: boolean };
type Action =
  | { k: "read"; n: number; ph: Phase; t0: number; stops: Stop[] }
  | { k: "body" } | { k: "approval" } | { k: "respond" }
  | { k: "hold" | "key" | "permit" | "send" | "settle" | "release" | "settleZero" | "stopFailover"; n: number }
  | { k: "refuse"; n: number; ph: Phase };
type Pc =
  | { k: "enter"; n: number; ph: Phase }
  | { k: "check"; n: number; ph: Phase; t0: number; todo: Stop[] }
  | { k: "body" } | { k: "approval" } | { k: "respond" } | { k: "done" }
  | { k: "hold" | "key" | "permit" | "send" | "stopping"; n: number }
  | { k: "settle"; n: number; failover: boolean }
  | { k: "closing" | "refused"; n: number; ph: Phase };
type St = { pc: Pc; stamp: Map<Stop, number>; w: World; acts: Action[] };

const SOURCE: Record<Stop, Source | null> = {
  platform: "kill", tenant: "kill", denylist: "kill", service: "kill",
  session: "suspend", suspend: "suspend",
  delegation: "delegation", directKey: "directKey", expiry: null,
};

/** `code` in the Lean model: expiry is compared on every re-check (commit 944adc4
 *  closed gap B5-05). `false` is the code before that commit. */
const RECHECK_READS_EXPIRY = true;
const code = (killClosed: boolean): Cfg => ({ killClosed, rereadsExpiry: RECHECK_READS_EXPIRY, maxAge: 2000 });

function applies(r: Req, s: Stop): boolean {
  if (s === "service") return r.route === "service";
  if (s === "delegation") return r.route === "llm" && r.door === "passport" && r.delegated;
  if (s === "directKey") return r.door === "directKey";
  if (s === "expiry") return r.door === "passport";
  return true;
}

/** `refusesOn`: the failure posture of each stop is this function and nothing else. */
function refusesOn(cfg: Cfg, w: World, s: Stop): boolean {
  const src = SOURCE[s];
  if (src === null) return w.armed.has(s);
  if (src === "kill" || src === "suspend") return w.broken.has(src) ? cfg.killClosed : w.armed.has(s);
  return w.broken.has(src) || w.armed.has(s);
}

const redisStops = (r: Req): Stop[] =>
  r.route === "service"
    ? ["platform", "tenant", "denylist", "service", "session", "suspend"]
    : ["platform", "tenant", "denylist", "session", "suspend"];
const authorityOrder: Stop[] = ["directKey", "expiry", "delegation"];

function isDue(cfg: Cfg, r: Req, stamp: Map<Stop, number>, force: boolean, t0: number, a: Stop): boolean {
  if (!applies(r, a)) return false;
  if (a === "expiry") return cfg.rereadsExpiry;
  return force || cfg.maxAge < Math.max(0, t0 - (stamp.get(a) ?? 0));
}

function due(cfg: Cfg, r: Req, stamp: Map<Stop, number>, n: number, ph: Phase, t0: number): Stop[] {
  if (ph === "admission") return authorityOrder.filter((a) => applies(r, a));
  if (ph === "beforeKey") return authorityOrder.filter((a) => isDue(cfg, r, stamp, n > 0, t0, a));
  if (ph === "atSend") return authorityOrder.filter((a) => isDue(cfg, r, stamp, false, t0, a));
  if (ph === "qualify") return authorityOrder.filter((a) => a === "expiry" && isDue(cfg, r, stamp, false, t0, a));
  return [];
}

function refusalPc(r: Req, n: number, ph: Phase): Pc {
  if (ph === "admission") return { k: "refused", n, ph };
  if (ph === "qualify") return { k: "stopping", n };
  return r.route === "llm" ? { k: "closing", n, ph } : { k: "refused", n, ph };
}

/** The test's one addition to the model: the visa's expiry is a moment on the
 *  clock, so the "expiry lands" event is derived from the time that has passed. */
function after(w: World, events: Event[], expiresAt: number | null): World {
  const out: World = { now: w.now, armed: new Set(w.armed), broken: new Set(w.broken) };
  for (const e of events) {
    if ("arm" in e) out.armed.add(e.arm);
    else if ("elapse" in e) out.now += e.elapse;
    else out.broken.add(e.break);
  }
  if (expiresAt !== null && out.now >= expiresAt) out.armed.add("expiry");
  return out;
}

function stepCheck(cfg: Cfg, r: Req, t: Tick, s: St, w: World, n: number, ph: Phase, t0: number, todo: Stop[]): St {
  const start = ph === "admission" ? w.now : t0;
  const push = (act: Action, pc: Pc, stamp = s.stamp): St => ({ pc, stamp, w, acts: [...s.acts, act] });
  if (todo.length > 0) {
    const [a, ...rest] = todo as [Stop, ...Stop[]];
    const read: Action = { k: "read", n, ph, t0: start, stops: [a] };
    if (refusesOn(cfg, w, a)) return push(read, refusalPc(r, n, ph));
    return push(read, { k: "check", n, ph, t0, todo: rest }, new Map(s.stamp).set(a, start));
  }
  const read: Action = { k: "read", n, ph, t0: start, stops: redisStops(r) };
  if (redisStops(r).some((x) => refusesOn(cfg, w, x))) return push(read, refusalPc(r, n, ph));
  if (ph === "admission") return push(read, { k: "body" });
  if (ph === "beforeKey") return push(read, { k: "key", n });
  if (ph === "atSend") return push(read, { k: "send", n });
  return push(read, t.ok ? { k: "hold", n } : { k: "respond" });
}

function step(cfg: Cfg, r: Req, t: Tick, s: St, expiresAt: number | null): St {
  const pc = s.pc;
  if (pc.k === "done") return s;
  const w = after(s.w, t.events, expiresAt);
  const push = (act: Action, next: Pc): St => ({ pc: next, stamp: s.stamp, w, acts: [...s.acts, act] });
  const afterWait: Pc = r.route === "llm" ? { k: "hold", n: 0 } : { k: "enter", n: 0, ph: "beforeKey" };
  switch (pc.k) {
    case "enter": return stepCheck(cfg, r, t, s, w, pc.n, pc.ph, w.now, due(cfg, r, s.stamp, pc.n, pc.ph, w.now));
    case "check": return stepCheck(cfg, r, t, s, w, pc.n, pc.ph, pc.t0, pc.todo);
    case "body": return push({ k: "body" }, r.asks ? { k: "approval" } : afterWait);
    case "approval": return push({ k: "approval" }, afterWait);
    // RE-CHECK ONE: after the hold, before the key. Every attempt.
    case "hold":
      // Signed expiry is also checked before delegated holds, before any hold
      // hook can advance time. This does not refresh authority read stamps.
      // The Lean model calls this refusal's phase `beforeHold`; it is labelled
      // `beforeKey` here. No hold is opened either way.
      if (cfg.rereadsExpiry && r.delegated && s.w.armed.has("expiry")) {
        return { ...s, pc: { k: "refused", n: pc.n, ph: "beforeKey" } };
      }
      return push({ k: "hold", n: pc.n }, { k: "enter", n: pc.n, ph: "beforeKey" });
    case "key": return push({ k: "key", n: pc.n }, r.route === "llm" ? { k: "permit", n: pc.n } : { k: "enter", n: pc.n, ph: "atSend" });
    // RE-CHECK TWO: after the dispatch permission, at the send. Every attempt.
    case "permit": return push({ k: "permit", n: pc.n }, { k: "enter", n: pc.n, ph: "atSend" });
    case "send":
      return push({ k: "send", n: pc.n }, r.route === "llm"
        ? { k: "settle", n: pc.n, failover: !t.ok && pc.n < r.fallbacks } : { k: "respond" });
    case "settle": return push({ k: "settle", n: pc.n }, pc.failover ? { k: "enter", n: pc.n + 1, ph: "qualify" } : { k: "respond" });
    case "closing": return push({ k: pc.ph === "atSend" ? "settleZero" : "release", n: pc.n }, { k: "refused", n: pc.n, ph: pc.ph });
    case "refused": return push({ k: "refuse", n: pc.n, ph: pc.ph }, { k: "done" });
    case "stopping": return push({ k: "stopFailover", n: pc.n }, { k: "respond" });
    case "respond": return push({ k: "respond" }, { k: "done" });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// THE SCENARIO: what the environment does, by where the request is.
// ═════════════════════════════════════════════════════════════════════════════

type Principal = "plain" | "worker" | "directKey";
/** Where something can land. `pre` is before the request arrives. */
type Point = "pre" | "body" | "approval" | `hold${number}` | `key${number}` | `permit${number}` | `send${number}`;
/** `redis` going down takes the kill switch and the delegation reader with it:
 *  both read the same Redis. */
type Break = "redis" | "directKey";
type Landing = { elapse: number; arm: Stop[]; brk: Break[] };
type Scenario = {
  route: "llm" | "service";
  principal: Principal;
  asks: boolean;
  /** One entry per attempt that could run: does the upstream ask for a failover? */
  fails: boolean[];
  killClosed: boolean;
  /** The visa (and its delegation link) expires this long after the start. */
  expiresAfterMs: number | null;
  at: Partial<Record<Point, Landing>>;
};

const reqOf = (s: Scenario): Req => ({
  route: s.route,
  door: s.principal === "directKey" ? "directKey" : "passport",
  delegated: s.principal === "worker",
  asks: s.asks,
  fallbacks: s.fails.length - 1,
});

function eventsOf(l: Landing | undefined): Event[] {
  if (!l) return [];
  const out: Event[] = [];
  if (l.elapse > 0) out.push({ elapse: l.elapse });
  for (const b of l.brk) {
    if (b === "redis") out.push({ break: "kill" }, { break: "delegation" });
    else out.push({ break: b });
  }
  for (const a of l.arm) out.push({ arm: a });
  return out;
}

function pointOf(pc: Pc): Point | null {
  if (pc.k === "enter" && pc.ph === "admission") return "pre";
  if (pc.k === "body" || pc.k === "approval") return pc.k;
  if (pc.k === "hold" || pc.k === "key" || pc.k === "permit" || pc.k === "send") return `${pc.k}${pc.n}`;
  return null;
}

const T0 = 1_800_000_000_000; // a whole second, so an expiry in seconds is exact

function runModel(s: Scenario) {
  const cfg = code(s.killClosed);
  const r = reqOf(s);
  const expiresAt = s.expiresAfterMs === null ? null : T0 + s.expiresAfterMs;
  let st: St = { pc: { k: "enter", n: 0, ph: "admission" }, stamp: new Map(), w: { now: T0, armed: new Set(), broken: new Set() }, acts: [] };
  // A window: an attempt went out although an authority stop was in force.
  const windows: string[] = [];
  for (let i = 0; i < 400 && st.pc.k !== "done"; i++) {
    const before = st.pc;
    const point = pointOf(before);
    const ok = before.k === "send" ? !s.fails[before.n] : true;
    st = step(cfg, r, { events: point ? eventsOf(s.at[point]) : [], ok }, st, expiresAt);
    if (before.k === "send") {
      for (const a of ["delegation", "directKey", "expiry"] as const) {
        if (applies(r, a) && st.w.armed.has(a)) windows.push(`${a}@${before.n === 0 ? "first" : "failover"}`);
      }
    }
  }
  if (st.pc.k !== "done") throw new Error("the model did not finish");
  const acts = st.acts;
  const count = (k: Action["k"]) => acts.filter((a) => a.k === k).length;
  const reads = (a: Stop) => acts.filter((x) => x.k === "read" && x.stops.length === 1 && x.stops[0] === a).length;
  const last = acts[acts.length - 1]!;
  const refusal = last.k === "refuse" ? last : null;
  return {
    acts, refusal, windows,
    sent: acts.flatMap((a) => (a.k === "send" ? [a.n] : [])),
    holds: count("hold"), keys: count("key"), releases: count("release"), zeros: count("settleZero"),
    stoppedFailover: count("stopFailover") > 0,
    admitted: !(refusal && refusal.ph === "admission"),
    reads: { delegation: reads("delegation"), directKey: reads("directKey") },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// THE ROUTE: the same scenario through the real handlers.
// ═════════════════════════════════════════════════════════════════════════════

const AGENT = "agent-id";
const USER = "user-id";
const DIRECT_KEY = "pc_agent_" + "A".repeat(43);
// Assembled at run time: these are not credentials, and must not look like one in the file.
const KEY = ["sk", "proj", "7Hx2Qa9Lm4Jv8Bc3Np6Wr0Ty5Dg1Fs"].join("-");
const SERVICE_TOKEN = ["ghp", "7Hx2Qa9Lm4Jv8Bc3Np6Wr0Ty5Dg1FsAa9Bb0C"].join("_");
const CHAT = { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] };
const CANDIDATES = [
  { provider: "groq", model: "openai/gpt-oss-20b" },
  { provider: "mistral", model: "mistral-large-latest" },
];
const SCOPES = [
  { provider: "openai", models: ["gpt-4o-mini"] },
  ...CANDIDATES.map((c) => ({ provider: c.provider, models: [c.model] })),
];
const LLM_HOSTS = ["api.openai.com", "api.groq.com", "api.mistral.ai"];
const OK = JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } });
const QUOTA = JSON.stringify({ error: { type: "insufficient_quota", code: "insufficient_quota" } });
const baseClaims = { sub: "passport-id", agid: AGENT, uid: USER, jti: "visa-jti-1", bt: null, bc: null, st: 0, sc: 0, ver: 1 };
const drain = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };

async function runRoute(s: Scenario) {
  vi.restoreAllMocks();
  for (const m of Object.values(h)) if (typeof m === "function" && "mockReset" in m) m.mockReset();
  fallbacks.read.mockReset();
  vi.stubEnv("KILL_SWITCH_FAIL_CLOSED", s.killClosed ? "true" : "false");
  vi.stubEnv("POLICY_FAIL_CLOSED", "true");

  const world = { now: T0, armed: new Set<Stop>(), broken: new Set<Break>() };
  const landed: Point[] = [];
  const land = (p: Point) => {
    landed.push(p);
    const l = s.at[p];
    if (!l) return;
    world.now += l.elapse;
    for (const a of l.arm) world.armed.add(a);
    for (const b of l.brk) world.broken.add(b);
  };
  vi.spyOn(Date, "now").mockImplementation(() => world.now);
  h.redisDown = () => world.broken.has("redis");

  const nowS = Math.floor(T0 / 1000);
  const exp = s.expiresAfterMs === null ? nowS + 600 : nowS + s.expiresAfterMs / 1000;
  const claims: Record<string, unknown> = { ...baseClaims, scope: SCOPES, exp };
  if (s.principal === "worker") {
    Object.assign(claims, {
      ver: 3,
      act: { sub: "W".repeat(43), dlg: "jti-0000000000000001", dep: 1, ch: "c".repeat(43) },
      dc: [{ dlg: "jti-0000000000000001", cap: 50_000_000, iat: nowS - 5, exp }],
    });
  }
  // The visa is verified against the clock, the way the real verifier does.
  h.verifyVisa.mockImplementation(async () => (world.now < exp * 1000 ? claims : null));

  let delegationReads = 0;
  h.mget.mockImplementation(async (...keys: string[]) => {
    if (keys.some((k) => k.startsWith("dlrev:"))) delegationReads++;
    if (world.broken.has("redis")) throw new Error("redis unavailable");
    return keys.map((k) => (k.startsWith("dlrev:") && world.armed.has("delegation") ? "1" : k.startsWith("killswitch:loaded:") ? "1" : null));
  });
  h.killState.mockImplementation(async (_user: string, opts?: { service?: string }) => ({
    platformKill: world.armed.has("platform"),
    userKill: world.armed.has("tenant"),
    denylist: world.armed.has("denylist") ? [AGENT] : [],
    ...(opts?.service ? { serviceKill: world.armed.has("service") } : {}),
  }));
  h.isSuspended.mockImplementation(async () => (world.armed.has("suspend") ? true : world.armed.has("session") ? "session" : false));

  let dakReads = 0;
  let serviceKeyReads = 0;
  const ask = s.route === "service" && s.asks;
  const rpc = vi.fn(async (name: string) => {
    if (name === "authenticate_direct_agent_key") {
      dakReads++;
      if (world.broken.has("directKey")) throw new Error("database unavailable");
      return { data: world.armed.has("directKey") ? [] : [{
        key_id: "key-id", agent_id: AGENT, user_id: USER, agent_status: "active",
        allowed_scopes: s.route === "service" ? [] : SCOPES, budget_tokens: null, budget_cents: null, spent_tokens: 0, spent_microcents: 0,
      }], error: null };
    }
    if (name !== "get_provider_key") return { data: null, error: null };
    if (s.route === "service") { land(`key${serviceKeyReads++}`); return { data: SERVICE_TOKEN, error: null }; }
    return { data: KEY, error: null };
  });
  h.db.mockReturnValue({
    rpc,
    from: (table: string) => {
      if (table === "tripwire_decoys") return { select: () => ({ in: async () => ({ data: [], error: null }) }) };
      const chain = {
        select: () => chain, eq: () => chain,
        maybeSingle: async () => ({ data: table === "agents" ? { service_rules: { github: { allow: [{ method: "GET", path: "/user", ...(ask ? { ask: true } : {}) }], max_requests_per_hour: 50 } } } : null, error: null }),
      };
      return chain;
    },
  });
  h.approvalCheck.mockResolvedValue({ state: "none" });
  if (ask) h.approvalCheck.mockResolvedValueOnce({ state: "pending", id: "question" }).mockResolvedValue({ state: "approved", id: "question" });
  h.telegramPoll.mockImplementation(async () => { land("approval"); return { state: "ok" }; });

  let holds = 0, keys = 0, permits = 0, sends = 0;
  h.openHold.mockImplementation(async () => { land(`hold${holds++}`); return { ok: true, reserved: 1 }; });
  h.getCachedKey.mockImplementation(async () => { land(`key${keys++}`); return null; });
  h.permit.mockImplementation(async () => { land(`permit${permits++}`); return { granted: true }; });
  h.fetch.mockImplementation(async () => {
    const n = sends++;
    land(`send${n}`);
    return new Response(s.fails[n] ? QUOTA : OK, { status: s.fails[n] ? 429 : 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", h.fetch);
  fallbacks.read.mockResolvedValue(CANDIDATES.slice(0, s.fails.length - 1));

  // The per-agent rate limit is the first thing after every admission read, so
  // its call marks "admitted": the upload is held open until then.
  let didAdmit = false;
  let admit!: () => void;
  const admitted = new Promise<void>((r) => { admit = r; });
  h.rateLimit.mockImplementation(async (key: string) => {
    if (key === `proxy:${AGENT}`) { didAdmit = true; admit(); }
    return { success: true, remaining: 1 };
  });

  const bearer = s.principal === "directKey" ? DIRECT_KEY : "visa";
  land("pre");
  let response: Response;
  if (s.route === "llm") {
    const body = new ReadableStream<Uint8Array>({ async start(controller) {
      await admitted;
      land("body");
      controller.enqueue(new TextEncoder().encode(JSON.stringify(CHAT))); controller.close();
    } });
    response = await POST(new Request("https://gateway.test/api/v1/openai/v1/chat/completions", {
      method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body, duplex: "half",
    } as RequestInit), { params: Promise.resolve({ provider: "openai", path: ["v1", "chat", "completions"] }) });
  } else {
    response = await serviceGET(new Request("https://gateway.test/api/v1/svc/github/user", { headers: { authorization: `Bearer ${bearer}` } }),
      { params: Promise.resolve({ service: "github", path: ["user"] }) });
  }
  admit();
  await response.text();
  await drain();

  // Observe refusal phase independently from the model: admission never reaches
  // the rate limit; at-send refusals have resolved the current attempt's key.
  const keyReads = s.route === "llm" ? h.getCachedKey.mock.calls.length : serviceKeyReads;
  const refusalPhase: Phase | null = [401, 403, 503].includes(response.status)
    ? !didAdmit ? "admission" : keyReads > sends ? "atSend" : "beforeKey"
    : null;
  const settles = h.settleHold.mock.calls.map((c) => (c[0] as { outcome: string; tokens?: number }));
  return {
    status: response.status,
    refusalPhase,
    hosts: h.fetch.mock.calls.map((c) => new URL(String(c[0])).host),
    holds: h.openHold.mock.calls.length,
    keys: s.route === "llm" ? h.getCachedKey.mock.calls.length : serviceKeyReads,
    releases: settles.filter((x) => x.outcome === "not_dispatched").length,
    settles: settles.length,
    reads: { delegation: delegationReads, directKey: dakReads },
    landed,
  };
}

/** Run one scenario through both and compare. `label` names the seed. */
async function check(s: Scenario, label: string) {
  const model = runModel(s);
  const route = await runRoute(s);
  const where = `${label}\nscenario ${JSON.stringify(s)}\nmodel ${JSON.stringify(model.acts)}\nroute ${JSON.stringify(route)}\n`;
  const hostOf = (n: number) => (s.route === "llm" ? LLM_HOSTS[n] : "api.github.com");

  // THE property: the route sends exactly the attempts the model says it may.
  expect(route.hosts, `SENDS differ. ${where}`).toEqual(model.sent.map(hostOf));
  // Theorem 4 and the order before the key: same holds, same keys, same releases.
  expect(route.keys, `KEYS resolved differ. ${where}`).toBe(model.keys);
  if (s.route === "llm") {
    expect(route.holds, `HOLDS opened differ. ${where}`).toBe(model.holds);
    expect(route.releases, `HOLDS released as not dispatched differ. ${where}`).toBe(model.releases);
    expect(route.settles, `a hold was left open or closed twice. ${where}`).toBe(model.holds);
  }
  // The 2 s rule: each authority is re-read exactly as often as the model says.
  if (model.admitted) expect(route.reads, `AUTHORITY re-reads differ. ${where}`).toEqual(model.reads);
  if (model.refusal) {
    expect([401, 403, 503], `a refusal must be a refusal. ${where}`).toContain(route.status);
    expect(route.refusalPhase, `REFUSAL phase differs. ${where}`).toBe(model.refusal.ph);
  }
  return { model, route };
}

// ── seeded scenarios ─────────────────────────────────────────────────────────

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
    int: (n: number) => Math.floor(next() * n),
  };
}

// Under 2 s, over 2 s, and nothing: both sides of DISPATCH_AUTHORITY_MAX_AGE_MS.
const ELAPSE = [0, 0, 0, 300, 1500, 2000, 2001, 5000] as const;

function randomScenario(seed: number): Scenario {
  const r = rng(seed);
  const route = r.chance(0.72) ? "llm" : "service";
  const principal: Principal = route === "llm" ? r.pick(["plain", "worker", "worker", "directKey"]) : r.pick(["plain", "directKey"]);
  const asks = route === "service" && r.chance(0.6);
  const fallbackCount = route === "llm" ? r.pick([0, 1, 1, 2]) : 0;
  const fails = Array.from({ length: fallbackCount + 1 }, () => r.chance(0.7));
  const points: Point[] = ["pre"];
  if (route === "llm") points.push("body");
  if (asks) points.push("approval");
  for (let n = 0; n <= fallbackCount; n++) {
    points.push(`key${n}`, `send${n}`);
    if (route === "llm") points.push(`hold${n}`, `permit${n}`);
  }
  // The stops this principal can be stopped by, and that the harness can arm.
  const stops: Stop[] = ["platform", "tenant", "denylist", "session", "suspend"];
  if (route === "service") stops.push("service");
  if (principal === "worker") stops.push("delegation", "delegation", "delegation");
  if (principal === "directKey") stops.push("directKey", "directKey", "directKey");
  const breaks: Break[] = ["redis"];
  if (principal === "directKey") breaks.push("directKey");

  const at: Scenario["at"] = {};
  const landings = r.pick([0, 1, 1, 1, 2, 2, 3]);
  for (let i = 0; i < landings; i++) {
    // Mid-request points are the interesting ones; `pre` is the old single-moment case.
    const point = r.chance(0.12) ? "pre" : r.pick(points.filter((p) => p !== "pre"));
    at[point] = {
      elapse: point === "pre" ? 0 : r.pick(ELAPSE),
      arm: r.chance(0.75) ? [r.pick(stops)] : [],
      brk: r.chance(0.1) ? [r.pick(breaks)] : [],
    };
  }
  const expiresAfterMs = principal !== "directKey" && r.chance(0.14) ? r.pick([1000, 2000, 5000]) : null;
  return { route, principal, asks, fails, killClosed: r.chance(0.5), expiresAfterMs, at };
}

const quiet = (over: Partial<Scenario> = {}): Scenario => ({
  route: "llm", principal: "plain", asks: false, fails: [false], killClosed: true, expiresAfterMs: null, at: {}, ...over,
});
const landing = (over: Partial<Landing>): Landing => ({ elapse: 0, arm: [], brk: [], ...over });

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const SCENARIOS = 700;

describe("Core fresh stop before every send: the routes against the proved model", () => {
  it("uses the model freshness bound", () => {
    expect(DISPATCH_AUTHORITY_MAX_AGE_MS).toBe(code(true).maxAge);
  });

  it(`holds for ${SCENARIOS} seeded traces, with the proved model as the oracle`, async () => {
    const seen = new Map<string, number>();
    const note = (k: string) => seen.set(k, (seen.get(k) ?? 0) + 1);
    for (let seed = 1; seed <= SCENARIOS; seed++) {
      const s = randomScenario(seed);
      const { model } = await check(s, `seed ${seed}`);
      note(`${s.route}:sent${model.sent.length}`);
      if (model.refusal) note(`${s.route}:refused:${model.refusal.ph}:${model.refusal.n === 0 ? "first" : "failover"}`);
      if (model.stoppedFailover) note("llm:failover-stopped");
      if (model.zeros > 0) note("llm:settled-zero");
      for (const w of model.windows) note(`window:${w}`);
      for (const a of ["delegation", "directKey"] as const) {
        if (model.admitted && model.reads[a] > 1) note(`reread:${a}`);
      }
    }
    // Not vacuous: every kind of outcome the model distinguishes was reached.
    const must = [
      "llm:sent0", "llm:sent1", "llm:sent2", "llm:sent3", "service:sent0", "service:sent1",
      "llm:refused:admission:first", "llm:refused:beforeKey:first", "llm:refused:atSend:first",
      "llm:refused:beforeKey:failover", "llm:refused:atSend:failover",
      "service:refused:admission:first", "service:refused:beforeKey:first", "service:refused:atSend:first",
      "llm:failover-stopped", "llm:settled-zero",
      "reread:delegation", "reread:directKey",
      "window:delegation@first", "window:delegation@failover",
    ];
    for (const k of must) expect(seen.get(k) ?? 0, `never seen: ${k}. Seen: ${JSON.stringify([...seen])}`).toBeGreaterThan(0);
  }, 240_000);

  // ── the Core escapes of audit B2, through the oracle ──────────────────────
  it("B2-01: a tenant stop during a slow upload is not sent", async () => {
    const { route } = await check(quiet({ at: { body: landing({ elapse: 30_000, arm: ["tenant"] }) } }), "B2-01");
    expect(route.hosts).toEqual([]);
    expect(route.keys).toBe(0);
  });
  it("B2-02: a service stop during the approval wait is not sent", async () => {
    const { route } = await check(quiet({ route: "service", asks: true, at: { approval: landing({ elapse: 60_000, arm: ["service"] }) } }), "B2-02");
    expect(route.hosts).toEqual([]);
    expect(route.keys).toBe(0);
  });
  for (const [name, principal, stop] of [
    ["B2-03: a delegation revoked", "worker", "delegation"],
    ["B2-05: a Direct Agent Key revoked", "directKey", "directKey"],
  ] as const) {
    it(`${name} as the primary fails stops the failover`, async () => {
      const { route } = await check(quiet({ principal, fails: [true, false], at: { send0: landing({ arm: [stop] }) } }), name);
      expect(route.hosts).toEqual(["api.openai.com"]);
      expect(route.releases).toBe(1);
    });
  }

  // ── the 2 s rule, both sides ──────────────────────────────────────────────
  for (const [principal, stop] of [["worker", "delegation"], ["directKey", "directKey"]] as const) {
    it(`2 s rule, ${stop}: 2000 ms after admission is not re-read, 2001 ms is`, async () => {
      const within = await check(quiet({ principal, at: { body: landing({ elapse: 2000, arm: [stop] }) } }), `${stop} within`);
      expect(within.route.hosts).toEqual(["api.openai.com"]);
      expect(within.route.reads[stop]).toBe(1);
      const past = await check(quiet({ principal, at: { body: landing({ elapse: 2001, arm: [stop] }) } }), `${stop} past`);
      expect(past.route.hosts).toEqual([]);
      expect(past.route.reads[stop]).toBe(2);
    });
  }

  // ── OPEN: these pin what the code does today. Each has a Lean twin. ───────
  //
  // Lean: failover_window_is_open_between_its_read_and_its_send. The failover's
  // forced read passes, the stop lands while its key is resolved, and the check
  // at the send does not force the authority reads. The failover goes out.
  for (const [principal, stop] of [["worker", "delegation"], ["directKey", "directKey"]] as const) {
    it(`OPEN WINDOW, failover: ${stop} stopped while the failover's key resolves is still sent`, async () => {
      const { route } = await check(quiet({ principal, fails: [true, false], at: { key1: landing({ arm: [stop] }) } }), `failover window ${stop}`);
      expect(route.hosts).toEqual(["api.openai.com", "api.groq.com"]);
    });
    it(`failover: the same ${stop} stop is caught when resolving the key took over 2 s`, async () => {
      const { route } = await check(quiet({ principal, fails: [true, false], at: { key1: landing({ elapse: 2001, arm: [stop] }) } }), `slow failover ${stop}`);
      expect(route.hosts).toEqual(["api.openai.com"]);
    });
  }
  it("a Redis stop has no such window: armed during the failover's dispatch permission, not sent", async () => {
    const { route } = await check(quiet({ principal: "worker", fails: [true, false], at: { permit1: landing({ arm: ["tenant"] }) } }), "redis failover");
    expect(route.hosts).toEqual(["api.openai.com"]);
  });
  it("B5-05: expiry 500 ms after admission refuses a fast first attempt without database reads", async () => {
    const { route } = await check(quiet({ principal: "plain", expiresAfterMs: 1000, at: { pre: landing({ elapse: 500 }), body: landing({ elapse: 500 }) } }), "fast expiry");
    expect(route.status).toBe(401);
    expect(route.hosts).toEqual([]);
    expect(route.reads).toEqual({ delegation: 0, directKey: 0 });
  });
  // Lean: B5_05_expiry_during_upload_ordinary_visa_releases_its_hold, and
  // expiry_shortly_after_admission_is_refused for the test above.
  it("B5-05: a visa that expires during a slow upload is refused and its hold released", async () => {
    const { route } = await check(quiet({ principal: "plain", expiresAfterMs: 1000, at: { body: landing({ elapse: 3000 }) } }), "B5-05");
    expect(route.hosts).toEqual([]);
    expect(route.status).toBe(401);
    expect(route.holds).toBe(1);
    expect(route.releases).toBe(1);
    expect(route.settles).toBe(1); // The harness counts release among hold closures.
  });

  // ── posture ───────────────────────────────────────────────────────────────
  for (const killClosed of [false, true]) {
    it(`Redis down with a tenant stop armed, at the dispatch permission (fail-closed=${killClosed})`, async () => {
      const { route } = await check(quiet({ killClosed, at: { permit0: landing({ arm: ["tenant"], brk: ["redis"] }) } }), `posture ${killClosed}`);
      expect(route.hosts).toEqual(killClosed ? [] : ["api.openai.com"]);
    });
    it(`an unreadable Direct Agent Key after a slow upload is never sent (fail-closed=${killClosed})`, async () => {
      const { route } = await check(quiet({ principal: "directKey", killClosed, at: { body: landing({ elapse: 5000, brk: ["directKey"] }) } }), `dak ${killClosed}`);
      expect(route.hosts).toEqual([]);
    });
  }
});
