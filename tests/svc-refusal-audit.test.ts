// The service route: an agent's GitHub call through the same identity, kill
// switch and receipts as its LLM calls (plans/any-api-credentials.md, phase 1).
//
// Every refusal here is asserted to reach NEITHER the decrypt RPC NOR the
// network: the check order (verify → kill → scope → cap → key → inject →
// forward) is the product, and a refusal that decrypted the token first would
// still be a refusal with the key in memory for nothing.
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  agentsFilters: [] as [string, unknown][],
}));

// Idea 11: these tests are about other behaviour; the agent has no mission.
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
        eq: (column: string, value: unknown) => {
          if (table === "agents") h.agentsFilters.push([column, value]);
          return chain;
        },
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

import { DELETE, GET, HEAD, PATCH, POST, PUT } from "@/app/api/v1/svc/[service]/[...path]/route";
import { serviceRulesRevision, parseServiceRules } from "@/lib/services/rules";

const TOKEN = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB";
const VISA = "visa.token.value";
const AGENT = "11111111-1111-4111-8111-111111111111";
const TENANT = "22222222-2222-4222-8222-222222222222";
const ORIGIN = "https://gw.example";
const READ_RULES = {
  github: {
    allow: [
      { method: "GET", path: "/repos/acme/*/issues" },
      { method: "GET", path: "/user" },
    ],
    max_requests_per_hour: 50,
  },
};

/**
 * A request shaped the way Next hands it to the handler: the route's own params
 * re-appended to the search as ordinary parameters, the client's own `path` /
 * `service` already gone. A tidy URL would pass whether or not the route strips
 * them (CLAUDE.md, the `nxtP` trap).
 */
function request(
  method: string,
  clientPath: string,
  clientQuery = "",
  init: { headers?: Record<string, string>; body?: string } = {}
) {
  const segments = clientPath.replace(/^\//u, "").split("/");
  const injected = [`service=github`, ...segments.map((s) => `path=${s}`)].join("&");
  const query = [clientQuery, injected].filter(Boolean).join("&");
  const url = `${ORIGIN}/api/v1/svc/github${clientPath}?${query}`;
  const req = new Request(url, {
    method,
    headers: { authorization: `Bearer ${VISA}`, ...(init.headers ?? {}) },
    ...(init.body !== undefined ? { body: init.body } : {}),
  });
  const ctx = { params: Promise.resolve({ service: "github", path: segments }) };
  return { req, ctx };
}

async function call(method: string, clientPath: string, clientQuery = "", init = {}) {
  const { req, ctx } = request(method, clientPath, clientQuery, init);
  const handler = { GET, HEAD, POST, PUT, PATCH, DELETE }[method as "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE"];
  return handler(req, ctx);
}

const lastLog = () => h.writeLog.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined;
const lastReceipt = () => h.signReceipt.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined;
const upstreamCalls = () => h.fetch.mock.calls as [string, RequestInit][];
const keyReads = () => h.rpc.mock.calls.filter(([name]) => String(name).startsWith("get_provider_key"));

function expectNothingSent() {
  expect(keyReads()).toHaveLength(0);
  expect(h.fetch).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  h.agentsFilters.length = 0;
  delete process.env.POLICY_FAIL_CLOSED;
  vi.stubGlobal("fetch", h.fetch);
  h.verifyVisa.mockResolvedValue({
    agid: AGENT,
    uid: TENANT,
    sub: "passport-id",
    jti: "visa-jti",
    scope: [{ provider: "anthropic", models: ["claude-*"] }],
  });
  h.readKillState.mockResolvedValue({ platformKill: false, userKill: false, denylist: [] });
  h.isSuspended.mockResolvedValue(false);
  h.readPolicy.mockResolvedValue({
    policy: null,
    shadow: null,
    senderConstraintMode: "off",
    budget: { known: false },
    period: { known: false },
  });
  h.rateLimit.mockResolvedValue({ success: true, remaining: 10 });
  h.rateLimitFailClosed.mockResolvedValue({ success: true, remaining: 10 });
  h.rulesRead.mockResolvedValue({ data: { service_rules: READ_RULES }, error: null });
  h.rpc.mockResolvedValue({ data: TOKEN, error: null });
  h.signReceipt.mockReturnValue("signed.receipt.jws");
  h.writeLog.mockResolvedValue(undefined);
  h.fetch.mockResolvedValue(
    new Response(JSON.stringify([{ number: 1 }]), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    })
  );
});


describe("service refusal audit and admission order", () => {
  function expectAudit(res: Response, status: string, httpStatus: number) {
    expect(h.writeLog).toHaveBeenCalledTimes(1);
    expect(lastLog()).toMatchObject({ status, agentId: AGENT, userId: TENANT, callKind: "service", receipt: "signed.receipt.jws" });
    expect(h.signReceipt).toHaveBeenCalledTimes(1);
    expect(lastReceipt()).toMatchObject({ status, httpStatus, callClass: "svc" });
    expect(res.headers.get("x-passcontrol-receipt-id")).toBe(lastLog()?.id);
    expect(lastReceipt()?.receiptId).toBe(lastLog()?.id);
    expect(upstreamCalls()).toHaveLength(0);
  }

  it("refuses the gateway-wide rate limit before any key read or send, and writes no row", async () => {
    // Deliberately no row, as on the LLM route: a flood must not buy a write per call.
    h.rateLimit.mockResolvedValue({ success: false, remaining: 0 });
    const res = await call("GET", "/user");
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "rate_limited" });
    expect(res.headers.get("retry-after")).toBeTruthy();
    expectNothingSent();
    expect(h.writeLog).not.toHaveBeenCalled();
    expect(h.signReceipt).not.toHaveBeenCalled();
  });

});
