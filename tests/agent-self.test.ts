// GET /api/v1/self: an agent reads its own limits (1.4.0 candidate 2). An agent that
// can see its budget can choose a cheaper model before it is refused, and a person
// can see it in Claude Code's status line all day.
//
// It is the AGENT plane, not the developer API the launch order holds back: it answers
// only about the credential's own agent, through the same door as a model call.
//   verify → sender proof (passport) → kill / suspend → its own rate limit → read
// and it writes nothing: no log row, no receipt, no hold. Reading your budget must
// never spend it, and polling it must never use up the rate limit model calls share.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  verifyVisa: vi.fn(),
  authenticateDirectAgentKey: vi.fn(),
  readKillState: vi.fn(),
  isSuspended: vi.fn(),
  readBudgetSnapshot: vi.fn(),
  readPolicy: vi.fn(),
  readPeriodCounted: vi.fn(),
  mirror: vi.fn(),
  writeLog: vi.fn(),
  signReceipt: vi.fn(),
  rateLimit: vi.fn(),
  rateLimitFailClosed: vi.fn(),
  captureSecurityEvent: vi.fn(),
  agentsFilters: [] as [string, unknown][],
  toolRules: vi.fn(),
  readRecentSpend: vi.fn(),
  readPauseLiftEnd: vi.fn(),
}));

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
  readBudgetSnapshot: (...a: unknown[]) => h.readBudgetSnapshot(...a),
  touchLastSeen: vi.fn(async () => undefined),
  claimNonce: vi.fn(async () => true),
  flagPassportSecretExposed: vi.fn(async () => undefined),
}));
vi.mock("@/lib/state/pause", () => ({
  readPauseLiftEnd: (...a: unknown[]) => h.readPauseLiftEnd(...a),
}));
vi.mock("@/lib/state/policy", () => ({
  readCurrentAgentPolicyAndShadow: (...a: unknown[]) => h.readPolicy(...a),
}));
vi.mock("@/lib/budget-view", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/budget-view")>()),
  readPeriodCounted: (...a: unknown[]) => h.readPeriodCounted(...a),
  readRecentSpend: (...a: unknown[]) => h.readRecentSpend(...a),
}));
vi.mock("@/lib/supabase", () => ({
  serviceClient: () => ({
    rpc: vi.fn(),
    from: (table: string) => {
      let columns = "";
      const chain = {
        select: (cols: string) => ((columns = cols), chain),
        eq: (column: string, value: unknown) => {
          if (table === "agents") h.agentsFilters.push([column, value]);
          return chain;
        },
        maybeSingle: () => (columns === "tool_rules" ? h.toolRules() : h.mirror(table)),
      };
      return chain;
    },
  }),
}));
vi.mock("@/lib/log", () => ({ writeLog: (...a: unknown[]) => h.writeLog(...a) }));
vi.mock("@/lib/receipt", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/receipt")>()),
  signReceipt: (...a: unknown[]) => h.signReceipt(...a),
}));
vi.mock("@/lib/ratelimit", () => ({
  rateLimit: (...a: unknown[]) => h.rateLimit(...a),
  rateLimitFailClosed: (...a: unknown[]) => h.rateLimitFailClosed(...a),
}));
vi.mock("@/lib/observability", () => ({
  captureError: vi.fn(async () => undefined),
  captureSecurityEvent: (...a: unknown[]) => h.captureSecurityEvent(...a),
  logFailOpen: vi.fn(),
}));

// Injection guard Phase 2: the taint store.
const inj = vi.hoisted(() => ({
  readTaint: vi.fn(async (_agentId: string, _now: number): Promise<unknown> => null),
}));
vi.mock("@/lib/state/taint", () => ({ readTaint: (a: string, n: number) => inj.readTaint(a, n) }));

import { GET } from "@/app/api/v1/self/route";
import { generateDirectAgentKey } from "@/lib/auth/direct-key";
import { POLICY_UNREADABLE } from "@/lib/gate";

const AGENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";
const TENANT = "22222222-2222-4222-8222-222222222222";
const SCOPE = [{ provider: "anthropic", models: ["claude-*"] }];

const get = (headers: Record<string, string> = { authorization: "Bearer visa.token.value" }, query = "") =>
  GET(new Request(`https://gw.example/api/v1/self${query}`, { headers }));

