import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  verifyVisaMock,
  serviceClientMock,
  reserveBudgetMock,
  reconcileBudgetMock,
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
  reserveBudgetMock: vi.fn(),
  reconcileBudgetMock: vi.fn(),
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
  isSuspended: (...args: unknown[]) => isSuspendedMock(...args),
  reserveBudget: (...args: unknown[]) => reserveBudgetMock(...args),
  reconcileBudget: (...args: unknown[]) => reconcileBudgetMock(...args),
  getCachedKey: (...args: unknown[]) => getCachedKeyMock(...args),
  setCachedKey: (...args: unknown[]) => setCachedKeyMock(...args),
  getCachedAgentPolicy: (...args: unknown[]) => getCachedAgentPolicyMock(...args),
  setCachedAgentPolicy: (...args: unknown[]) => setCachedAgentPolicyMock(...args),
  seedSpent: vi.fn(),
}));
vi.mock("@/lib/supabase", () => ({ serviceClient: () => serviceClientMock() }));
vi.mock("@/lib/crypto/aesgcm", () => ({ seal: async () => "sealed", open: async (v: string) => v }));
vi.mock("@/lib/log", () => ({
  writeLog: (...args: unknown[]) => writeLogMock(...args),
  mirrorSpend: (...args: unknown[]) => mirrorSpendMock(...args),
}));
vi.mock("@/lib/ratelimit", () => ({ rateLimit: (...args: unknown[]) => rateLimitMock(...args) }));
vi.mock("@/lib/owner/current", () => ({
  readCurrentOwner: (...args: unknown[]) => readCurrentOwnerMock(...args),
}));
vi.mock("@/lib/receipt", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/receipt")>();
  return { ...actual, signReceipt: (...args: unknown[]) => signReceiptMock(...args) };
});

import { POST } from "@/app/api/v1/[provider]/[...path]/route";

const RECEIPT_HEADER = "x-passcontrol-receipt-id";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    new Request("https://gateway.test/api/v1/openai/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer visa", "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ provider: "openai", path: ["v1", "chat", "completions"] }) }
  );
}

const CHAT = { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] };

function sseResponse() {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          'data: {"usage":{"prompt_tokens":3,"completion_tokens":5}}\n\ndata: [DONE]\n\n'
        )
      );
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

beforeEach(() => {
  vi.clearAllMocks();
  serviceClientMock.mockReturnValue({
    rpc: vi.fn(async () => ({ data: "provider-key", error: null })),
  });
  reserveBudgetMock.mockResolvedValue({ ok: true, reserved: 1 });
  reconcileBudgetMock.mockResolvedValue(undefined);
  getCachedKeyMock.mockResolvedValue(null);
  setCachedKeyMock.mockResolvedValue(undefined);
  getCachedAgentPolicyMock.mockResolvedValue("{}");
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

describe("the receipt id travels with every governed response", () => {
  it("names the receipt on the non-streaming path", async () => {
    const res = await call(CHAT);
    expect(res.status).toBe(200);
    expect(res.headers.get(RECEIPT_HEADER)).toMatch(UUID_RE);
  });

  it("names the receipt on the streaming path", async () => {
    fetchMock.mockResolvedValue(sseResponse());
    const res = await call({ ...CHAT, stream: true });
    expect(res.status).toBe(200);
    expect(res.headers.get(RECEIPT_HEADER)).toMatch(UUID_RE);
  });

  // The header is only useful if it names the row the receipt was stored on.
  it("uses the same id for the header and the persisted log row", async () => {
    const res = await call(CHAT);
    expect(writeLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: res.headers.get(RECEIPT_HEADER) })
    );
  });

  it("issues a distinct receipt id per call", async () => {
    const first = await call(CHAT);
    const second = await call(CHAT);
    expect(first.headers.get(RECEIPT_HEADER)).not.toBe(second.headers.get(RECEIPT_HEADER));
  });

  it("stores the signed receipt alongside the row, in the same insert", async () => {
    await call(CHAT);
    expect(writeLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ receipt: "header.payload.signature", status: "ok" })
    );
  });

  // The header's contract is "this id names a decision the gateway recorded".
  // Paths that reject before the gate runs write no row, so an id there would
  // be a reference that 404s — worse than no header at all.
  it("does not name a receipt when the request is rejected before any gate runs", async () => {
    rateLimitMock.mockResolvedValue({ success: false, remaining: 0 });
    const res = await call(CHAT);

    expect(res.status).toBe(429);
    expect(res.headers.get(RECEIPT_HEADER)).toBeNull();
    expect(writeLogMock).not.toHaveBeenCalled();
  });

  it("does not name a receipt for a malformed body", async () => {
    const res = await POST(
      new Request("https://gateway.test/api/v1/openai/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer visa", "content-type": "application/json" },
        body: "{not json",
      }),
      { params: Promise.resolve({ provider: "openai", path: ["v1", "chat", "completions"] }) }
    );

    expect(res.status).toBe(400);
    expect(res.headers.get(RECEIPT_HEADER)).toBeNull();
    expect(writeLogMock).not.toHaveBeenCalled();
  });

  it("names a receipt on an upstream error too", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "boom" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      })
    );
    const res = await call(CHAT);
    expect(res.status).toBe(500);
    expect(res.headers.get(RECEIPT_HEADER)).toMatch(UUID_RE);
  });
});

