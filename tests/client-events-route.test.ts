// POST /api/v1/client-events: the sidecar uploads the model calls Claude Code
// REPORTED on a Pro/Max login (subscription mode, Phase 1b; migration 0084).
//
// The gateway never saw these calls, so what lands here is the client's word: it is
// stored in `client_reported_calls`, never in `agent_logs` (receipt-bearing proof),
// never signed, and its cost is API-equivalent, never charged to a budget.
//
// The agent plane, through the same door as /self:
//   verify → sender proof (passport) → kill / suspend → its own rate limit → write
// and the tenant and agent come from the credential only. What these tests hold:
//   * nothing in the body can name another agent or tenant;
//   * the body is bounded in bytes before it is parsed, and in events after;
//   * each event is held to the table's shape here first, dropped and counted when it
//     does not fit, so one bad event never loses the batch;
//   * a retry is a no-op (on conflict do nothing on agent + event key);
//   * a stopped agent gains no write path; uploads never spend the /self or proxy
//     allowance;
//   * a gateway whose database predates 0084 says so, and nothing else breaks.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  verifyVisa: vi.fn(),
  authenticateDirectAgentKey: vi.fn(),
  readKillState: vi.fn(),
  isSuspended: vi.fn(),
  readPolicy: vi.fn(),
  upsert: vi.fn(),
  tables: [] as string[],
  writeLog: vi.fn(),
  signReceipt: vi.fn(),
  rateLimit: vi.fn(),
  rateLimitFailClosed: vi.fn(),
  redisSet: vi.fn(),
  rpc: vi.fn(),
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
  touchLastSeen: vi.fn(async () => undefined),
  claimNonce: vi.fn(async () => true),
  flagPassportSecretExposed: vi.fn(async () => undefined),
  redis: () => ({ set: (...a: unknown[]) => h.redisSet(...a) }),
}));
vi.mock("@/lib/state/policy", () => ({
  readCurrentAgentPolicyAndShadow: (...a: unknown[]) => h.readPolicy(...a),
}));
vi.mock("@/lib/supabase", () => ({
  serviceClient: () => ({
    rpc: (...a: unknown[]) => h.rpc(...a),
    from: (table: string) => {
      h.tables.push(table);
      return { upsert: (...a: unknown[]) => h.upsert(...a) };
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
  captureSecurityEvent: vi.fn(async () => undefined),
  logFailOpen: vi.fn(),
}));

import { POST } from "@/app/api/v1/client-events/route";
import { generateDirectAgentKey } from "@/lib/auth/direct-key";

const AGENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";
const TENANT = "22222222-2222-4222-8222-222222222222";
const SCOPE = [{ provider: "anthropic", models: ["claude-*"] }];
const NOW = Date.now();

const call = (over: Record<string, unknown> = {}) => ({
  key: "evt_0123456789abcdef",
  kind: "model_call",
  session: "4f6c1d2e-0000-4000-8000-000000000001",
  agent: "general-purpose",
  model: "claude-haiku-5-5",
  at: NOW - 1_000,
  input_tokens: 120,
  output_tokens: 40,
  cache_read_tokens: 3_000,
  cache_creation_tokens: 0,
  cost_usd_micros: 1_830,
  duration_ms: 912,
  ...over,
});

const post = (body: unknown, headers: Record<string, string> = { authorization: "Bearer visa.token.value" }) =>
  POST(
    new Request("https://gw.example/api/v1/client-events", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    })
  );

const rowsWritten = () => (h.upsert.mock.calls.at(-1)?.[0] ?? []) as Record<string, unknown>[];

beforeEach(() => {
  vi.clearAllMocks();
  h.tables.length = 0;
  h.verifyVisa.mockResolvedValue({ agid: AGENT, uid: TENANT, sub: "passport-id", jti: "visa-jti", scope: SCOPE, bt: 5_000, bc: 900 });
  h.readKillState.mockResolvedValue({ platformKill: false, userKill: false, denylist: [] });
  h.isSuspended.mockResolvedValue(false);
  h.readPolicy.mockResolvedValue({
    policy: null,
    shadow: null,
    senderConstraintMode: "off",
    budget: { known: true, tokens: 1_000, cents: 2 },
    period: { known: true, kind: null, cents: null },
  });
  h.upsert.mockResolvedValue({ error: null });
  h.rateLimit.mockResolvedValue({ success: true, remaining: 10 });
  h.rateLimitFailClosed.mockResolvedValue({ success: true, remaining: 10 });
  h.redisSet.mockResolvedValue(null);
  h.rpc.mockResolvedValue({ data: 0, error: null });
});

describe("POST /api/v1/client-events", () => {
  it("stores a reported call in its own table, shaped, and says how many it took", async () => {
    const res = await post({ source: "claude_code_otel", events: [call()] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 1, rejected: 0 });
    expect(h.tables).toEqual(["client_reported_calls"]);
    expect(rowsWritten()).toEqual([
      {
        user_id: TENANT,
        agent_id: AGENT,
        event_key: "evt_0123456789abcdef",
        source: "claude_code_otel",
        kind: "model_call",
        auth_method: "passport",
        client_session: "4f6c1d2e-0000-4000-8000-000000000001",
        client_agent: "general-purpose",
        model: "claude-haiku-5-5",
        occurred_at: new Date(NOW - 1_000).toISOString(),
        input_tokens: 120,
        output_tokens: 40,
        cache_read_tokens: 3_000,
        cache_creation_tokens: 0,
        reported_cost_usd_micros: 1_830,
        duration_ms: 912,
        status_code: null,
        tool_name: null,
        decision: null,
        rule_index: null,
      },
    ]);
  });

  it("makes a retry a no-op: it inserts with on conflict do nothing on agent and event key", async () => {
    await post({ source: "claude_code_otel", events: [call()] });
    expect(h.upsert.mock.calls[0]![1]).toEqual({ onConflict: "agent_id,event_key", ignoreDuplicates: true });
  });

  it("writes nothing else: no log row, no receipt, nothing in agent_logs", async () => {
    await post({ source: "claude_code_otel", events: [call()] });
    expect(h.writeLog).not.toHaveBeenCalled();
    expect(h.signReceipt).not.toHaveBeenCalled();
    expect(h.tables).not.toContain("agent_logs");
  });

  it("takes the tenant and agent from the credential, whatever the body says", async () => {
    await post({
      source: "claude_code_otel",
      agent_id: OTHER,
      user_id: OTHER,
      events: [call({ agent_id: OTHER, user_id: OTHER, auth_method: "passport_signed" })],
    });
    expect(rowsWritten()).toHaveLength(1);
    expect(rowsWritten()[0]).toMatchObject({ user_id: TENANT, agent_id: AGENT, auth_method: "passport" });
    expect(JSON.stringify(rowsWritten())).not.toContain(OTHER);
  });

  it("names a Direct Agent Key upload as one, never as a passport", async () => {
    const key = generateDirectAgentKey();
    h.authenticateDirectAgentKey.mockResolvedValue({
      kind: "direct_key", keyId: "k1", agentId: AGENT, userId: TENANT, scopes: SCOPE,
      budgetTokens: null, budgetCents: null, spentTokens: 0, spentMicrocents: 0, suspended: false,
    });
    const res = await post({ source: "claude_code_otel", events: [call()] }, { "x-api-key": key });
    expect(res.status).toBe(200);
    expect(rowsWritten()[0]!.auth_method).toBe("direct_key");
  });

  it("stores a reported error with its status and no cost", async () => {
    await post({
      source: "claude_code_otel",
      events: [call({ kind: "model_error", status: 529, cost_usd_micros: 99, input_tokens: undefined })],
    });
    expect(rowsWritten()[0]).toMatchObject({ kind: "model_error", status_code: 529, reported_cost_usd_micros: null, input_tokens: null });
  });

  // Phase 2: what the tool rules decided at the PreToolUse hook. The tool and the
  // decision only: anything a model call carries is not read, whatever the event says.
  const toolDecision = (over: Record<string, unknown> = {}) => ({
    key: "evt_tool000000000001",
    kind: "tool_decision",
    session: "4f6c1d2e-0000-4000-8000-000000000001",
    at: NOW - 1_000,
    tool: "Bash",
    decision: "owner_approved",
    rule_index: 2,
    duration_ms: 41_000,
    ...over,
  });

  it("stores a tool decision with the tool, the decision, the rule and the wait, and nothing of a model call", async () => {
    const res = await post({
      source: "claude_code_otel",
      events: [toolDecision({ model: "claude-haiku-5-5", input_tokens: 5, cost_usd_micros: 9, status: 500, command: "git push" })],
    });
    expect(await res.json()).toEqual({ accepted: 1, rejected: 0 });
    expect(rowsWritten()[0]).toEqual({
      user_id: TENANT,
      agent_id: AGENT,
      event_key: "evt_tool000000000001",
      source: "claude_code_otel",
      kind: "tool_decision",
      auth_method: "passport",
      client_session: "4f6c1d2e-0000-4000-8000-000000000001",
      client_agent: null,
      model: null,
      occurred_at: new Date(NOW - 1_000).toISOString(),
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_creation_tokens: null,
      reported_cost_usd_micros: null,
      duration_ms: 41_000,
      status_code: null,
      tool_name: "Bash",
      decision: "owner_approved",
      rule_index: 2,
    });
  });

  it("drops a tool decision that does not fit", async () => {
    const bad = [
      toolDecision({ tool: undefined }),
      toolDecision({ tool: "rm -rf /" }),
      toolDecision({ decision: undefined }),
      toolDecision({ decision: "allow" }),
      toolDecision({ rule_index: 100 }),
      toolDecision({ rule_index: -1 }),
      toolDecision({ rule_index: 1.5 }),
    ];
    const res = await post({ source: "claude_code_otel", events: [...bad, toolDecision({ key: "evt_tool000000000009", rule_index: null })] });
    expect(await res.json()).toEqual({ accepted: 1, rejected: bad.length });
    expect(rowsWritten()[0]).toMatchObject({ event_key: "evt_tool000000000009", rule_index: null });
  });

  it("drops and counts each event that does not fit, and keeps the rest", async () => {
    const bad = [
      call({ key: "short" }),
      call({ key: "evt bad key with spaces!" }),
      call({ kind: "anything" }),
      call({ session: "bad session id" }),
      call({ agent: "agent\nX-Injected: 1" }),
      call({ model: "model with spaces" }),
      call({ input_tokens: -1 }),
      call({ output_tokens: 1.5 }),
      call({ cost_usd_micros: "1830" }),
      call({ duration_ms: 86_400_001 }),
      call({ kind: "model_error", status: 99 }),
      "not an object",
      null,
    ];
    const good = call({ key: "evt_ffffffffffffffff" });
    const res = await post({ source: "claude_code_otel", events: [...bad, good] });
    expect(await res.json()).toEqual({ accepted: 1, rejected: bad.length });
    expect(rowsWritten().map((r) => r.event_key)).toEqual(["evt_ffffffffffffffff"]);
  });

  it("keeps a call whose clock is implausible, without the time", async () => {
    await post({
      source: "claude_code_otel",
      events: [call({ at: NOW + 60 * 60 * 1000 }), call({ key: "evt_1111111111111111", at: 12 })],
    });
    expect(rowsWritten().map((r) => r.occurred_at)).toEqual([null, null]);
  });

  it("counts a key repeated inside one batch once", async () => {
    const res = await post({ source: "claude_code_otel", events: [call(), call()] });
    expect(await res.json()).toEqual({ accepted: 1, rejected: 1 });
    expect(rowsWritten()).toHaveLength(1);
  });

  it("refuses a source it does not know, or a body that is not a batch", async () => {
    for (const body of [
      { source: "someone_else", events: [call()] },
      { events: [call()] },
      { source: "claude_code_otel", events: "nope" },
      { source: "claude_code_otel" },
      "[]",
      "{not json",
    ]) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await res.json()).error).toBe("invalid_client_events");
    }
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("refuses more events than one batch may carry, before writing any", async () => {
    const events = Array.from({ length: 101 }, (_, i) => call({ key: `evt_${String(i).padStart(16, "0")}` }));
    const res = await post({ source: "claude_code_otel", events });
    expect(res.status).toBe(413);
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("refuses an oversized body before parsing it, by bytes, not characters", async () => {
    // Three bytes a character: under the cap by .length, over it on the wire.
    const padding = "語".repeat(25_000);
    const res = await post({ source: "claude_code_otel", events: [call({ model: padding })] });
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe("client_events_too_large");
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("an empty batch is fine, and writes nothing", async () => {
    const res = await post({ source: "claude_code_otel", events: [] });
    expect(await res.json()).toEqual({ accepted: 0, rejected: 0 });
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("has its own rate limit, so uploads never use up the /self or proxy allowance", async () => {
    await post({ source: "claude_code_otel", events: [call()] });
    const keys = h.rateLimit.mock.calls.map((c) => c[0]);
    expect(keys).toEqual([`events:${AGENT}`]);
    h.rateLimit.mockResolvedValue({ success: false, remaining: 0 });
    const res = await post({ source: "claude_code_otel", events: [call()] });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
  });

  it("refuses without a credential, or with one the gateway does not accept", async () => {
    expect((await post({ source: "claude_code_otel", events: [call()] }, {})).status).toBe(401);
    h.verifyVisa.mockResolvedValue(null); // verifyVisa answers null for any visa it rejects
    expect((await post({ source: "claude_code_otel", events: [call()] })).status).toBe(401);
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("gives a suspended agent or a killed tenant no write path, with the proxy's opaque refusal", async () => {
    h.isSuspended.mockResolvedValue(true);
    let res = await post({ source: "claude_code_otel", events: [call()] });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "blocked_suspended" });
    h.isSuspended.mockResolvedValue(false);
    h.readKillState.mockResolvedValue({ platformKill: false, userKill: true, denylist: [] });
    res = await post({ source: "claude_code_otel", events: [call()] });
    expect(await res.json()).toEqual({ error: "blocked_suspended" });
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("refuses a bare visa when the agent must prove possession", async () => {
    h.readPolicy.mockResolvedValue({ policy: null, shadow: null, senderConstraintMode: "required", budget: { known: false }, period: { known: false } });
    const res = await post({ source: "claude_code_otel", events: [call()] });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("missing_sender_proof");
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("says the records are not available on a database before 0084, and nothing else breaks", async () => {
    for (const error of [
      { code: "42P01", message: 'relation "public.client_reported_calls" does not exist' },
      { code: "PGRST205", message: "Could not find the table 'public.client_reported_calls' in the schema cache" },
    ]) {
      h.upsert.mockResolvedValue({ error });
      const res = await post({ source: "claude_code_otel", events: [call()] });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "client_events_unavailable" });
    }
  });

  it("answers a failed write with a code, never the database's own words", async () => {
    h.upsert.mockResolvedValue({ error: { code: "23514", message: "new row violates check constraint client_reported_calls_fields" } });
    const res = await post({ source: "claude_code_otel", events: [call()] });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "client_events_write_failed" });
    expect(text).not.toContain("constraint");
  });

  // Retention (owner, 2026-10-12): 90 days, aged out by 0084's prune function. The
  // route runs it at most once a day per agent, after an upload that stored rows.
  describe("90-day retention", () => {
    it("ages this agent's rows out at most once a day, after a stored upload", async () => {
      h.redisSet.mockResolvedValue("OK");
      await post({ source: "claude_code_otel", events: [call()] });
      expect(h.redisSet).toHaveBeenCalledWith(`retention:client_events:${AGENT}`, 1, { nx: true, ex: 86_400 });
      expect(h.rpc).toHaveBeenCalledWith("prune_client_reported_calls", { p_agent_id: AGENT, p_user_id: TENANT });
    });

    it("does not sweep again while today's claim stands", async () => {
      h.redisSet.mockResolvedValue(null);
      await post({ source: "claude_code_otel", events: [call()] });
      expect(h.rpc).not.toHaveBeenCalled();
    });

    it("does not sweep for an upload that stored nothing", async () => {
      h.redisSet.mockResolvedValue("OK");
      await post({ source: "claude_code_otel", events: [] });
      await post({ source: "claude_code_otel", events: [call({ key: "bad" })] });
      expect(h.redisSet).not.toHaveBeenCalled();
      expect(h.rpc).not.toHaveBeenCalled();
    });

    it("answers the upload the same when the sweep fails", async () => {
      h.redisSet.mockResolvedValue("OK");
      h.rpc.mockResolvedValue({ data: null, error: { code: "42883", message: "function does not exist" } });
      expect(await (await post({ source: "claude_code_otel", events: [call()] })).json()).toEqual({ accepted: 1, rejected: 0 });
      h.redisSet.mockRejectedValue(new Error("redis down"));
      const res = await post({ source: "claude_code_otel", events: [call()] });
      expect(res.status).toBe(200);
    });
  });
});