beforeEach(() => {
  vi.clearAllMocks();
  h.agentsFilters.length = 0;
  h.verifyVisa.mockResolvedValue({ agid: AGENT, uid: TENANT, sub: "passport-id", jti: "visa-jti", scope: SCOPE, bt: 5_000, bc: 900 });
  h.readKillState.mockResolvedValue({ platformKill: false, userKill: false, denylist: [] });
  h.isSuspended.mockResolvedValue(false);
  h.readBudgetSnapshot.mockResolvedValue({ reservedTokens: 10, spentTokens: 90, reservedMicrocents: 1_000, spentMicrocents: 9_000 });
  h.readPolicy.mockResolvedValue({
    policy: { deny: [{ provider: "openai", models: ["*"] }] },
    shadow: { deny: [] },
    senderConstraintMode: "off",
    budget: { known: true, tokens: 1_000, cents: 2 },
    period: { known: true, kind: "day", cents: 200 },
  });
  h.readPeriodCounted.mockResolvedValue(42_000_000);
  h.mirror.mockResolvedValue({ data: { spent_tokens: 70, spent_microcents: 7_000 }, error: null });
  h.rateLimit.mockResolvedValue({ success: true, remaining: 10 });
  h.rateLimitFailClosed.mockResolvedValue({ success: true, remaining: 10 });
  h.toolRules.mockResolvedValue({ data: { tool_rules: null }, error: null });
  h.readRecentSpend.mockResolvedValue({ tokens: 0, microcents: 0 });
  h.readPauseLiftEnd.mockResolvedValue(null);
});

describe("GET /api/v1/self", () => {
  it("answers with the agent's own scope and limits, and exactly these fields", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["agent_id", "as_of", "auth", "budget", "pace", "pause", "scope"]);
    expect(body).toMatchObject({
      agent_id: AGENT,
      auth: "passport",
      scope: SCOPE,
      budget: {
        tokens: { limit: 1_000, used: 100, remaining: 900 },
        cost: { limit_microcents: 2_000_000, used_microcents: 10_000, remaining_microcents: 1_990_000 },
        period: { kind: "day", limit_microcents: 200_000_000, used_microcents: 42_000_000, remaining_microcents: 158_000_000 },
      },
    });
  });

  it("never shows the policy, its shadow, fallbacks or key material", async () => {
    const text = await (await get()).text();
    for (const word of ["deny", "shadow", "fallback", "visa.token", "passport-id", TENANT]) {
      expect(text).not.toContain(word);
    }
  });

  it("uses the live limits, not the ones the visa was minted with (S3-04)", async () => {
    const body = await (await get()).json();
    expect(body.budget.tokens.limit).toBe(1_000); // visa says 5,000
  });

  it("falls back to the visa's limits when the live row cannot be read, as the gateway does", async () => {
    h.readPolicy.mockResolvedValue({ policy: null, shadow: null, senderConstraintMode: "off", budget: { known: false }, period: { known: false } });
    const body = await (await get()).json();
    expect(body.budget.tokens.limit).toBe(5_000);
    expect(body.budget.cost.limit_microcents).toBe(900_000_000);
    expect(body.budget.period).toEqual({ unknown: true });
  });

  it("an unreadable counter is unknown, not zero, and not an error", async () => {
    h.readBudgetSnapshot.mockRejectedValue(new Error("redis down"));
    h.mirror.mockResolvedValue({ data: null, error: { message: "down" } });
    h.readPeriodCounted.mockResolvedValue(null);
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.budget.tokens).toEqual({ limit: 1_000, used: null, remaining: null });
    expect(body.budget.period.used_microcents).toBeNull();
  });

  it("answers only about the credential's own agent, whatever the query says", async () => {
    const body = await (await get(undefined, `?agent_id=${OTHER}`)).json();
    expect(body.agent_id).toBe(AGENT);
    for (const [column, value] of h.agentsFilters) if (column === "id") expect(value).toBe(AGENT);
  });

  it("writes nothing: no log row, no receipt", async () => {
    await get();
    expect(h.writeLog).not.toHaveBeenCalled();
    expect(h.signReceipt).not.toHaveBeenCalled();
  });

  it("has its own rate limit, so polling it never uses up the agent's call allowance", async () => {
    await get();
    const keys = h.rateLimit.mock.calls.map(([key]) => String(key));
    expect(keys).toContain(`self:${AGENT}`);
    expect(keys.some((k) => k.startsWith("proxy:"))).toBe(false);
    h.rateLimit.mockResolvedValue({ success: false, remaining: 0 });
    expect((await get()).status).toBe(429);
  });
});

