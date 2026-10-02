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

describe("an admitted read", () => {
  it("injects the tenant's token, sends exactly the matched path, and records the call", async () => {
    const res = await call("GET", "/repos/acme/web/issues", "per_page=2&state=open");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ number: 1 }]);

    const [url, init] = upstreamCalls()[0]!;
    // The client's query survives; the router's injected params do not.
    expect(url).toBe("https://api.github.com/repos/acme/web/issues?per_page=2&state=open");
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("manual");
    const sent = new Headers(init.headers);
    expect(sent.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(sent.get("user-agent")).toMatch(/PassControl/);
    expect(init.body ?? null).toBeNull();

    // The token is read for the NAMESPACED provider, never a bare service id.
    expect(keyReads()).toEqual([["get_provider_key", { p_agent_id: AGENT, p_provider: "svc:github" }]]);

    expect(lastLog()).toMatchObject({
      agentId: AGENT,
      userId: TENANT,
      provider: "svc:github",
      status: "ok",
      callKind: "service",
      endpoint: "GET /repos/acme/*/issues",
      unpriced: true,
      costMicrocents: null,
    });
    const parsed = parseServiceRules(READ_RULES, "github");
    if (parsed.kind !== "rules") throw new Error("setup");
    expect(lastReceipt()).toMatchObject({
      provider: "svc:github",
      method: "GET",
      path: "repos/acme/web/issues",
      callClass: "svc",
      unpriced: true,
      costMicrocents: 0,
      status: "ok",
      httpStatus: 200,
      policyRevision: serviceRulesRevision("github", parsed.rules),
    });
    expect(res.headers.get("x-passcontrol-receipt-id")).toBe(lastLog()!.id);
  });

  it("reads the rules for this agent AND this tenant, live", async () => {
    await call("GET", "/user");
    expect(h.agentsFilters).toEqual(expect.arrayContaining([["id", AGENT], ["user_id", TENANT]]));
  });

  it("never forwards the agent's own credential or unlisted headers", async () => {
    await call("GET", "/user", "", {
      headers: {
        "x-api-key": "pc_agent_secret",
        cookie: "session=1",
        accept: "application/vnd.github+json",
        "x-github-api-version": "2026-03-10",
      },
    });
    const sent = new Headers(upstreamCalls()[0]![1].headers);
    expect(sent.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(sent.get("x-api-key")).toBeNull();
    expect(sent.get("cookie")).toBeNull();
    expect(sent.get("accept")).toBe("application/vnd.github+json");
    expect(sent.get("x-github-api-version")).toBe("2026-03-10");
  });

  it("returns only the listed response headers, with pagination kept on the governed path", async () => {
    h.fetch.mockResolvedValueOnce(
      new Response("[]", {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-oauth-scopes": "repo, admin:org",
          "set-cookie": "a=b",
          "x-ratelimit-remaining": "4999",
          link: '<https://api.github.com/repositories/42/issues?page=2>; rel="next"',
        },
      })
    );
    const res = await call("GET", "/repos/acme/web/issues");
    expect(res.headers.get("x-oauth-scopes")).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("x-ratelimit-remaining")).toBe("4999");
    expect(res.headers.get("link")).toBe(
      `<${ORIGIN}/api/v1/svc/github/repos/acme/web/issues?page=2>; rel="next"`
    );
  });

  it("does not follow a redirect: the credential never travels to where it points", async () => {
    h.fetch.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "https://codeload.github.com/acme/web/legacy.tar.gz/refs/heads/main" },
      })
    );
    const res = await call("GET", "/user");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://codeload.github.com/acme/web/legacy.tar.gz/refs/heads/main");
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(lastLog()!.status).toBe("ok");
  });

  it("redacts the token if the service echoes it back", async () => {
    h.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: `bad credentials: ${TOKEN}` }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })
    );
    const res = await call("GET", "/user");
    const text = await res.text();
    expect(text).not.toContain(TOKEN);
    expect(res.status).toBe(401);
    expect(lastLog()!.status).toBe("upstream_error");
  });

  it("answers HEAD without a body", async () => {
    h.fetch.mockResolvedValueOnce(new Response(null, { status: 200, headers: { etag: 'W/"x"' } }));
    const res = await call("HEAD", "/user");
    expect(res.status).toBe(200);
    expect(upstreamCalls()[0]![1].method).toBe("HEAD");
    expect(res.headers.get("etag")).toBe('W/"x"');
  });

  it("is not gated by the agent's LLM policy: service rules are the scope", async () => {
    h.readPolicy.mockResolvedValue({
      policy: { deny: [{ provider: "*", model: "*" }] },
      shadow: null,
      senderConstraintMode: "off",
      budget: { known: true, tokens: 0, cents: 0 },
      period: { known: false },
    });
    const res = await call("GET", "/user");
    expect(res.status).toBe(200);
  });

  it("answers a service that cannot be reached as 502 and records it", async () => {
    h.fetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    const res = await call("GET", "/user");
    expect(res.status).toBe(502);
    expect(lastLog()).toMatchObject({ status: "upstream_error", callKind: "service" });
  });
});

