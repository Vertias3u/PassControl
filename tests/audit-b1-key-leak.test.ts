// B1 attack proofs. Regression proofs assert safe behavior.
// Route harness adapted from proxy-receipt.test.ts; only network/state boundaries mocked.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import OpenAI from "openai";
const sentryHarness = vi.hoisted(() => ({
  events: [] as unknown[],
  errors: [] as Error[],
  beforeSend: undefined as undefined | ((event: unknown) => unknown),
}));
vi.mock("@sentry/nextjs", () => ({
  init: (options: { beforeSend: (event: unknown) => unknown }) => { sentryHarness.beforeSend = options.beforeSend; },
  captureException: (error: Error) => {
    sentryHarness.errors.push(error);
    // Serialize the message as the SDK does, then use the REAL registered scrubber.
    sentryHarness.events.push(sentryHarness.beforeSend!({ exception: { values: [{ type: error.name, value: error.message }] } }));
  },
  captureMessage: vi.fn(),
}));
const establishBudgetStateMock = vi.fn();
const fallbacks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/lib/state/fallbacks", () => ({ readCurrentAgentFallbacks: (...args: unknown[]) => fallbacks.read(...args) }));

const {
  verifyVisaMock,
  serviceClientMock,
  openHoldMock,
  settleHoldMock,
  getCachedKeyMock,
  setCachedKeyMock,
  getCachedAgentPolicyMock,
  setCachedAgentPolicyMock,
  readKillStateMock,
  isSuspendedMock,
  writeLogMock,
  mirrorSpendMock,
  rateLimitMock,
  signReceiptMock,
  readCurrentOwnerMock,
  fetchMock,
} = vi.hoisted(() => ({
  verifyVisaMock: vi.fn(),
  serviceClientMock: vi.fn(),
  openHoldMock: vi.fn(),
  settleHoldMock: vi.fn(),
  getCachedKeyMock: vi.fn(),
  setCachedKeyMock: vi.fn(),
  getCachedAgentPolicyMock: vi.fn(),
  setCachedAgentPolicyMock: vi.fn(),
  readKillStateMock: vi.fn(),
  isSuspendedMock: vi.fn(),
  writeLogMock: vi.fn(),
  mirrorSpendMock: vi.fn(),
  rateLimitMock: vi.fn(),
  signReceiptMock: vi.fn(),
  readCurrentOwnerMock: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock("@/lib/mission/gate", () => ({ resolveCallMission: async () => ({ kind: "none" }) }));
vi.mock("server-only", () => ({}));
vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));
vi.mock("@/lib/auth/visa", () => ({
  extractVisaToken: (headers: Headers) =>
    headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "",
  verifyVisa: (...args: unknown[]) => verifyVisaMock(...args),
}));
vi.mock("@/lib/state/killswitch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/state/killswitch")>();
  return { ...actual, readKillState: (...args: unknown[]) => readKillStateMock(...args) };
});
vi.mock("@/lib/state/redis", () => ({
  getCachedEndpoint: async () => "|",
  purgeAgentPolicy: vi.fn(),
  readCredentialFence: vi.fn(async () => null),
  isSuspended: (...args: unknown[]) => isSuspendedMock(...args),
  getCachedKey: (...args: unknown[]) => getCachedKeyMock(...args),
  setCachedKey: (...args: unknown[]) => setCachedKeyMock(...args),
  getCachedAgentPolicy: (...args: unknown[]) => getCachedAgentPolicyMock(...args),
  setCachedAgentPolicy: (...args: unknown[]) => setCachedAgentPolicyMock(...args),
  readPolicyFence: async () => null,
}));
vi.mock("@/lib/state/holds", () => {
  const settle = async (outcome: string, p: Record<string, unknown>) => {
    const r = await settleHoldMock({ ...p, outcome });
    return (
      r ?? {
        applied: true,
        appliedTokens: Number(p.tokens ?? 0),
        appliedMicrocents: Number(p.microcents ?? 0),
      }
    );
  };
  return {
    openHold: (...args: unknown[]) => openHoldMock(...args),
    consumeDispatchPermission: async () => ({ granted: true }),
    settleKnown: (p: Record<string, unknown>) => settle("complete", p),
    settleUnknown: (p: Record<string, unknown>) => settle("usage_unknown", p),
    releaseUndispatched: (p: Record<string, unknown>) => settle("not_dispatched", p),
    establishBudgetState: (...args: unknown[]) => establishBudgetStateMock(...args),
  };
});
vi.mock("@/lib/supabase", () => ({ serviceClient: () => serviceClientMock() }));
vi.mock("@/lib/crypto/aesgcm", () => ({ seal: async () => "sealed", open: async (v: string) => v }));
vi.mock("@/lib/log", () => ({
  writeLog: (...args: unknown[]) => writeLogMock(...args),
  mirrorSpend: (...args: unknown[]) => mirrorSpendMock(...args),
}));
vi.mock("@/lib/ratelimit", () => ({ rateLimitFailClosed: (...args: unknown[]) => rateLimitMock(...args), rateLimit: (...args: unknown[]) => rateLimitMock(...args) }));
vi.mock("@/lib/owner/current", () => ({
  readCurrentOwner: (...args: unknown[]) => readCurrentOwnerMock(...args),
}));
vi.mock("@/lib/receipt", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/receipt")>();
  return { ...actual, signReceipt: (...args: unknown[]) => signReceiptMock(...args) };
});