describe("the same door as a model call", () => {
  it("refuses without a credential", async () => {
    expect((await get({})).status).toBe(401);
  });

  it("refuses a visa the gateway does not accept", async () => {
    h.verifyVisa.mockResolvedValue(null); // verifyVisa answers null for any visa it rejects
    expect((await get()).status).toBe(401);
  });

  it("a suspended agent gets the proxy's opaque refusal, and nothing else", async () => {
    h.isSuspended.mockResolvedValue(true);
    const res = await get();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "blocked_suspended" });
    expect(h.readBudgetSnapshot).not.toHaveBeenCalled();
  });

  it("a killed tenant gets the same opaque refusal", async () => {
    h.readKillState.mockResolvedValue({ platformKill: false, userKill: true, denylist: [] });
    const res = await get();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "blocked_suspended" });
  });

  it("an agent that must prove possession is refused a bare visa here too", async () => {
    // Otherwise /self would be the one door where a stolen bearer visa still works.
    h.readPolicy.mockResolvedValue({ policy: null, shadow: null, senderConstraintMode: "required", budget: { known: false }, period: { known: false } });
    const res = await get();
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("missing_sender_proof");
  });

  it("a Direct Agent Key is named as one, and its suspension refuses", async () => {
    const key = generateDirectAgentKey();
    h.authenticateDirectAgentKey.mockResolvedValue({
      kind: "direct_key", keyId: "k1", agentId: AGENT, userId: TENANT, scopes: SCOPE,
      budgetTokens: null, budgetCents: null, spentTokens: 0, spentMicrocents: 0, suspended: false,
    });
    const body = await (await get({ "x-api-key": key })).json();
    expect(body.auth).toBe("direct_key");
    h.authenticateDirectAgentKey.mockResolvedValue({
      kind: "direct_key", keyId: "k1", agentId: AGENT, userId: TENANT, scopes: SCOPE,
      budgetTokens: null, budgetCents: null, spentTokens: 0, spentMicrocents: 0, suspended: true,
    });
    expect((await get({ "x-api-key": key })).status).toBe(403);
  });

  // F3 (2026-10-10): `/passcontrol` in Claude Code asks /self whether calls are
  // being refused. A session its owner stopped is refused at the proxy but used to
  // read as healthy here, so the plugin would have shown a normal budget while every
  // call failed. The caller names its session the way Claude Code does on every call.
  describe("a stopped session", () => {
    const session = "4345f899-3d2f-4f58-a021-2765be8b85c2";
    const asSession = { authorization: "Bearer visa.token.value", "x-claude-code-session-id": session };

    it("is refused with the proxy's own session message, for that session only", async () => {
      h.isSuspended.mockImplementation(async (_agent: string, s?: string | null) => (s === session ? "session" : false));
      const res = await get(asSession);
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe("blocked_suspended");
      expect(body.message).toContain(`stopped this session (${session})`);
      expect(h.isSuspended).toHaveBeenCalledWith(AGENT, session);
      expect(h.readBudgetSnapshot).not.toHaveBeenCalled();
      // The same agent without that session reads its budget as before.
      expect((await get()).status).toBe(200);
    });

    it("is refused the first time after Redis lost it, from the durable record (0083)", async () => {
      h.readKillState.mockResolvedValue({
        platformKill: false, userKill: false, denylist: [],
        recordedSessionStops: [{ agentId: AGENT, sessionId: session }],
      });
      const res = await get(asSession);
      expect(res.status).toBe(403);
      expect((await res.json()).message).toContain("stopped this session");
    });

    it("stays opaque when the whole agent is suspended or the tenant killed", async () => {
      h.isSuspended.mockResolvedValue(true);
      expect(await (await get(asSession)).json()).toEqual({ error: "blocked_suspended" });
      h.isSuspended.mockResolvedValue("session");
      h.readKillState.mockResolvedValue({ platformKill: false, userKill: true, denylist: [] });
      expect(await (await get(asSession)).json()).toEqual({ error: "blocked_suspended" });
    });
  });
});

