// "Ask me first" at the gateway: a service call whose rule has `ask: true` is
// sent only after the owner approves exactly that request.
//
// The order is the product, as everywhere on this route: an unapproved call
// reaches NEITHER the decrypt RPC NOR the service. The approval is matched on
// what the gateway would forward (the forwarded query, not req.url with
// Next's injected params), the agent is never told the approval's id, and a
// pending call does not also send the generic "refused" alert.
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
  checkApproval: vi.fn(),
  sendApprovalPrompt: vi.fn(),
  pollTelegramDecisions: vi.fn(),
  notifyWorkspace: vi.fn(),
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
vi.mock("@/lib/state/approvals", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/state/approvals")>()),
  checkApproval: (...a: unknown[]) => h.checkApproval(...a),
}));
vi.mock("@/lib/alerts/approvals", () => ({
  sendApprovalPrompt: (...a: unknown[]) => h.sendApprovalPrompt(...a),
  pollTelegramDecisions: (...a: unknown[]) => h.pollTelegramDecisions(...a),
}));
vi.mock("@/lib/alerts/workspace", () => ({ notifyWorkspace: (...a: unknown[]) => h.notifyWorkspace(...a) }));

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


import { approvalFingerprint } from "@/lib/approvals/fingerprint";

const ASK_RULES = {
  github: {
    allow: [
      { method: "GET", path: "/user" },
      { method: "POST", path: "/repos/acme/web/issues", ask: true },
    ],
  },
};
const ISSUE = JSON.stringify({ title: "Release 1.2.0" });
const post = (query = "") =>
  call("POST", "/repos/acme/web/issues", query, {
    headers: { "content-type": "application/json" },
    body: ISSUE,
  });

function useAskRules() {
  h.rulesRead.mockResolvedValue({ data: { service_rules: ASK_RULES, name: "release-bot" }, error: null });
  h.sendApprovalPrompt.mockResolvedValue({ sent: true, channel: "telegram" });
  h.pollTelegramDecisions.mockResolvedValue({ state: "ok", decided: 0 });
  process.env.APPROVAL_WAIT_MS = "0";
}

describe("a call under an ask rule", () => {
  beforeEach(useAskRules);

  it("asks the owner once, answers 409 approval_pending, and decrypts and sends nothing", async () => {
    h.checkApproval.mockResolvedValue({ state: "created", id: "AbCdEfGhIjKlMnOpQrStUv" });
    const res = await post();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("approval_pending");
    expect(body.message).toMatch(/same request again/i);
    // The id is the owner's to use, never the agent's.
    expect(JSON.stringify(body)).not.toContain("AbCdEfGhIjKlMnOpQrStUv");
    expect(res.headers.get("retry-after")).toBeTruthy();
    expectNothingSent();

    expect(h.checkApproval).toHaveBeenCalledWith(
      expect.objectContaining({ userId: TENANT, agentId: AGENT, service: "github", method: "POST", preview: ISSUE }),
      { create: true }
    );
    expect(h.sendApprovalPrompt).toHaveBeenCalledTimes(1);
    expect(h.sendApprovalPrompt).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({
        id: "AbCdEfGhIjKlMnOpQrStUv",
        agentName: "release-bot",
        serviceLabel: "GitHub",
        method: "POST",
        path: "/repos/acme/web/issues",
        preview: ISSUE,
        dashboardUrl: `${ORIGIN}/dashboard/approvals`,
      })
    );
    expect(lastLog()).toMatchObject({ status: "blocked_policy" });
    expect(h.notifyWorkspace).not.toHaveBeenCalled();
  });

  it("does not ask again while the question is open", async () => {
    h.checkApproval.mockResolvedValue({ state: "pending", id: "AbCdEfGhIjKlMnOpQrStUv" });
    expect((await post()).status).toBe(409);
    expect(h.sendApprovalPrompt).not.toHaveBeenCalled();
    expectNothingSent();
  });

  it("sends an approved call, with exactly the approved body", async () => {
    h.checkApproval.mockResolvedValue({ state: "approved", id: "AbCdEfGhIjKlMnOpQrStUv" });
    h.fetch.mockResolvedValue(new Response(JSON.stringify({ number: 7 }), { status: 201 }));
    const res = await post();
    expect(res.status).toBe(201);
    expect(keyReads()).toHaveLength(1);
    const [, init] = upstreamCalls()[0]!;
    expect(init.body).toBe(ISSUE);
    expect(lastLog()).toMatchObject({ status: "ok" });
  });

  it("refuses a denied call with 403 approval_denied", async () => {
    h.checkApproval.mockResolvedValue({ state: "denied", id: "AbCdEfGhIjKlMnOpQrStUv" });
    const res = await post();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("approval_denied");
    expectNothingSent();
  });

  it("refuses with 429 when the workspace already has too many open questions", async () => {
    h.checkApproval.mockResolvedValue({ state: "full" });
    const res = await post();
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("approval_queue_full");
    expect(h.sendApprovalPrompt).not.toHaveBeenCalled();
    expectNothingSent();
  });

  it("fails closed when the approval store cannot answer", async () => {
    h.checkApproval.mockRejectedValue(new Error("redis down"));
    const res = await post();
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("approval_unavailable");
    expectNothingSent();
  });

  it("matches on the forwarded query, not on Next's injected route params", async () => {
    h.checkApproval.mockResolvedValue({ state: "pending", id: "AbCdEfGhIjKlMnOpQrStUv" });
    await post("labels=ship");
    const fingerprint = (h.checkApproval.mock.calls.at(-1)![0] as { fingerprint: string }).fingerprint;
    const expected = await approvalFingerprint({
      userId: TENANT,
      agentId: AGENT,
      service: "github",
      method: "POST",
      upstreamPath: "/repos/acme/web/issues",
      search: "?labels=ship",
      headers: new Headers({ "content-type": "application/json" }),
      body: ISSUE,
    });
    expect(fingerprint).toBe(expected);
    await post();
    expect((h.checkApproval.mock.calls.at(-1)![0] as { fingerprint: string }).fingerprint).not.toBe(expected);
  });

  it("waits for the owner within the call when it may, and sends once they approve", async () => {
    process.env.APPROVAL_WAIT_MS = "3000";
    h.checkApproval
      .mockResolvedValueOnce({ state: "created", id: "AbCdEfGhIjKlMnOpQrStUv" })
      .mockResolvedValueOnce({ state: "approved", id: "AbCdEfGhIjKlMnOpQrStUv" });
    h.fetch.mockResolvedValue(new Response("{}", { status: 201 }));
    const res = await post();
    expect(res.status).toBe(201);
    expect(h.pollTelegramDecisions).toHaveBeenCalledWith(TENANT, expect.any(Number));
    expect(h.checkApproval.mock.calls[1]![1]).toEqual({ create: false });
  });
});

