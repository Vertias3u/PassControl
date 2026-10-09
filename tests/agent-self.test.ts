// GET /api/v1/self: an agent reads its own limits (1.4.0 candidate 2). An agent that
// can see its budget can choose a cheaper model before it is refused, and a person
// can see it in Claude Code's status line all day.
//
// It is the AGENT plane, not the developer API the launch order holds back: it answers
// only about the credential's own agent, through the same door as a model call.
//   verify → sender proof (passport) → kill / suspend → its own rate limit → read
// and it writes nothing: no log row, no receipt, no hold. Reading your budget must
// never spend it, and polling it must never use up the rate limit model calls share.
import { beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("@/lib/state/policy", () => ({
  readCurrentAgentPolicyAndShadow: (...a: unknown[]) => h.readPolicy(...a),
}));
vi.mock("@/lib/budget-view", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/budget-view")>()),
  readPeriodCounted: (...a: unknown[]) => h.readPeriodCounted(...a),
}));
vi.mock("@/lib/supabase", () => ({
  serviceClient: () => ({
    rpc: vi.fn(),
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: (column: string, value: unknown) => {
          if (table === "agents") h.agentsFilters.push([column, value]);
          return chain;
        },
        maybeSingle: () => h.mirror(table),
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

import { GET } from "@/app/api/v1/self/route";
import { generateDirectAgentKey } from "@/lib/auth/direct-key";

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
});

describe("GET /api/v1/self", () => {
  it("answers with the agent's own scope and limits, and exactly these fields", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["agent_id", "as_of", "auth", "budget", "scope"]);
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
});