// Subscription mode, Phase 2: the sidecar decides PreToolUse from the agent's tool
// rules (0085), and reads them on the agent-wide /self ask it already makes, so no
// session costs an extra call. Opt-in: the status line, `watch` and the panel poll
// /self too and never need them. The governed agent can read its own TOOL rules (they
// are guard rails); never the policy or the service rules.
describe("tool rules on request", () => {
  const RULES = { rules: [{ tool: "Bash", command: "git push*", effect: "ask_owner" }], approval_wait_s: 90 };
  const withRules = () => get(undefined, "?include=tool_rules");

  it("are absent unless asked for, and not read", async () => {
    const body = await (await get()).json();
    expect(body).not.toHaveProperty("tool_rules");
    expect(h.toolRules).not.toHaveBeenCalled();
  });

  it("are the stored document when it is valid", async () => {
    h.toolRules.mockResolvedValue({ data: { tool_rules: RULES }, error: null });
    const body = await (await withRules()).json();
    expect(body.tool_rules).toEqual({ state: "ok", document: RULES });
    expect(h.agentsFilters).toEqual(expect.arrayContaining([["id", AGENT], ["user_id", TENANT]]));
  });

  it("say none when the agent has none, or the database predates 0085", async () => {
    expect((await (await withRules()).json()).tool_rules).toEqual({ state: "none" });
    h.toolRules.mockResolvedValue({ data: null, error: { code: "42703" } });
    expect((await (await withRules()).json()).tool_rules).toEqual({ state: "none" });
  });

  it("say invalid, never the document, when this build cannot read them", async () => {
    h.toolRules.mockResolvedValue({ data: { tool_rules: { rules: [{ tool: "Bash", effect: "allow" }] } }, error: null });
    const body = await (await withRules()).json();
    expect(body.tool_rules).toEqual({ state: "invalid" });
  });

  it("say unknown when they cannot be read, and the rest of the answer stands", async () => {
    h.toolRules.mockResolvedValue({ data: null, error: { code: "57014" } });
    const res = await withRules();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tool_rules).toEqual({ state: "unknown" });
    expect(body.budget).toBeTruthy();
    h.toolRules.mockRejectedValue(new Error("network"));
    expect((await (await withRules()).json()).tool_rules).toEqual({ state: "unknown" });
  });

  it("still never show the policy or the service rules", async () => {
    h.toolRules.mockResolvedValue({ data: { tool_rules: RULES }, error: null });
    const text = await (await withRules()).text();
    for (const word of ["openai", "shadow", "service_rules", "visa.token", TENANT]) expect(text).not.toContain(word);
  });
});

// 1.6.0: when the agent reaches its budget at its current rate, computed here once so
// the note, the status line and the alerts quote the same time (lib/budget-pace.ts).
describe("pace", () => {
  afterEach(() => vi.useRealTimers());

  it("projects the daily limit from this period's count", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 9, 22, 12)); // half the day gone
    h.readPeriodCounted.mockResolvedValue(150_000_000); // $1.50 of $2: 4 hours to go
    h.readPolicy.mockResolvedValue({
      policy: null, shadow: null, senderConstraintMode: "off",
      budget: { known: true, tokens: null, cents: null },
      period: { known: true, kind: "day", cents: 200 },
    });
    const body = await (await get()).json();
    expect(body.pace).toEqual({
      reaches_limit_at: new Date(Date.UTC(2026, 9, 22, 16)).toISOString(),
      limit: "period",
      basis: "this_period",
    });
  });

  it("reads the last day's spend only when there is a limit with no period", async () => {
    h.readPolicy.mockResolvedValue({
      policy: null, shadow: null, senderConstraintMode: "off",
      budget: { known: true, tokens: null, cents: null },
      period: { known: true, kind: "day", cents: 200 },
    });
    await get();
    expect(h.readRecentSpend).not.toHaveBeenCalled();
    h.readPolicy.mockResolvedValue({
      policy: null, shadow: null, senderConstraintMode: "off",
      budget: { known: true, tokens: null, cents: 500 },
      period: { known: true, kind: null, cents: null },
    });
    await get();
    expect(h.readRecentSpend).toHaveBeenCalledWith(AGENT, expect.any(Number));
  });

  it("an unreadable last day is no pace, and still not an error", async () => {
    h.readRecentSpend.mockResolvedValue(null);
    h.readPolicy.mockResolvedValue({
      policy: null, shadow: null, senderConstraintMode: "off",
      budget: { known: true, tokens: null, cents: 500 },
      period: { known: true, kind: null, cents: null },
    });
    const res = await get();
    expect(res.status).toBe(200);
    expect((await res.json()).pace).toBeNull();
  });
});