describe("what decides that a call is held, and what the owner is shown", () => {
  beforeEach(useAskRules);

  it("holds a call that a broad rule listed first would admit unasked", async () => {
    h.rulesRead.mockResolvedValue({
      data: {
        service_rules: {
          github: {
            allow: [
              { method: "GET", path: "/repos/acme/web/**" },
              { method: "GET", path: "/repos/acme/web/issues", ask: true },
            ],
          },
        },
        name: "release-bot",
      },
      error: null,
    });
    h.checkApproval.mockResolvedValue({ state: "pending", id: "AbCdEfGhIjKlMnOpQrStUv" });
    expect((await call("GET", "/repos/acme/web/issues")).status).toBe(409);
    expectNothingSent();
  });

  it("shows the owner the whole body, so a payload cannot hide behind a long harmless start", async () => {
    h.checkApproval.mockResolvedValue({ state: "created", id: "AbCdEfGhIjKlMnOpQrStUv" });
    const body = JSON.stringify({ title: "fix typo " + "x".repeat(2000), body: "@everyone DROP" });
    await call("POST", "/repos/acme/web/issues", "", { headers: { "content-type": "application/json" }, body });
    const asked = h.checkApproval.mock.calls.at(-1)![0] as { preview: string };
    expect(asked.preview).toContain("@everyone DROP");
    expect((h.sendApprovalPrompt.mock.calls.at(-1)![1] as { preview: string }).preview).toContain("@everyone DROP");
  });

  it("refuses to ask about a body too large to show in full", async () => {
    const body = JSON.stringify({ title: "y".repeat(20_000) });
    const res = await call("POST", "/repos/acme/web/issues", "", {
      headers: { "content-type": "application/json" },
      body,
    });
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe("approval_body_too_large");
    expect(h.checkApproval).not.toHaveBeenCalled();
    expectNothingSent();
  });
});

describe("a call no rule admits", () => {
  beforeEach(useAskRules);

  it("says where the owner grants it: the agent's own access panel", async () => {
    const res = await call("GET", "/orgs/acme");
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("service_call_not_allowed");
    expect(body.message).toContain(`${ORIGIN}/dashboard/agents/${AGENT}#agent-services`);
  });
});

describe("a call under a rule without ask", () => {
  beforeEach(useAskRules);

  it("never touches the approval store", async () => {
    h.fetch.mockResolvedValue(new Response("{}", { status: 200 }));
    expect((await call("GET", "/user")).status).toBe(200);
    expect(h.checkApproval).not.toHaveBeenCalled();
    expect(h.sendApprovalPrompt).not.toHaveBeenCalled();
  });
});
