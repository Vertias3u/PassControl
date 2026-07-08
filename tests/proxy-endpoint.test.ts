import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  verifyVisaMock,
  serviceClientMock,
  reserveBudgetMock,
  reconcileBudgetMock,
  getCachedKeyMock,
  setCachedKeyMock,
  readKillStateMock,
  isSuspendedMock,
  writeLogMock,
  mirrorSpendMock,
  rateLimitMock,
  fetchMock,
} = vi.hoisted(() => {
  return {
    verifyVisaMock: vi.fn(),
    serviceClientMock: vi.fn(),
    reserveBudgetMock: vi.fn(),
    reconcileBudgetMock: vi.fn(),
    getCachedKeyMock: vi.fn(),
    setCachedKeyMock: vi.fn(),
    readKillStateMock: vi.fn(),
    isSuspendedMock: vi.fn(),
    writeLogMock: vi.fn(),
    mirrorSpendMock: vi.fn(),
    rateLimitMock: vi.fn(),
    fetchMock: vi.fn(),
  };
});

vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));
vi.mock("@/lib/auth/visa", () => ({
  extractVisaToken: (headers: Headers) => headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "",
  verifyVisa: (...args: unknown[]) => verifyVisaMock(...args),
}));
vi.mock("@/lib/state/killswitch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/state/killswitch")>();
  return {
    ...actual,
    readKillState: (...args: unknown[]) => readKillStateMock(...args),
  };
});
vi.mock("@/lib/state/redis", () => ({
  isSuspended: (...args: unknown[]) => isSuspendedMock(...args),
  reserveBudget: (...args: unknown[]) => reserveBudgetMock(...args),
  reconcileBudget: (...args: unknown[]) => reconcileBudgetMock(...args),
  getCachedKey: (...args: unknown[]) => getCachedKeyMock(...args),
  setCachedKey: (...args: unknown[]) => setCachedKeyMock(...args),
  seedSpent: vi.fn(),
}));
vi.mock("@/lib/supabase", () => ({ serviceClient: () => serviceClientMock() }));
vi.mock("@/lib/crypto/aesgcm", () => ({ seal: async () => "sealed", open: async (v: string) => v }));
vi.mock("@/lib/log", () => ({
  writeLog: (...args: unknown[]) => writeLogMock(...args),
  mirrorSpend: (...args: unknown[]) => mirrorSpendMock(...args),
}));
vi.mock("@/lib/ratelimit", () => ({ rateLimit: (...args: unknown[]) => rateLimitMock(...args) }));

import { POST, GET } from "@/app/api/v1/[provider]/[...path]/route";

const baseClaims = {
  sub: "passport-id",
  agid: "agent-id",
  uid: "user-id",
  jti: "jti-1",
  bt: null,
  bc: null,
  st: 0,
  sc: 0,
  ver: 1,
};

