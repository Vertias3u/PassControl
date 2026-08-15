import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// The keyless demo provider forks out of `handle` before the real proxy's receipt
// machinery starts, and re-implements the governance pipeline on its own. That
// fork is why it silently shipped without receipts: every guard in
// tests/proxy-receipt.test.ts drives the OpenAI path and never touches this code.
//
// It matters more than a normally-missing feature would. The demo is the
// "try it, no key, no account" surface — the only place a stranger can reach
// without credentials, and therefore the only place most people will ever see a
// receipt at all. The reply text is synthesized, but everything a receipt
// actually attests to — which agent, which verdict, which gate, what it cost —
// is real here, because the demo runs the real pipeline.
const {
  verifyVisaMock,
  serviceClientMock,
  reserveBudgetMock,
  reconcileBudgetMock,
  getCachedAgentPolicyMock,
  readKillStateMock,
  isSuspendedMock,
  writeLogMock,
  mirrorSpendMock,
  rateLimitMock,
  signReceiptMock,
  readCurrentOwnerMock,
} = vi.hoisted(() => ({
  verifyVisaMock: vi.fn(),
  serviceClientMock: vi.fn(),
  reserveBudgetMock: vi.fn(),
  reconcileBudgetMock: vi.fn(),
  getCachedAgentPolicyMock: vi.fn(),
  readKillStateMock: vi.fn(),
  isSuspendedMock: vi.fn(),
  writeLogMock: vi.fn(),
  mirrorSpendMock: vi.fn(),
  rateLimitMock: vi.fn(),
  signReceiptMock: vi.fn(),
  readCurrentOwnerMock: vi.fn(),
}));

// waitUntil must actually run the work here: every receipt on this path is
// written inside it, so a no-op stub would make all of these pass vacuously.
vi.mock("@vercel/functions", () => ({ waitUntil: (p: unknown) => p }));
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
  getCachedKey: vi.fn(),
  setCachedKey: vi.fn(),
  getCachedAgentPolicy: (...args: unknown[]) => getCachedAgentPolicyMock(...args),
  setCachedAgentPolicy: vi.fn(),
  seedSpent: vi.fn(),
}));
vi.mock("@/lib/supabase", () => ({ serviceClient: () => serviceClientMock() }));
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
const DEMO = { model: "demo-1", messages: [{ role: "user", content: "hi" }] };

const previousDemoFlag = process.env.PASSCONTROL_DEMO;
process.env.PASSCONTROL_DEMO = "1";
afterAll(() => {
  if (previousDemoFlag === undefined) delete process.env.PASSCONTROL_DEMO;
  else process.env.PASSCONTROL_DEMO = previousDemoFlag;
});

function demoCall(body: Record<string, unknown> = DEMO, allowedModel = "demo-1") {
  verifyVisaMock.mockResolvedValue({
    sub: "passport-id",
    agid: "agent-id",
    uid: "user-id",
    jti: "visa-jti-1",
    bt: null,
    bc: null,
    st: 0,
    sc: 0,
    ver: 1,
    scope: [{ provider: "demo", models: [allowedModel] }],
  });
  return POST(
    new Request("https://gateway.test/api/v1/demo/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer visa", "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ provider: "demo", path: ["chat", "completions"] }) }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  serviceClientMock.mockReturnValue({ rpc: vi.fn(async () => ({ data: null, error: null })) });
  reserveBudgetMock.mockResolvedValue({ ok: true, reserved: 1 });
  reconcileBudgetMock.mockResolvedValue(undefined);
  getCachedAgentPolicyMock.mockResolvedValue(JSON.stringify({ p: {}, s: null }));
  readKillStateMock.mockResolvedValue({ platformKill: false, userKill: false, denylist: [] });
  isSuspendedMock.mockResolvedValue(false);
  writeLogMock.mockResolvedValue(undefined);
  mirrorSpendMock.mockResolvedValue(undefined);
  rateLimitMock.mockResolvedValue({ success: true, remaining: 1 });
  signReceiptMock.mockReturnValue("header.payload.signature");
  readCurrentOwnerMock.mockResolvedValue(null);
});

describe("a demo call produces a receipt like any other governed call", () => {
  it("names the receipt in the response header", async () => {
    const res = await demoCall();
    expect(res.status).toBe(200);
    expect(res.headers.get(RECEIPT_HEADER)).toMatch(UUID_RE);
  });

  it("names the receipt on the streaming path too", async () => {
    const res = await demoCall({ ...DEMO, stream: true });
    expect(res.status).toBe(200);
    expect(res.headers.get(RECEIPT_HEADER)).toMatch(UUID_RE);
  });

  // The header is worthless if it does not name the row the receipt is stored
  // on — the id is what the caller passes to /api/control/v1/receipts/{id}.
  it("stores the receipt on the row the header names", async () => {
    const res = await demoCall();
    expect(writeLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: res.headers.get(RECEIPT_HEADER),
        receipt: "header.payload.signature",
      })
    );
  });

  it("signs it as the demo provider, with the real usage and cost", async () => {
    await demoCall();
    const signed = signReceiptMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(signed.provider).toBe("demo");
    expect(signed.status).toBe("ok");
    expect(signed.httpStatus).toBe(200);
    expect(Number(signed.outputTokens)).toBeGreaterThan(0);
  });

  it("issues a distinct id per call", async () => {
    const a = await demoCall();
    const b = await demoCall();
    expect(a.headers.get(RECEIPT_HEADER)).not.toBe(b.headers.get(RECEIPT_HEADER));
  });

  it("carries the owner claim when one is published", async () => {
    readCurrentOwnerMock.mockResolvedValue({ kind: "domain", subject: "acme.com", tier: "domain" });
    await demoCall();
    const signed = signReceiptMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(signed.owner).toMatchObject({ subject: "acme.com", tier: "domain" });
  });
});