// Phase 2: writes. The order is the read path's, with one addition: the body
// is read only once the call is admitted, so a refused write never has its
// bytes read, and an admitted one has them bound into the receipt.
describe("an admitted write", () => {
  const WRITE_RULES = {
    github: {
      allow: [
        { method: "POST", path: "/repos/acme/*/issues" },
        { method: "PATCH", path: "/repos/acme/web/issues/*" },
        // Over-broad on purpose: the never list must still stop a repo delete.
        { method: "DELETE", path: "/repos/*/*" },
        { method: "DELETE", path: "/*/acme/web" },
        { method: "GET", path: "/user" },
      ],
      max_requests_per_hour: 50,
    },
  };
  const BODY = JSON.stringify({ title: "Flaky test in CI", body: "Seen 3 times today." });
  const json = { "content-type": "application/json" };

  beforeEach(() => {
    h.rulesRead.mockResolvedValue({ data: { service_rules: WRITE_RULES }, error: null });
    h.fetch.mockResolvedValue(
      new Response(JSON.stringify({ number: 42 }), { status: 201, headers: { "content-type": "application/json" } })
    );
  });

  it("forwards the method and the exact body, and binds the body into the receipt", async () => {
    const res = await call("POST", "/repos/acme/web/issues", "", { headers: json, body: BODY });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ number: 42 });

    const [url, init] = upstreamCalls()[0]!;
    expect(url).toBe("https://api.github.com/repos/acme/web/issues");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(BODY);
    const sent = new Headers(init.headers);
    expect(sent.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(sent.get("content-type")).toBe("application/json");

    expect(lastReceipt()).toMatchObject({ method: "POST", path: "repos/acme/web/issues", rawBody: BODY, httpStatus: 201 });
    expect(lastLog()).toMatchObject({ status: "ok", endpoint: "POST /repos/acme/*/issues" });
    // What the agent wrote is the tenant's data: bound by digest, never logged.
    expect(JSON.stringify(lastLog())).not.toContain("Flaky test in CI");
  });

  it("forwards PATCH the same way", async () => {
    const res = await call("PATCH", "/repos/acme/web/issues/7", "", { headers: json, body: '{"state":"closed"}' });
    expect(res.status).toBe(201);
    expect(upstreamCalls()[0]![1]).toMatchObject({ method: "PATCH", body: '{"state":"closed"}' });
  });

  it("refuses a repository delete even when a tenant rule allows it", async () => {
    const res = await call("DELETE", "/repos/acme/web");
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("service_endpoint_refused");
    expect(lastLog()).toMatchObject({ status: "blocked_endpoint" });
    expectNothingSent();
  });

  it("refuses it under any casing a wildcard rule would match", async () => {
    const res = await call("DELETE", "/REPOS/acme/web");
    expect(res.status).toBe(403);
    expectNothingSent();
  });

  it("does not read the body of a write no rule admits", async () => {
    const { req, ctx } = request("PUT", "/repos/acme/web/contents/x", "", { headers: json, body: BODY });
    const res = await PUT(req, ctx);
    expect(res.status).toBe(403);
    expect(req.bodyUsed).toBe(false);
    expectNothingSent();
  });

  it("refuses an oversized body with 413, after the rules and before the token", async () => {
    const big = JSON.stringify({ body: "x".repeat(1_100_000) });
    const res = await call("POST", "/repos/acme/web/issues", "", { headers: json, body: big });
    expect(res.status).toBe(413);
    expectNothingSent();
    // Unadmitted, the same size is a scope refusal: rules come first.
    const refused = await call("POST", "/repos/acme/web/pulls", "", { headers: json, body: big });
    expect(refused.status).toBe(403);
  });

  it("refuses a body that is not JSON (GitHub's REST API takes JSON)", async () => {
    const res = await call("POST", "/repos/acme/web/issues", "", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "title=x",
    });
    expect(res.status).toBe(415);
    expectNothingSent();
  });

  it("never forwards a body on a read, nor lets an override header turn it into a write", async () => {
    await call("GET", "/user", "", { headers: { "x-http-method-override": "DELETE", "x-http-method": "DELETE" } });
    const [, init] = upstreamCalls()[0]!;
    expect(init.method).toBe("GET");
    expect(init.body ?? null).toBeNull();
    const sent = new Headers(init.headers);
    expect(sent.get("x-http-method-override")).toBeNull();
    expect(sent.get("x-http-method")).toBeNull();
  });
});

