// A service call's receipt: additive claims only, so every verifier already in
// the field keeps verifying it (plans/any-api-credentials.md §7, decision 7).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bytesToBase64url } from "@/lib/encoding";
import { loadInstanceSigner } from "@/lib/crypto/instanceKey";
import { buildReceiptClaims, signReceipt } from "@/lib/receipt";
import { verifyReceipt } from "@/sdk/verify";

const SEED = bytesToBase64url(new Uint8Array(32).fill(9));
const ISSUER = "https://gw.example.com";

const SERVICE_INPUT = {
  receiptId: "receipt-svc-1",
  passportId: "cGFzc3BvcnQ",
  agentId: "agent-1",
  visaJti: "visa-1",
  provider: "svc:github",
  method: "GET",
  // The raw path is signed (T10): receipts are handed only to the tenant.
  path: "repos/acme/web/issues",
  rawBody: null,
  inputTokens: 0,
  outputTokens: 0,
  costMicrocents: 0,
  unpriced: true,
  callClass: "svc" as const,
  status: "ok" as const,
  httpStatus: 200,
  startedAt: 1_700_000_000_000,
  latencyMs: 80,
  policyRevision: "0123456789abcdef",
};

beforeEach(() => {
  process.env.INSTANCE_SIGNING_KEY = SEED;
  process.env.PASSCONTROL_ISSUER = ISSUER;
  delete process.env.INSTANCE_SIGNING_KEY_PREV;
});

describe("service call receipts", () => {
  it("say what kind of call they describe, and that it has no price", () => {
    const claims = buildReceiptClaims(SERVICE_INPUT) as Record<string, unknown>;
    expect(claims.cls).toBe("svc");
    expect(claims.unp).toBe(true);
    expect(claims.prov).toBe("svc:github");
    expect(claims.mdl).toBeNull();
    expect(claims.path).toBe("repos/acme/web/issues");
    // `cost` stays a number: sdk/verify.ts types it as required.
    expect(claims.cost).toBe(0);
    expect(claims.ver).toBe(1);
    expect(claims.pol).toBe("0123456789abcdef");
  });

  it("leave an LLM receipt byte-identical: no cls claim at all", () => {
    const { callClass: _omit, unpriced: _u, ...llm } = SERVICE_INPUT;
    const claims = buildReceiptClaims({ ...llm, provider: "openai", model: "gpt-4o-mini" }) as Record<
      string,
      unknown
    >;
    expect(claims).not.toHaveProperty("cls");
  });

  it("verify with the published SDK verifier, unchanged", async () => {
    const jws = signReceipt(SERVICE_INPUT);
    expect(jws).toBeTruthy();
    const signer = loadInstanceSigner()!;
    const fetchJwks = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            keys: [{ kty: "OKP", crv: "Ed25519", x: bytesToBase64url(signer.publicKey), kid: signer.kid }],
          }),
          { status: 200 }
        )
    );
    const result = await verifyReceipt(jws!, {
      trustedIssuers: [ISSUER],
      fetch: fetchJwks as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect((result.claims as unknown as Record<string, unknown>).cls).toBe("svc");
  });
});
