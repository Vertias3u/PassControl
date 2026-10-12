// POST /api/v1/tool-approvals with the REAL approval gate: the sidecar asks again
// every few seconds while the owner has not answered, and every retry must find the
// open question by its fingerprint, not open another. One question, one prompt: the
// owner is not sent a Telegram message per retry.
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  verifyVisa: vi.fn(),
  authenticateDirectAgentKey: vi.fn(),
  readKillState: vi.fn(),
  isSuspended: vi.fn(),
  readPolicy: vi.fn(),
  agentRow: vi.fn(),
  agentsFilters: [] as [string, unknown][],
  writeLog: vi.fn(),
  signReceipt: vi.fn(),
  rateLimit: vi.fn(),
  rateLimitFailClosed: vi.fn(),
  questions: new Map<string, string>(),
  sendApprovalPrompt: vi.fn(),
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
vi.mock("@/lib/state/approvals", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/state/approvals")>()),
  // A store with one question per fingerprint, as the real one keeps.
  checkApproval: async (request: { fingerprint: string }, opts: { create: boolean }) => {
    const id = h.questions.get(request.fingerprint);
    if (id) return { state: "pending", id };
    if (!opts.create) return { state: "none" };
    const created = `apv_${h.questions.size + 1}`;
    h.questions.set(request.fingerprint, created);
    return { state: "created", id: created };
  },
}));
vi.mock("@/lib/alerts/approvals", () => ({
  sendApprovalPrompt: (...a: unknown[]) => h.sendApprovalPrompt(...a),
  pollTelegramDecisions: async () => ({ state: "none" }),
}));

import { POST } from "@/app/api/v1/tool-approvals/route";

const AGENT = "11111111-1111-4111-8111-111111111111";
const TENANT = "22222222-2222-4222-8222-222222222222";
const ask = (command: string) => ({ session: "sess-1", tool_name: "Bash", tool_input: { command }, cwd: "/repo" });
const post = (body: unknown) =>
  POST(
    new Request("https://gw.example/api/v1/tool-approvals", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer visa.token.value" },
      body: JSON.stringify(body),
    })
  );

beforeEach(() => {
  vi.clearAllMocks();
  h.questions.clear();
  process.env.APPROVAL_WAIT_MS = "0";
  h.verifyVisa.mockResolvedValue({ agid: AGENT, uid: TENANT, sub: "passport-id", jti: "visa-jti", scope: [], bt: 5_000, bc: 900 });
  h.readKillState.mockResolvedValue({ platformKill: false, userKill: false, denylist: [] });
  h.isSuspended.mockResolvedValue(false);
  h.readPolicy.mockResolvedValue({ policy: {}, shadow: {}, senderConstraintMode: "off", budget: { known: false }, period: { known: false } });
  h.agentRow.mockResolvedValue({ data: { tool_rules: { rules: [{ tool: "Bash", effect: "ask_owner" }] }, name: "x" }, error: null });
  h.rateLimit.mockResolvedValue({ success: true, remaining: 10 });
  h.rateLimitFailClosed.mockResolvedValue({ success: true, remaining: 10 });
  h.sendApprovalPrompt.mockResolvedValue({ sent: true, channel: "telegram" });
});

afterEach(() => {
  delete process.env.APPROVAL_WAIT_MS;
});

it("prompts the owner once however often the sidecar asks again, and anew for another command", async () => {
  for (let i = 0; i < 8; i += 1) expect(await (await post(ask("git push"))).json()).toEqual({ state: "pending" });
  expect(h.sendApprovalPrompt).toHaveBeenCalledTimes(1);
  await post(ask("git push --force"));
  expect(h.sendApprovalPrompt).toHaveBeenCalledTimes(2);
});