describe("refusals, none of which decrypt the token or reach GitHub", () => {
  it("refuses an unknown service before authenticating", async () => {
    const req = new Request(`${ORIGIN}/api/v1/svc/slack/api/chat.postMessage?service=slack&path=api`, {
      headers: { authorization: `Bearer ${VISA}` },
    });
    const res = await GET(req, { params: Promise.resolve({ service: "slack", path: ["api"] }) });
    expect(res.status).toBe(404);
    expect(h.verifyVisa).not.toHaveBeenCalled();
    expectNothingSent();
  });

  it.each([
    ["an encoded slash", "/repos/acme%2Fweb/issues"],
    ["an encoded NUL", "/repos/a%00b"],
  ])("refuses a path with %s", async (_label, path) => {
    const res = await call("GET", path);
    expect(res.status).toBe(400);
    expectNothingSent();
  });

  it("refuses without a credential", async () => {
    const req = new Request(`${ORIGIN}/api/v1/svc/github/user?service=github&path=user`);
    const res = await GET(req, { params: Promise.resolve({ service: "github", path: ["user"] }) });
    expect(res.status).toBe(401);
    expectNothingSent();
  });

  it("stops a killed tenant's GitHub access the same instant as its LLM access", async () => {
    h.readKillState.mockResolvedValue({ platformKill: false, userKill: true, denylist: [] });
    const res = await call("GET", "/user");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "blocked_suspended" });
    expect(lastLog()).toMatchObject({ status: "blocked_killed", callKind: "service", provider: "svc:github" });
    expectNothingSent();
  });

  it("stops this service when the tenant armed its per-service kill, and reads it in the kill read", async () => {
    h.readKillState.mockResolvedValue({ platformKill: false, userKill: false, denylist: [], serviceKill: true });
    const res = await call("GET", "/user");
    expect(res.status).toBe(403);
    // The same opaque body as every other stop: the agent learns it was stopped.
    expect((await res.json()).error).toBe("blocked_suspended");
    expect(lastLog()).toMatchObject({ status: "blocked_killed" });
    expect(h.readKillState).toHaveBeenCalledWith(TENANT, { service: "github" });
    expectNothingSent();
  });

  it("stops a suspended agent", async () => {
    h.isSuspended.mockResolvedValue(true);
    const res = await call("GET", "/user");
    expect(res.status).toBe(403);
    expect(lastLog()).toMatchObject({ status: "blocked_suspended", callKind: "service" });
    expectNothingSent();
  });

  it("shares the agent's gateway-wide request limit", async () => {
    h.rateLimit.mockResolvedValue({ success: false, remaining: 0 });
    const res = await call("GET", "/user");
    expect(res.status).toBe(429);
    expect(h.rateLimit.mock.calls[0]![0]).toBe(`proxy:${AGENT}`);
    expectNothingSent();
  });

  it("denies by default: an agent with no rules for this service", async () => {
    h.rulesRead.mockResolvedValue({ data: { service_rules: null }, error: null });
    const res = await call("GET", "/user");
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("service_call_not_allowed");
    expect(lastLog()).toMatchObject({ status: "blocked_scope", callKind: "service" });
    expect(lastLog()).not.toHaveProperty("endpoint");
    expectNothingSent();
  });

  it("refuses a path no rule matches, and names what was asked", async () => {
    const res = await call("GET", "/orgs/acme/members");
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("service_call_not_allowed");
    expect(body.message).toContain("GET /orgs/acme/members");
    expectNothingSent();
  });

  it("refuses a write from a read-only agent, and records the attempt", async () => {
    h.rulesRead.mockResolvedValue({
      data: { service_rules: { github: { allow: [{ method: "GET", path: "/**" }] } } },
      error: null,
    });
    const res = await call("POST", "/repos/acme/web/issues", "", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "x" }),
    });
    expect(res.status).toBe(403);
    expect(lastLog()).toMatchObject({ status: "blocked_scope", callKind: "service" });
    expect(lastReceipt()).toMatchObject({ method: "POST", path: "repos/acme/web/issues", callClass: "svc" });
    expectNothingSent();
  });

  it("refuses DELETE the same way", async () => {
    const res = await call("DELETE", "/repos/acme/web");
    expect(res.status).toBe(403);
    expectNothingSent();
  });

  it("refuses GraphQL whatever the rules say", async () => {
    h.rulesRead.mockResolvedValue({
      data: { service_rules: { github: { allow: [{ method: "GET", path: "/**" }] } } },
      error: null,
    });
    const res = await call("GET", "/graphql");
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("service_endpoint_refused");
    expect(lastLog()).toMatchObject({ status: "blocked_endpoint", callKind: "service" });
    expectNothingSent();
  });

  it("treats malformed rules as a refusal of this service, not as no rule", async () => {
    h.rulesRead.mockResolvedValue({
      // Still malformed in phase 2: a write may not use the trailing `**`.
      data: { service_rules: { github: { allow: [{ method: "POST", path: "/repos/acme/**" }] } } },
      error: null,
    });
    const res = await call("GET", "/user");
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("service_rules_invalid");
    expectNothingSent();
  });

  it("FAILS CLOSED when the rules cannot be read, on every deployment (T11)", async () => {
    delete process.env.POLICY_FAIL_CLOSED; // the self-host default: policy fails OPEN
    h.rulesRead.mockResolvedValue({ data: null, error: { code: "57014", message: "timeout" } });
    const res = await call("GET", "/user");
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("service_rules_unavailable");
    expectNothingSent();
  });

  it("fails closed when the rules read throws", async () => {
    h.rulesRead.mockRejectedValue(new Error("network"));
    const res = await call("GET", "/user");
    expect(res.status).toBe(503);
    expectNothingSent();
  });

  it("enforces the per-service hourly cap from the rules", async () => {
    h.rateLimitFailClosed.mockImplementation(async (key: string) =>
      key.startsWith("svc-cap:") ? { success: false, remaining: 0 } : { success: true, remaining: 1 }
    );
    const res = await call("GET", "/user");
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("service_rate_limited");
    expect(res.headers.get("retry-after")).toBeTruthy();
    const capCall = h.rateLimitFailClosed.mock.calls.find(([key]) => String(key).startsWith("svc-cap:"))!;
    expect(capCall).toEqual([`svc-cap:${AGENT}:github`, 50, 3600]);
    expect(lastLog()).toMatchObject({ status: "blocked_policy", callKind: "service" });
    expectNothingSent();
  });

  it("fails closed when the cap cannot be read: it has no second backstop", async () => {
    h.rateLimitFailClosed.mockImplementation(async (key: string) =>
      key.startsWith("svc-cap:") ? { success: false, unreadable: true } : { success: true, remaining: 1 }
    );
    const res = await call("GET", "/user");
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("service_rate_limit_unavailable");
    expectNothingSent();
  });

  it("says plainly when no GitHub token is stored", async () => {
    h.rpc.mockResolvedValue({ data: null, error: null });
    const res = await call("GET", "/user");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("no_service_credential");
    expect(lastLog()).toMatchObject({ status: "no_provider_key", callKind: "service" });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("does not report a credential READ failure as a missing credential", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { message: "connection reset" } });
    const res = await call("GET", "/user");
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("credential_unavailable");
    expect(h.fetch).not.toHaveBeenCalled();
  });

});