function req(body: unknown) {
  return new Request("https://gateway.test/api/v1/openai/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer visa", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function callProxy(provider: string, path: string[], model: string) {
  verifyVisaMock.mockResolvedValue({
    ...baseClaims,
    scope: [{ provider, models: [model] }],
  });
  return POST(req({ model, max_tokens: 10, messages: [{ role: "user", content: "hi" }] }), {
    params: Promise.resolve({ provider, path }),
  });
}

// A GET with no body/model (e.g. /v1/models). Scope is [] on purpose — the model
// listing endpoint must NOT depend on the per-model scope.
function getReq() {
  return new Request("https://gateway.test/api/v1/openai/v1/models", {
    method: "GET",
    headers: { authorization: "Bearer visa" },
  });
}
async function getProxy(provider: string, path: string[]) {
  verifyVisaMock.mockResolvedValue({ ...baseClaims, scope: [{ provider, models: ["nothing-*"] }] });
  return GET(getReq(), { params: Promise.resolve({ provider, path }) });
}

beforeEach(() => {
  verifyVisaMock.mockReset();
  serviceClientMock.mockReset();
  reserveBudgetMock.mockReset();
  reconcileBudgetMock.mockReset();
  getCachedKeyMock.mockReset();
  setCachedKeyMock.mockReset();
  readKillStateMock.mockReset();
  isSuspendedMock.mockReset();
  writeLogMock.mockReset();
  mirrorSpendMock.mockReset();
  rateLimitMock.mockReset();
  fetchMock.mockReset();

  serviceClientMock.mockReturnValue({
    rpc: vi.fn(async () => ({ data: "provider-key", error: null })),
  });
  reserveBudgetMock.mockResolvedValue({ ok: true, reserved: 1 });
  reconcileBudgetMock.mockResolvedValue(undefined);
  getCachedKeyMock.mockResolvedValue(null);
  setCachedKeyMock.mockResolvedValue(undefined);
  readKillStateMock.mockResolvedValue({ platformKill: false, tenantKill: false, denylist: [] });
  isSuspendedMock.mockResolvedValue(false);
  writeLogMock.mockResolvedValue(undefined);
  mirrorSpendMock.mockResolvedValue(undefined);
  rateLimitMock.mockResolvedValue({ success: true, remaining: 1 });
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  );
  vi.stubGlobal("fetch", fetchMock);
});

describe("proxy endpoint allowlist", () => {
  it("blocks an OpenAI chat-scoped visa from /v1/files", async () => {
    const res = await callProxy("openai", ["v1", "files"], "gpt-4o-mini");

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "blocked_endpoint" });
    expect(writeLogMock).toHaveBeenCalledWith(expect.objectContaining({ status: "blocked_endpoint" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(reserveBudgetMock).not.toHaveBeenCalled();
  });

  it("blocks an Anthropic chat-scoped visa from a non-messages endpoint", async () => {
    const res = await callProxy("anthropic", ["v1", "complete"], "claude-haiku-4-5");

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "blocked_endpoint" });
    expect(writeLogMock).toHaveBeenCalledWith(expect.objectContaining({ status: "blocked_endpoint" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(reserveBudgetMock).not.toHaveBeenCalled();
  });

  it("allows the OpenAI chat-completions endpoint", async () => {
    const res = await callProxy("openai", ["v1", "chat", "completions"], "gpt-4o-mini");

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/chat/completions",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("allows the Anthropic messages endpoint", async () => {
    const res = await callProxy("anthropic", ["v1", "messages"], "claude-haiku-4-5");

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/messages",
      expect.objectContaining({ method: "POST" })
    );
  });

  it.each([
    ["groq", ["v1", "chat", "completions"], "llama-3.3-70b-versatile", "https://api.groq.com/openai/v1/chat/completions"],
    ["mistral", ["v1", "chat", "completions"], "mistral-small-latest", "https://api.mistral.ai/v1/chat/completions"],
    ["together", ["v1", "chat", "completions"], "openai/gpt-oss-20b", "https://api.together.ai/v1/chat/completions"],
    ["deepseek", ["chat", "completions"], "deepseek-v4-flash", "https://api.deepseek.com/chat/completions"],
  ])("allows %s chat on its fixed upstream host", async (provider, path, model, upstream) => {
    const res = await callProxy(provider, path, model);

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(upstream, expect.objectContaining({ method: "POST" }));
  });

  it.each(["groq", "mistral", "together", "deepseek"])(
    "blocks %s from non-allowlisted file endpoints",
    async (provider) => {
      const res = await callProxy(provider, ["v1", "files"], "gpt-oss-20b");

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "blocked_endpoint" });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  // ── Hardening: bypass attempts + method-aware model listing ──────────────────

  it("blocks a suffix-appended chat path (exact match, not prefix)", async () => {
    // /v1/chat/completions/x must NOT be treated as the allowed chat endpoint.
    const res = await callProxy("openai", ["v1", "chat", "completions", "x"], "gpt-4o-mini");

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "blocked_endpoint" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks a path-traversal bypass toward another endpoint", async () => {
    // /v1/chat/completions/../files is rejected by the traversal guard (400)
    // before it can be reshaped — it never reaches upstream either way.
    const res = await callProxy("openai", ["v1", "chat", "completions", "..", "files"], "gpt-4o-mini");

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_path" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows GET /v1/models without a per-model scope match", async () => {
    // Scope is deliberately unrelated ("nothing-*"); the model-listing endpoint
    // must be reachable anyway (it carries no model), gated only by GET allowlist.
    const res = await getProxy("openai", ["v1", "models"]);

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/models",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("blocks POST to /v1/models (models is GET-only)", async () => {
    const res = await callProxy("openai", ["v1", "models"], "gpt-4o-mini");

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "blocked_endpoint" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
