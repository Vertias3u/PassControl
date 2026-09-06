import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bytesToBase64url } from "@/lib/encoding";
import { loadInstanceSigner } from "@/lib/crypto/instanceKey";
import { RECEIPT_TYP, verifyCompactJws } from "@/lib/crypto/jws";
import { livePolicyRevision } from "@/lib/policy-shadow";
import { buildReceiptClaims, signReceipt } from "@/lib/receipt";

const RECEIPT = {
  receiptId: "receipt-policy-1",
  passportId: "passport-1",
  agentId: "agent-1",
  visaJti: "visa-1",
  provider: "openai",
  model: "gpt-4.1",
  method: "POST",
  path: "chat/completions",
  rawBody: JSON.stringify({ model: "gpt-4.1" }),
  inputTokens: 3,
  outputTokens: 5,
  costMicrocents: 100,
  status: "ok" as const,
  httpStatus: 200,
  startedAt: 1_700_000_000_000,
  latencyMs: 12,
};

const LIVE = {
  policy: { deny: [{ provider: "openai", models: ["gpt-5*"] }] },
  scopes: [{ provider: "openai", models: ["gpt-4.1"] }],
  budget: { tokens: 1_000, microcents: 2_000_000 },
  policyFailClosed: false,
};

beforeEach(() => {
  process.env.INSTANCE_SIGNING_KEY = bytesToBase64url(new Uint8Array(32).fill(7));
  process.env.PASSCONTROL_ISSUER = "https://gw.example.com";
});

afterEach(() => {
  delete process.env.INSTANCE_SIGNING_KEY;
  delete process.env.PASSCONTROL_ISSUER;
});

describe("live policy receipt revisions", () => {
  it("revises the whole effective rule set, not only the policy JSON column", () => {
    const original = livePolicyRevision(LIVE);

    expect(original).toBe(livePolicyRevision({
      policyFailClosed: false,
      budget: { microcents: 2_000_000, tokens: 1_000 },
      scopes: [{ models: ["gpt-4.1"], provider: "openai" }],
      policy: { deny: [{ models: ["gpt-5*"], provider: "openai" }] },
    }));
    expect(livePolicyRevision({ ...LIVE, policy: {} })).not.toBe(original);
    expect(livePolicyRevision({
      ...LIVE,
      scopes: [{ provider: "openai", models: ["gpt-4.1", "gpt-4o"] }],
    })).not.toBe(original);
    expect(livePolicyRevision({
      ...LIVE,
      budget: { ...LIVE.budget, tokens: 2_000 },
    })).not.toBe(original);
    expect(livePolicyRevision({
      ...LIVE,
      budget: { ...LIVE.budget, microcents: 3_000_000 },
    })).not.toBe(original);
    expect(livePolicyRevision({ ...LIVE, policyFailClosed: true })).not.toBe(original);
  });

  it("appends the revision claim without making it mandatory for historical receipts", () => {
    const revision = livePolicyRevision(LIVE);
    const historical = buildReceiptClaims(RECEIPT);
    const current = buildReceiptClaims({ ...RECEIPT, policyRevision: revision });

    expect(historical).not.toHaveProperty("pol");
    expect(current).toHaveProperty("pol", revision);
    expect(current.ver).toBe(historical.ver);
  });

  it("freezes the revision inside each signature when later policy changes", () => {
    const firstRevision = livePolicyRevision(LIVE);
    const laterRevision = livePolicyRevision({
      ...LIVE,
      budget: { ...LIVE.budget, tokens: 2_000 },
    });
    const first = signReceipt({ ...RECEIPT, policyRevision: firstRevision })!;
    const later = signReceipt({
      ...RECEIPT,
      receiptId: "receipt-policy-2",
      policyRevision: laterRevision,
    })!;
    const signer = loadInstanceSigner()!;

    expect(verifyCompactJws(first, signer.publicKey, { typ: RECEIPT_TYP })?.claims.pol)
      .toBe(firstRevision);
    expect(verifyCompactJws(later, signer.publicKey, { typ: RECEIPT_TYP })?.claims.pol)
      .toBe(laterRevision);
    expect(first).not.toBe(later);
  });
});