// The soft pause (1.6.0, L4c). Before this, /self could say "runs out at 16:00" while
// every call got a 402: the pause line was the one limit it did not show. It is read
// from the same counters the proxy pauses on, and a lift is read the way the proxy
// reads it: one that cannot be read leaves the agent paused.
describe("the soft pause", () => {
  // $0.42 of today's $2.00 is 21 %.
  const withPause = (pause: unknown) =>
    h.readPolicy.mockResolvedValue({
      policy: null, shadow: null, senderConstraintMode: "off",
      budget: { known: true, tokens: null, cents: null },
      period: { known: true, kind: "day", cents: 200 },
      pause,
    });

  it("is null with no pause line, or a database that predates 0087, and no lift is read", async () => {
    withPause(undefined);
    expect((await (await get()).json()).pause).toBeNull();
    withPause({ known: false });
    expect((await (await get()).json()).pause).toBeNull();
    withPause({ known: true, percent: null });
    expect((await (await get()).json()).pause).toBeNull();
    expect(h.readPauseLiftEnd).not.toHaveBeenCalled();
  });

  it("below the line, names the line and says it is not paused", async () => {
    withPause({ known: true, percent: 80 });
    expect((await (await get()).json()).pause).toEqual({ percent: 80, paused: false, limit: null, lifted_until: null });
    expect(h.readPauseLiftEnd).not.toHaveBeenCalled();
  });

  it("past the line, says the agent is paused and which limit put it there", async () => {
    withPause({ known: true, percent: 20 });
    expect((await (await get()).json()).pause).toEqual({ percent: 20, paused: true, limit: "period", lifted_until: null });
    expect(h.readPauseLiftEnd).toHaveBeenCalledWith(AGENT, expect.any(Number));
  });

  it("past the line with a lift, says until when the agent goes on", async () => {
    withPause({ known: true, percent: 20 });
    const end = Date.UTC(2026, 9, 22, 15, 40);
    h.readPauseLiftEnd.mockResolvedValue(end);
    expect((await (await get()).json()).pause).toEqual({
      percent: 20,
      paused: false,
      limit: "period",
      lifted_until: new Date(end).toISOString(),
    });
  });

  it("a lift that cannot be read leaves it paused, as on the proxy, and is not an error", async () => {
    withPause({ known: true, percent: 20 });
    h.readPauseLiftEnd.mockRejectedValue(new Error("redis down"));
    const res = await get();
    expect(res.status).toBe(200);
    expect((await res.json()).pause).toMatchObject({ paused: true, lifted_until: null });
  });

  it("a usage that cannot be read never pauses, whatever the database mirror says", async () => {
    withPause({ known: true, percent: 1 });
    h.readBudgetSnapshot.mockRejectedValue(new Error("redis down"));
    h.readPeriodCounted.mockResolvedValue(null);
    h.mirror.mockResolvedValue({ data: { spent_tokens: 999_999, spent_microcents: 999_999_999 }, error: null });
    h.readPolicy.mockResolvedValue({
      policy: null, shadow: null, senderConstraintMode: "off",
      budget: { known: true, tokens: 1_000, cents: 2 },
      period: { known: true, kind: "day", cents: 200 },
      pause: { known: true, percent: 1 },
    });
    expect((await (await get()).json()).pause).toEqual({ percent: 1, paused: false, limit: null, lifted_until: null });
  });
  // L7 (0088): an agent set to switch is not paused past its line: its calls to
  // that provider go on with the cheaper model, and /self says which.
  describe("with a cheaper model at the line", () => {
    const sw = { provider: "anthropic", model: "claude-haiku-4-5" };

    it("below the line, names the switch and says it is not on yet", async () => {
      withPause({ known: true, percent: 80, switchTo: sw });
      expect((await (await get()).json()).pause).toEqual({
        percent: 80, paused: false, limit: null, lifted_until: null,
        switch_to: { ...sw, active: false },
      });
    });

    it("past the line, says the calls go to the cheaper model, not that it is paused", async () => {
      withPause({ known: true, percent: 20, switchTo: sw });
      expect((await (await get()).json()).pause).toEqual({
        percent: 20, paused: false, limit: "period", lifted_until: null,
        switch_to: { ...sw, active: true },
      });
    });

    it("past the line with a lift, the agent is back on its usual model", async () => {
      withPause({ known: true, percent: 20, switchTo: sw });
      h.readPauseLiftEnd.mockResolvedValue(Date.UTC(2026, 9, 22, 15, 40));
      expect((await (await get()).json()).pause).toMatchObject({ paused: false, switch_to: { ...sw, active: false } });
    });

    // The gateway judges the cheaper model against the scope the call carries, and
    // refuses a switch that fails it. /self must not then say "on the cheaper model".
    it("a switch the agent's scope no longer allows is said as a pause, not as a switch", async () => {
      withPause({ known: true, percent: 20, switchTo: { provider: "openai", model: "gpt-5-mini" } });
      expect((await (await get()).json()).pause).toMatchObject({
        paused: true,
        switch_to: { provider: "openai", model: "gpt-5-mini", active: false },
      });
    });

    it("a switch that is not set adds nothing", async () => {
      withPause({ known: true, percent: 20, switchTo: null });
      expect((await (await get()).json()).pause).not.toHaveProperty("switch_to");
    });
  });
});