describe("GitHub's own `token` scheme (Octokit's `auth`, `gh`)", () => {
  it("accepts the agent's credential sent as `Authorization: token`", async () => {
    const res = await call("GET", "/user", "", { headers: { authorization: `token ${VISA}` } });
    expect(res.status).toBe(200);
    expect(h.verifyVisa).toHaveBeenCalledWith(VISA);
    // Same header name GitHub reads, so pin it: what goes upstream is ONLY the
    // injected GitHub token, never the agent's own credential.
    const sent = new Headers(upstreamCalls()[0]![1].headers);
    expect(sent.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(JSON.stringify(upstreamCalls())).not.toContain(VISA);
  });

  it("reads the scheme whatever its case", async () => {
    // A fresh body per call: one Response can be read only once.
    h.fetch.mockImplementation(async () => new Response("{}", { status: 200 }));
    for (const scheme of ["Token", "TOKEN"]) {
      const res = await call("GET", "/user", "", { headers: { authorization: `${scheme} ${VISA}` } });
      expect(res.status).toBe(200);
    }
  });

  it("is still no credential when the value is empty", async () => {
    const res = await call("GET", "/user", "", { headers: { authorization: "token " } });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "missing_visa" });
    expectNothingSent();
  });

  it("never outranks x-api-key, so a working request reads what it always read", async () => {
    const res = await call("GET", "/user", "", {
      headers: { authorization: "token ghp_the_agents_real_github_token_000000", "x-api-key": VISA },
    });
    expect(res.status).toBe(200);
    expect(h.verifyVisa).toHaveBeenCalledWith(VISA);
  });

  it("refuses a real GitHub token sent there, and never echoes or records it", async () => {
    const pat = "ghp_the_agents_real_github_token_000000";
    // The real verifier answers null for anything that is not a visa it signed.
    const claims = await h.verifyVisa();
    h.verifyVisa.mockImplementation(async (token: string) => (token === VISA ? claims : null));
    const res = await call("GET", "/user", "", { headers: { authorization: `token ${pat}` } });
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain(pat);
    expect(JSON.stringify(h.captureSecurityEvent.mock.calls)).not.toContain(pat);
    expect(JSON.stringify(h.writeLog.mock.calls)).not.toContain(pat);
    expectNothingSent();
  });
});