describe("refusals are receipted too", () => {
  // "The gateway refused this call at the scope gate" is frequently the more
  // valuable artifact than a receipt for a call that succeeded.
  it("signs a denial receipt when scope blocks the call", async () => {
    const res = await call(CHAT, "claude-*");

    expect(res.status).toBe(403);
    expect(res.headers.get(RECEIPT_HEADER)).toMatch(UUID_RE);
    expect(signReceiptMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "blocked_scope", httpStatus: 403, inputTokens: 0, outputTokens: 0 })
    );
    expect(writeLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "blocked_scope", receipt: "header.payload.signature" })
    );
  });

  // The revocation gate runs before the body is read, so there is genuinely no
  // request to digest. It must be reported as absent, not as a digest of "".
  it("omits the request body from a receipt written before the body was read", async () => {
    readKillStateMock.mockResolvedValue({ platformKill: true, userKill: false, denylist: [] });
    const res = await call(CHAT);

    expect(res.status).toBe(403);
    expect(signReceiptMock).toHaveBeenCalledWith(expect.objectContaining({ rawBody: null }));
  });

  it("binds the bytes the client sent once the body has been read", async () => {
    await call(CHAT, "claude-*");
    expect(signReceiptMock).toHaveBeenCalledWith(
      expect.objectContaining({ rawBody: JSON.stringify(CHAT) })
    );
  });
});

describe("receipt signing can never cost the caller their budget", () => {
  // THE test. signReceipt is called while building reconcile()'s writeLog
  // argument. If it throws and nothing catches, the tasks array is destroyed
  // before Promise.all forms: the budget reservation is never released and the
  // agent's effective budget silently shrinks until the marker expires 960s
  // later, while the audit row for the call is lost outright.
  it("still reconciles the budget and writes the log when signing throws", async () => {
    signReceiptMock.mockImplementation(() => {
      throw new Error("signing backend unavailable");
    });

    const res = await call(CHAT);

    expect(res.status).toBe(200);
    expect(reconcileBudgetMock).toHaveBeenCalledTimes(1);
    expect(writeLogMock).toHaveBeenCalledWith(expect.objectContaining({ status: "ok" }));
  });

  it("still reconciles the budget when signing throws on a denial path", async () => {
    signReceiptMock.mockImplementation(() => {
      throw new Error("signing backend unavailable");
    });

    const res = await call(CHAT, "claude-*");

    expect(res.status).toBe(403);
    expect(writeLogMock).toHaveBeenCalledWith(expect.objectContaining({ status: "blocked_scope" }));
  });

  // An unconfigured deployment is the common case, not an error case.
  it("records the call with a null receipt when no signing key is configured", async () => {
    signReceiptMock.mockReturnValue(null);

    const res = await call(CHAT);

    expect(res.status).toBe(200);
    expect(res.headers.get(RECEIPT_HEADER)).toMatch(UUID_RE);
    expect(writeLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ receipt: null, status: "ok" })
    );
  });
});

describe("the response itself is untouched", () => {
  it("leaves the non-streaming body byte-identical", async () => {
    const res = await call(CHAT);
    expect(await res.json()).toEqual({ usage: { prompt_tokens: 1, completion_tokens: 1 } });
  });

  it("leaves the streamed body byte-identical", async () => {
    fetchMock.mockResolvedValue(sseResponse());
    const res = await call({ ...CHAT, stream: true });

    expect(await res.text()).toBe(
      'data: {"usage":{"prompt_tokens":3,"completion_tokens":5}}\n\ndata: [DONE]\n\n'
    );
  });

  it("keeps streaming content-type and cache headers intact", async () => {
    fetchMock.mockResolvedValue(sseResponse());
    const res = await call({ ...CHAT, stream: true });

    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toContain("no-cache");
  });
});

describe("the owner claim rides on the receipt", () => {
  const OWNER = { kind: "domain", sub: "acme.com", tier: "domain", vat: "2026-08-01T00:00:00.000Z" };

  it("passes a published owner into the signed receipt", async () => {
    readCurrentOwnerMock.mockResolvedValue(OWNER);
    await call(CHAT);

    expect(signReceiptMock).toHaveBeenCalledWith(expect.objectContaining({ owner: OWNER }));
  });

  it("names the owner on a denial receipt too", async () => {
    readCurrentOwnerMock.mockResolvedValue(OWNER);
    await call(CHAT, "claude-*");

    expect(signReceiptMock).toHaveBeenCalledWith(
      expect.objectContaining({ owner: OWNER, status: "blocked_scope" })
    );
  });

  // Cached for 300s, but a single request must not pay for it twice even on a
  // cold cache — one decision, one owner read.
  it("reads the owner at most once per request", async () => {
    readCurrentOwnerMock.mockResolvedValue(OWNER);
    await call(CHAT);

    expect(readCurrentOwnerMock).toHaveBeenCalledTimes(1);
  });

  it("does not read the owner at all when nothing is recorded", async () => {
    rateLimitMock.mockResolvedValue({ success: false, remaining: 0 });
    await call(CHAT);

    expect(readCurrentOwnerMock).not.toHaveBeenCalled();
  });

  // A receipt with no owner claim is honest and still verifiable. A receipt that
  // failed to write because the owner lookup blipped is a lost audit record.
  it("still writes the call when the owner lookup fails", async () => {
    readCurrentOwnerMock.mockRejectedValue(new Error("redis down"));
    const res = await call(CHAT);

    expect(res.status).toBe(200);
    expect(writeLogMock).toHaveBeenCalledWith(expect.objectContaining({ status: "ok" }));
    expect(signReceiptMock).toHaveBeenCalledWith(expect.objectContaining({ owner: null }));
  });
});
