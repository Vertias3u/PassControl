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

import { GET, POST } from "@/app/api/v1/[provider]/[...path]/route";

const GATEWAY = "https://gateway.test";
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

function paramsFromSdkUrl(rawUrl: string) {
  const segments = new URL(rawUrl).pathname.split("/").filter(Boolean);
  expect(segments.slice(0, 2)).toEqual(["api", "v1"]);
  return {
    provider: segments[2] ?? "",
    path: segments.slice(3),
  };
}

function sdkUrl(provider: string, sdkPath: string) {
  return `${GATEWAY}/api/v1/${provider}/${sdkPath}`;
}

async function postThroughSdkShape(provider: string, sdkPath: string, model: string) {
  const url = sdkUrl(provider, sdkPath);
  verifyVisaMock.mockResolvedValue({
    ...baseClaims,
    scope: [{ provider, models: [model] }],
  });
  return POST(
    new Request(url, {
      method: "POST",
      headers: { authorization: "Bearer visa", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
    }),
    { params: Promise.resolve(paramsFromSdkUrl(url)) }
  );
}

async function getThroughSdkShape(provider: string, sdkPath: string) {
  const url = sdkUrl(provider, sdkPath);
  verifyVisaMock.mockResolvedValue({
    ...baseClaims,
    scope: [{ provider, models: ["unrelated-*"] }],
  });
  return GET(
    new Request(url, {
      method: "GET",
      headers: { authorization: "Bearer visa" },
    }),
    { params: Promise.resolve(paramsFromSdkUrl(url)) }
  );
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

describe("proxy SDK path-shape compatibility", () => {
  it.each([
    ["openai", "chat/completions", "gpt-4o-mini", "https://api.openai.com/v1/chat/completions"],
    ["groq", "chat/completions", "llama-3.3-70b-versatile", "https://api.groq.com/openai/v1/chat/completions"],
    ["mistral", "chat/completions", "mistral-small-latest", "https://api.mistral.ai/v1/chat/completions"],
    ["together", "chat/completions", "openai/gpt-oss-20b", "https://api.together.ai/v1/chat/completions"],
    ["anthropic", "v1/messages", "claude-haiku-4-5", "https://api.anthropic.com/v1/messages"],
    ["deepseek", "chat/completions", "deepseek-v4-flash", "https://api.deepseek.com/chat/completions"],
  ])(
    "allows %s SDK chat path and forwards to canonical upstream",
    async (provider, sdkPath, model, upstream) => {
      const res = await postThroughSdkShape(provider, sdkPath, model);

      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledWith(upstream, expect.objectContaining({ method: "POST" }));
      expect(writeLogMock).not.toHaveBeenCalledWith(expect.objectContaining({ status: "blocked_endpoint" }));
    }
  );

  it.each([
    ["openai", "https://api.openai.com/v1/models"],
    ["groq", "https://api.groq.com/openai/v1/models"],
    ["mistral", "https://api.mistral.ai/v1/models"],
    ["together", "https://api.together.ai/v1/models"],
  ])("allows %s SDK model-listing path and forwards to canonical upstream", async (provider, upstream) => {
    const res = await getThroughSdkShape(provider, "models");

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(upstream, expect.objectContaining({ method: "GET" }));
    expect(writeLogMock).not.toHaveBeenCalledWith(expect.objectContaining({ status: "blocked_endpoint" }));
  });
});