describe("a demo refusal is signed too", () => {
  it("receipts a scope block", async () => {
    const res = await demoCall(DEMO, "some-other-model");
    expect(res.status).toBe(403);
    expect(res.headers.get(RECEIPT_HEADER)).toMatch(UUID_RE);

    const signed = signReceiptMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(signed.status).toBe("blocked_scope");
    expect(signed.httpStatus).toBe(403);
    expect(writeLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: res.headers.get(RECEIPT_HEADER) })
    );
  });

  it("receipts a budget block", async () => {
    reserveBudgetMock.mockResolvedValue({ ok: false, reason: "over_budget", reserved: 0 });
    const res = await demoCall();
    expect(res.status).toBe(402);
    expect(res.headers.get(RECEIPT_HEADER)).toMatch(UUID_RE);
    expect(signReceiptMock.mock.calls[0]![0]).toMatchObject({ status: "blocked_budget" });
  });
});

describe("the header only promises ids that resolve", () => {
  // A rate-limited call is rejected before any gate runs and writes no row.
  // Advertising an id there hands the caller a reference that 404s.
  it("omits the receipt id when the request is rate limited", async () => {
    rateLimitMock.mockResolvedValue({ success: false, remaining: 0 });
    const res = await demoCall();
    expect(res.status).toBe(429);
    expect(res.headers.get(RECEIPT_HEADER)).toBeNull();
    expect(writeLogMock).not.toHaveBeenCalled();
  });

  it("omits it when the visa is missing", async () => {
    const res = await POST(
      new Request("https://gateway.test/api/v1/demo/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(DEMO),
      }),
      { params: Promise.resolve({ provider: "demo", path: ["chat", "completions"] }) }
    );
    expect(res.status).toBe(401);
    expect(res.headers.get(RECEIPT_HEADER)).toBeNull();
  });
});

// The bug this file's sibling already caught once on the real path, re-armed
// here because the demo path is a separate implementation that would not have
// inherited the fix.
describe("signing can never cost the caller their budget", () => {
  it("still reconciles the budget and writes the log when signing throws", async () => {
    signReceiptMock.mockImplementation(() => {
      throw new Error("signing exploded");
    });

    const res = await demoCall();

    expect(res.status).toBe(200);
    // A leaked reservation silently shrinks the agent's budget until the marker
    // expires ~960s later — a signing bug must not be able to cause that.
    expect(reconcileBudgetMock).toHaveBeenCalledTimes(1);
    expect(writeLogMock).toHaveBeenCalledWith(expect.objectContaining({ receipt: null }));
    expect(mirrorSpendMock).toHaveBeenCalledTimes(1);
  });

  it("still writes the audit row for a block when signing throws", async () => {
    signReceiptMock.mockImplementation(() => {
      throw new Error("signing exploded");
    });

    const res = await demoCall(DEMO, "some-other-model");

    expect(res.status).toBe(403);
    expect(writeLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "blocked_scope", receipt: null })
    );
  });
});