describe("sender-constrained agents", () => {
  it("require the per-request proof on service calls too", async () => {
    h.readPolicy.mockResolvedValue({
      policy: null,
      shadow: null,
      senderConstraintMode: "required",
      budget: { known: false },
      period: { known: false },
    });
    const res = await call("GET", "/user");
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("missing_sender_proof");
    expectNothingSent();
  });
});

// Telegram through the same route (phase 2, slice E). The token is put into the
// URL PATH, so the URL is a secret: never in a response, a log row, a receipt
// or a header. What the agent asks for is one Bot API method name.
describe("Telegram", () => {
  const TG = "123456789:AAH4dGVzdC10b2tlbi1mb3ItcGFzc2NvbnRyb2w";
  const TG_RULES = { telegram: { allow: [{ call: "sendMessage" }, { call: "getMe" }, { call: "setWebhook" }] } };

  function tg(method: string, name: string, clientQuery = "", init: { headers?: Record<string, string>; body?: string } = {}) {
    const segments = name.split("/");
    const injected = ["service=telegram", ...segments.map((x) => `path=${x}`)].join("&");
    const query = [clientQuery, injected].filter(Boolean).join("&");
    const req = new Request(`${ORIGIN}/api/v1/svc/telegram/${name}?${query}`, {
      method,
      headers: { authorization: `Bearer ${VISA}`, ...(init.headers ?? {}) },
      ...(init.body !== undefined ? { body: init.body } : {}),
    });
    const ctx = { params: Promise.resolve({ service: "telegram", path: segments }) };
    const handler = { GET, POST, PUT, DELETE }[method as "GET" | "POST" | "PUT" | "DELETE"];
    return handler(req, ctx);
  }

  beforeEach(() => {
    h.rulesRead.mockResolvedValue({ data: { service_rules: TG_RULES }, error: null });
    h.rpc.mockResolvedValue({ data: TG, error: null });
    // A fresh Response per call: a body can be read once.
    h.fetch.mockImplementation(
      async () =>
        new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), { status: 200, headers: { "content-type": "application/json" } })
    );
  });

  it("sends the method to api.telegram.org with the token in the path, and nowhere else", async () => {
    const body = JSON.stringify({ chat_id: 42, text: "build is green" });
    const res = await tg("POST", "sendMessage", "", { headers: { "content-type": "application/json" }, body });
    expect(res.status).toBe(200);
    const [url, init] = upstreamCalls()[0]!;
    expect(url).toBe(`https://api.telegram.org/bot${TG}/sendMessage`);
    expect(init.body).toBe(body);
    const sent = new Headers(init.headers);
    expect(sent.get("authorization")).toBeNull();
    expect([...sent.values()].join(" ")).not.toContain(TG);
    expect(keyReads()).toEqual([["get_provider_key", { p_agent_id: AGENT, p_provider: "svc:telegram" }]]);
    expect(lastLog()).toMatchObject({ provider: "svc:telegram", status: "ok", endpoint: "CALL sendMessage" });
    // The receipt names the method, never the URL that carries the token.
    expect(lastReceipt()).toMatchObject({ path: "sendMessage", method: "POST", rawBody: body });
    expect(JSON.stringify(lastReceipt())).not.toContain(TG);
    expect(JSON.stringify(lastLog())).not.toContain(TG);
  });

  it("accepts GET with parameters in the query, and a form body, as Telegram does", async () => {
    await tg("GET", "getMe", "x=1");
    expect(upstreamCalls()[0]![0]).toBe(`https://api.telegram.org/bot${TG}/getMe?x=1`);
    const res = await tg("POST", "sendMessage", "", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "chat_id=42&text=hi",
    });
    expect(res.status).toBe(200);
    expect(upstreamCalls()[1]![1].body).toBe("chat_id=42&text=hi");
  });

  it("refuses an upload (multipart): its bytes are not text", async () => {
    const res = await tg("POST", "sendMessage", "", { headers: { "content-type": "multipart/form-data; boundary=x" }, body: "--x--" });
    expect(res.status).toBe(415);
    expectNothingSent();
  });

  it("refuses setWebhook even with a rule for it, in any casing", async () => {
    for (const name of ["setWebhook", "SETWEBHOOK"]) {
      const res = await tg("POST", name, "", { headers: { "content-type": "application/json" }, body: "{}" });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("service_endpoint_refused");
    }
    expectNothingSent();
  });

  it("refuses file downloads, which would carry the token in the URL", async () => {
    const res = await tg("GET", "file/photos/a.jpg");
    expect(res.status).toBe(403);
    expectNothingSent();
  });

  it("refuses a method no rule names", async () => {
    const res = await tg("POST", "deleteMessage", "", { headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("service_call_not_allowed");
    expectNothingSent();
  });

  it("never puts a stored token that is not token-shaped into a URL", async () => {
    h.rpc.mockResolvedValue({ data: "123:abc/../../x?y=", error: null });
    const res = await tg("GET", "getMe");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("service_credential_invalid");
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("redacts the token if Telegram's answer ever carries it, and drops URL headers", async () => {
    h.fetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: false, description: `bad bot${TG}` }), {
        status: 400,
        headers: { "content-type": "application/json", location: `https://api.telegram.org/bot${TG}/x`, link: `<https://api.telegram.org/bot${TG}/x>; rel="next"` },
      })
    );
    const res = await tg("GET", "getMe");
    const text = await res.text();
    expect(text).not.toContain(TG);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("link")).toBeNull();
  });

  it("is stopped by its own per-service stop", async () => {
    h.readKillState.mockResolvedValue({ platformKill: false, userKill: false, denylist: [], serviceKill: true });
    const res = await tg("GET", "getMe");
    expect(res.status).toBe(403);
    expect(h.readKillState).toHaveBeenCalledWith(TENANT, { service: "telegram" });
    expectNothingSent();
  });
});