// Injection guard Phase 2 (owner, 2026-10-30): /self tells the agent it is tainted only
// in hold mode, where the hold is visible anyway. Monitor mode and off stay silent, so an
// agent cannot learn it is watched.
describe("GET /api/v1/self, the injection guard", () => {
  const T = Date.UTC(2026, 9, 30, 12, 0, 0);
  const withPolicy = (policy: unknown) =>
    h.readPolicy.mockResolvedValue({ policy, shadow: null, senderConstraintMode: "off", budget: { known: true, tokens: 1_000, cents: 2 }, period: { known: true, kind: null, cents: null } });

  beforeEach(() => {
    inj.readTaint.mockResolvedValue(null);
  });

  it("monitor mode: no injection field, and the taint is never read", async () => {
    withPolicy({ injection_guard: { mode: "monitor" } });
    const body = await (await get()).json();
    expect(body).not.toHaveProperty("injection");
    expect(JSON.stringify(body)).not.toMatch(/injection|taint|monitor/);
    expect(inj.readTaint).not.toHaveBeenCalled();
  });

  it("off: no injection field", async () => {
    withPolicy(null);
    expect(await (await get()).json()).not.toHaveProperty("injection");
    expect(inj.readTaint).not.toHaveBeenCalled();
  });

  it("hold, not tainted: says so", async () => {
    withPolicy({ injection_guard: { mode: "hold" } });
    const body = await (await get()).json();
    expect(body.injection).toEqual({ mode: "hold", readable: true, tainted_until: null });
    expect(inj.readTaint.mock.calls[0]![0]).toBe(AGENT);
  });

  it("hold, tainted: the end only, never what was found", async () => {
    withPolicy({ injection_guard: { mode: "hold" } });
    inj.readTaint.mockResolvedValue({ since: T, until: T + 30 * 60_000, families: ["instruction_override"], surface: "proxy" });
    const body = await (await get()).json();
    expect(body.injection).toEqual({ mode: "hold", readable: true, tainted_until: new Date(T + 30 * 60_000).toISOString() });
    expect(JSON.stringify(body)).not.toMatch(/instruction_override|proxy|since/);
  });

  it("hold, the taint unreadable: says it could not tell, and still answers", async () => {
    withPolicy({ injection_guard: { mode: "hold" } });
    inj.readTaint.mockRejectedValue(new Error("redis down"));
    const res = await get();
    expect(res.status).toBe(200);
    expect((await res.json()).injection).toEqual({ mode: "hold", readable: false, tainted_until: null });
  });

  it("an unreadable policy: no injection field (no guard is applied)", async () => {
    withPolicy(POLICY_UNREADABLE);
    expect(await (await get()).json()).not.toHaveProperty("injection");
  });
});