import { POST } from "@/app/api/v1/[provider]/[...path]/route";

const baseClaims = {
  sub: "passport-id",
  agid: "agent-id",
  uid: "user-id",
  jti: "visa-jti-1",
  bt: null,
  bc: null,
  st: 0,
  sc: 0,
  ver: 1,
};

function call(body: Record<string, unknown>, scopeModel = "gpt-4o-mini") {
  verifyVisaMock.mockResolvedValue({
    ...baseClaims,
    scope: [{ provider: "openai", models: [scopeModel] }],
  });
  return POST(
    new Request("https://gateway.test/api/v1/openai/v1/chat/completions?provider=openai&path=v1&path=chat&path=completions", {
      method: "POST",
      headers: { authorization: "Bearer visa", "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ provider: "openai", path: ["v1", "chat", "completions"] }) }
  );
}

const CHAT = { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] };

beforeEach(() => {
  vi.clearAllMocks();
  fallbacks.read.mockResolvedValue([]);
  sentryHarness.events.length = 0;
  sentryHarness.errors.length = 0;
  serviceClientMock.mockReturnValue({
    rpc: vi.fn(async () => ({ data: KEY, error: null })),
    from: () => {
      const chain = {
        select: () => chain, eq: () => chain,
        maybeSingle: async () => ({ data: { service_rules: { github: { allow: [{ method: "GET", path: "/user" }], max_requests_per_hour: 50 } } }, error: null }),
      };
      return chain;
    },
  });
  openHoldMock.mockResolvedValue({ ok: true, reserved: 1 });
  settleHoldMock.mockResolvedValue(undefined);
  getCachedKeyMock.mockResolvedValue(null);
  setCachedKeyMock.mockResolvedValue(undefined);
  getCachedAgentPolicyMock.mockResolvedValue(JSON.stringify({ p: {}, s: null }));
  setCachedAgentPolicyMock.mockResolvedValue(undefined);
  readKillStateMock.mockResolvedValue({ platformKill: false, userKill: false, denylist: [] });
  isSuspendedMock.mockResolvedValue(false);
  writeLogMock.mockResolvedValue(undefined);
  mirrorSpendMock.mockResolvedValue(undefined);
  rateLimitMock.mockResolvedValue({ success: true, remaining: 1 });
  signReceiptMock.mockReturnValue("header.payload.signature");
  readCurrentOwnerMock.mockResolvedValue(null);
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  );
  vi.stubGlobal("fetch", fetchMock);
});


import { GET as serviceGET } from "@/app/api/v1/svc/[service]/[...path]/route";
const KEY = "sk-proj-7Hx2Qa9Lm4Jv8Bc3Np6Wr0Ty5Dg1Fs";
const upstream = (body: string, status = 400, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "content-type": "application/json", ...headers } });
const SERVICE_TOKEN = "ghp_7Hx2Qa9Lm4Jv8Bc3Np6Wr0Ty5Dg1FsAa9Bb0C";
async function serviceCall() {
  serviceClientMock().rpc.mockResolvedValue({ data: SERVICE_TOKEN, error: null });
  return serviceGET(new Request("https://gateway.test/api/v1/svc/github/user?service=github&path=user", {
    headers: { authorization: "Bearer visa" },
  }), { params: Promise.resolve({ service: "github", path: ["user"] }) });
}
function assertDispatch(key = KEY) {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${key}`);
  expect(url).not.toContain("provider=");
  expect(url).not.toContain("path=");
}
it("B1-01 provider Content-Type echo", async () => {
  fetchMock.mockResolvedValue(upstream("{}", 400, { "content-type": `application/json; echo=${KEY}` }));
  const res = await call(CHAT);
  assertDispatch();
  expect(res.status).toBe(400);
  expect(res.headers.get("content-type")).not.toContain(KEY);
});
it("B1-02 service ETag echo", async () => {
  fetchMock.mockResolvedValue(upstream("{}", 200, { etag: `"${SERVICE_TOKEN}"` }));
  const res = await serviceCall();
  assertDispatch(SERVICE_TOKEN);
  expect(res.status).toBe(200);
  expect(res.headers.get("etag")).not.toContain(SERVICE_TOKEN);
});
const escapedKey = (key = KEY) => [...key].map(c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
it("B1-03a Unicode-escaped provider error", async () => {
  fetchMock.mockResolvedValue(upstream(`{"error":{"message":"${escapedKey()}"}}`, 429));
  const res = await call(CHAT);
  assertDispatch();
  expect(res.status).toBe(429);
  expect((await res.json()).error.message).not.toContain(KEY);
});
it("B1-03b Unicode-escaped service body", async () => {
  fetchMock.mockResolvedValue(upstream(`{"message":"${escapedKey(SERVICE_TOKEN)}"}`, 200));
  const res = await serviceCall();
  assertDispatch(SERVICE_TOKEN);
  expect(res.status).toBe(200);
  expect((await res.json()).message).not.toContain(SERVICE_TOKEN);
});
it("B1-04 multiline SSE echo", async () => {
  const parts = KEY.match(/.{1,5}/g)!;
  const wire = parts.map(content => 'data: {"choices": [\n' +
    'data: ' + JSON.stringify({ index: 0, delta: { content } }) + '] }\n\n').join("");
  fetchMock.mockResolvedValue(upstream(wire, 200, { "content-type": "text/event-stream" }));
  const res = await call({ ...CHAT, stream: true });
  assertDispatch();
  expect(res.status).toBe(200);
  // Let the official SDK interpret multiline SSE rather than inventing a client.
  const client = new OpenAI({ apiKey: "visa", fetch: async () => res });
  const stream = await client.chat.completions.create({ model: CHAT.model, messages: [], stream: true });
  let joined = "";
  for await (const event of stream) joined += event.choices[0]?.delta.content ?? "";
  expect(joined).not.toContain(KEY);
});

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("B1-held failover key isolation", async () => {
  const secondKey = "gsk_8Zj5Wq2Rs9Tv4Um1Xn6Yp3Ab0Cd7Ef";
  fallbacks.read.mockResolvedValue([{ provider: "groq", model: "llama-3.3-70b" }]);
  verifyVisaMock.mockResolvedValue({ ...baseClaims, scope: [
    { provider: "openai", models: ["*"] }, { provider: "groq", models: ["*"] },
  ] });
  serviceClientMock().rpc.mockImplementation(async (_name: string, args: { p_provider: string }) =>
    ({ data: args.p_provider === "groq" ? secondKey : KEY, error: null }));
  fetchMock.mockResolvedValueOnce(upstream(`first upstream echo: ${KEY}`, 503, { "content-type": "text/plain" }))
    .mockResolvedValueOnce(upstream(JSON.stringify({ choices: [{ message: { content: secondKey } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), 200));
  const res = await POST(new Request("https://gateway.test/api/v1/openai/v1/chat/completions?provider=openai&path=v1&path=chat&path=completions", {
    method: "POST", headers: { authorization: "Bearer visa", "content-type": "application/json" }, body: JSON.stringify(CHAT),
  }), { params: Promise.resolve({ provider: "openai", path: ["v1", "chat", "completions"] }) });
  expect(res.status).toBe(200);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls.map(([, init]) => new Headers((init as RequestInit).headers).get("authorization")))
    .toEqual([`Bearer ${KEY}`, `Bearer ${secondKey}`]);
  await vi.waitFor(() => expect(writeLogMock).toHaveBeenCalledTimes(2));
  const exposed = JSON.stringify({ body: await res.text(), headers: [...res.headers], logs: writeLogMock.mock.calls, receipts: signReceiptMock.mock.calls });
  expect(exposed).not.toContain(KEY);
  expect(exposed).not.toContain(secondKey);
});

it("B1-05 reflected exception to Sentry", async () => {
  const customKey = "tenantCredential-72hQ8p";
  vi.stubEnv("SENTRY_DSN", "https://public@example.invalid/1");
  serviceClientMock().rpc.mockResolvedValue({ data: customKey, error: null });
  fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
    const injected = new Headers(init.headers).get("authorization")!.slice(7);
    throw new Error(`upstream transport failed for credential=${injected}`);
  });
  const res = await call(CHAT);
  assertDispatch(customKey);
  expect(res.status).toBe(502);
  expect(await res.text()).not.toContain(customKey);
  await vi.waitFor(() => expect(sentryHarness.events).toHaveLength(1));
  expect(JSON.stringify(sentryHarness.events)).not.toContain(customKey);
});

import { PROVIDER_KEY_REDACTION as MARK, redactSecretsInText, redactingStream, secretsToRedact } from "@/lib/providers/secret-redaction";

it("B1 controls: provider and service headers without keys are unchanged", async () => {
  const contentType = "application/json; profile=ordinary";
  fetchMock.mockResolvedValue(upstream("{}", 400, { "content-type": contentType }));
  expect((await call(CHAT)).headers.get("content-type")).toBe(contentType);
  fetchMock.mockResolvedValue(upstream("{}", 200, { etag: 'W/"ordinary-tag"' }));
  expect((await serviceCall()).headers.get("etag")).toBe('W/"ordinary-tag"');
});

it("B1 controls: escaped JSON without keys stays byte-identical in both routes", async () => {
  const body = String.raw`{ "message": "\u0041\/\u0022\u005c\u001f\u007f\u00e9" }`;
  fetchMock.mockResolvedValue(upstream(body, 400));
  expect(await (await call(CHAT)).text()).toBe(body);
  fetchMock.mockResolvedValue(upstream(body, 200));
  expect(await (await serviceCall()).text()).toBe(body);
});

it("B1 controls: partly escaped keys and escaped slashes are caught", async () => {
  for (const key of [KEY, "short/key"]) {
    const mixed = [...key].map((c, i) => i % 2 ? escapedKey(c).toUpperCase().replaceAll("\\U", "\\u") : c).join("").replaceAll("/", "\\/");
    const result = redactSecretsInText(`{"message":"${mixed}"}`, secretsToRedact(key));
    expect(JSON.parse(result.text).message).toBe(MARK);
    expect(result.redacted).toBe(true);
  }
});

async function redactWire(wire: string, chunkSize = wire.length) {
  const bytes = new TextEncoder().encode(wire);
  const input = new ReadableStream<Uint8Array>({ start(controller) {
    for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize));
    controller.close();
  } });
  return new Response(input.pipeThrough(redactingStream(secretsToRedact(KEY)))).text();
}
async function sdkEvents(wire: string) {
  const client = new OpenAI({ apiKey: "visa", fetch: async () => upstream(wire, 200, { "content-type": "text/event-stream" }) });
  const stream = await client.chat.completions.create({ model: CHAT.model, messages: [], stream: true });
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}
it("B1 controls: ordinary single-line SSE stays byte-identical", async () => {
  const wire = 'event: message\ndata: { "choices": [{"index":0,"delta":{"content":"ordinary"}}] }\n\ndata: [DONE]\n\n';
  for (const size of [1, 7, wire.length]) expect(await redactWire(wire, size)).toBe(wire);
});
it("B1 controls: multiline SSE preserves official SDK events and raw bytes", async () => {
  for (const ending of ["\n", "\r\n", "\r"]) {
    const wire = ['id: 7', 'event: message', 'data: {"choices": [', ': comment', 'data: {"index":0,"delta":{"content":"hello \\u0041"}}]}', '', 'data: [DONE]', '', ''].join(ending);
    const redacted = await redactWire(wire, 1);
    expect(redacted).toBe(wire);
    expect(await sdkEvents(redacted)).toEqual(await sdkEvents(wire));
  }
});
it("B1 controls: over-long multiline SSE falls back to byte masking and resumes following", async () => {
  const big = 'data: {"padding":"' + 'x'.repeat(600_000) + '",\ndata: "padding2":"' + 'x'.repeat(600_000) + '","echo":"' + KEY + '"}\n\n';
  const tail = KEY.match(/.{1,5}/g)!.map(content => 'data: {"choices":[\ndata: ' + JSON.stringify({ index: 0, delta: { content } }) + ']}\n\n').join("");
  expect(await redactWire(big, 100_000)).toBe(big.replace(KEY, MARK));
  expect(await redactWire(big + tail, 100_000)).not.toContain(KEY);
  const output = await redactWire(big + tail, 100_000);
  expect((await sdkEvents(output.slice(output.indexOf('\n\n') + 2))).map(e => e.choices[0]?.delta.content ?? '').join('')).not.toContain(KEY);
});
it("B1 controls: Sentry error without a key keeps its message", async () => {
  vi.stubEnv("SENTRY_DSN", "https://public@example.invalid/1");
  fetchMock.mockRejectedValue(new Error("ordinary transport failure"));
  expect((await call(CHAT)).status).toBe(502);
  await vi.waitFor(() => expect(sentryHarness.events).toHaveLength(1));
  expect(sentryHarness.events[0]).toMatchObject({ exception: { values: [{ value: "ordinary transport failure" }] } });
});

it("B1 Sentry: message and stack are scrubbed in the outer post-key handler", async () => {
  vi.stubEnv("SENTRY_DSN", "https://public@example.invalid/1");
  const failure = new Error(`late failure ${KEY}`);
  failure.stack = `Error: late failure ${KEY}\n    at upstream(${KEY}:1:1)`;
  const response = upstream("{}", 200);
  vi.spyOn(response.headers, "get").mockImplementation(() => { throw failure; });
  fetchMock.mockResolvedValue(response);
  expect((await call(CHAT)).status).toBe(500);
  await vi.waitFor(() => expect(sentryHarness.errors).toHaveLength(1));
  expect(sentryHarness.errors[0]!.message).toBe(`late failure ${MARK}`);
  expect(sentryHarness.errors[0]!.stack).toBe(`Error: late failure ${MARK}\n    at upstream(${MARK}:1:1)`);
  expect(failure.message).toContain(KEY); // original error is not mutated
});
it("B1 SSE: escaped multiline deltas redact across network and line-ending boundaries", async () => {
  for (const ending of ["\n", "\r\n", "\r"]) {
    const wire = KEY.match(/.{1,5}/g)!.map(content => [
      'event: message', 'data: {"choices":[', ': comment',
      'data: {"index":0,"delta":{"content":"' + escapedKey(content) + '"}}]}', '', '',
    ].join(ending)).join("");
    const result = await redactWire(wire, 1);
    const events = await sdkEvents(result);
    expect(events).toHaveLength(KEY.match(/.{1,5}/g)!.length);
    expect(events.map(e => e.choices[0]?.delta.content ?? '').join('')).toBe(MARK);
  }
});
it("B1 SSE: multiline event cap releases bytes before the dispatching blank line", async () => {
  const stream = redactingStream(secretsToRedact(KEY));
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  let output = "";
  const reading = (async () => {
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      output += decoder.decode(value, { stream: true });
    }
  })();
  const encoder = new TextEncoder();
  await writer.write(encoder.encode('data: {"padding":"' + 'x'.repeat(600_000) + '",\n'));
  expect(output).toBe("");
  await writer.write(encoder.encode('data: "padding2":"' + 'x'.repeat(600_000) + '"}\n'));
  expect(output.length).toBeGreaterThan(1024 * 1024);
  await writer.write(encoder.encode('\n'));
  await writer.close();
  await reading;
});
it("B1 JSON: literal escapes and structural escapes keep their spelling", () => {
  const literal = JSON.stringify({ message: escapedKey() });
  expect(redactSecretsInText(literal, secretsToRedact(KEY))).toEqual({ text: literal, redacted: false });
  const body = String.raw`{"message":"${escapedKey()}","other":"\u0022\u005C\u001f\u007F\u00E9"}`;
  const safe = redactSecretsInText(body, secretsToRedact(KEY));
  expect(safe.text).toBe(String.raw`{"message":"${MARK}","other":"\u0022\u005C\u001f\u007F\u00E9"}`);
  expect(JSON.parse(safe.text).other).toBe(JSON.parse(body).other);
});

// The service route buffers JSON/text to see through \uXXXX escapes. That read must be
// bounded: past the cap the body streams through the byte redactor as before, so an
// upstream that never ends its body cannot make the gateway hold all of it in memory.
function jsonStream(chunks: Uint8Array[], close: boolean) {
  return new Response(new ReadableStream<Uint8Array>({ start(c) { for (const x of chunks) c.enqueue(x); if (close) c.close(); } }),
    { status: 200, headers: { "content-type": "application/json" } });
}
const within = <T,>(p: Promise<T>, why: string) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(why)), 2000))]);

it("B1 bound: a service JSON body past the inspection cap is streamed, not buffered", async () => {
  const head = new TextEncoder().encode(`{"message":"${SERVICE_TOKEN}","pad":"` + "x".repeat(1024 * 1024 + 16));
  fetchMock.mockResolvedValue(jsonStream([head], false));
  const res = await within(serviceCall(), "the route buffered an unbounded body");
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let seen = "";
  while (seen.length < 128) {
    const { value, done } = await within(reader.read(), "no bytes reached the agent");
    if (done) break;
    seen += dec.decode(value, { stream: true });
  }
  expect(seen).not.toContain(SERVICE_TOKEN);
  expect(seen).toContain(MARK);
  await reader.cancel();
});

it("B1 bound: an escaped token split across small chunks under the cap is still caught", async () => {
  const bytes = new TextEncoder().encode(`{"message":"${escapedKey(SERVICE_TOKEN)}"}`);
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += 7) chunks.push(bytes.slice(i, i + 7));
  fetchMock.mockResolvedValue(jsonStream(chunks, true));
  const res = await serviceCall();
  expect((await res.json()).message).toBe(MARK);
});
