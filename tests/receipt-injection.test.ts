// The injection guard on the signed receipt (plans/injection-guard.md §5; owner,
// 2026-10-30: "Additive field"): an `inj` claim on a call whose request carried tool
// output with injection tells, `{ d: detector, n: count, f: families }`.
//
// Additive like `ctx`/`prev`/`why`: present only when something was found, so every
// other receipt is byte-identical to before, and `ver` does not move, so every verifier
// already in the field keeps verifying. It names kinds only: never a path, an HMAC or a
// word of the block, and the agent never receives a receipt (only its id), so it cannot
// learn from one which wording got through.
import { beforeEach, describe, expect, it } from "vitest";

import { INJECTION_DETECTOR } from "@/cli/injection-scan.mjs";
import { bytesToBase64url } from "@/lib/encoding";
import { injectionReceiptClaim, type InjectionFinding } from "@/lib/injection-guard";
import { buildReceiptClaims, signReceipt } from "@/lib/receipt";
import { verifyReceipt } from "@/sdk/verify";
import { GET as jwksRoute } from "@/app/.well-known/jwks.json/route";

const ISSUER = "https://gw.example.com";
const INPUT = {
  receiptId: "11111111-2222-4333-8444-555555555555",
  passportId: "cGFzc3BvcnQ",
  agentId: "agent-1",
  visaJti: "visa-1",
  provider: "anthropic",
  model: "claude-sonnet-5",
  method: "POST",
  path: "v1/messages",
  rawBody: "{}",
  inputTokens: 1,
  outputTokens: 1,
  costMicrocents: 1,
  status: "ok" as const,
  httpStatus: 200,
  startedAt: 1_700_000_000_000,
  latencyMs: 1,
};

const finding = (families: InjectionFinding["families"], severity: "high" | "low", hmac: string): InjectionFinding => ({
  path: "messages[3].content[0].content",
  source: "tool_result",
  families,
  severity,
  contentHmac: hmac,
});

beforeEach(() => {
  process.env.INSTANCE_SIGNING_KEY = bytesToBase64url(new Uint8Array(32).fill(7));
  process.env.PASSCONTROL_ISSUER = ISSUER;
});

describe("injectionReceiptClaim", () => {
  it("counts every block found in this request, and names their families once, in the guard's order", () => {
    const claim = injectionReceiptClaim([
      finding(["exfil_directive", "hidden_text"], "high", "h1"),
      finding(["instruction_override", "exfil_directive"], "high", "h2"),
      finding(["authority_claim"], "low", "h3"),
    ]);
    expect(claim).toEqual({
      d: INJECTION_DETECTOR,
      n: 3,
      f: ["instruction_override", "exfil_directive", "authority_claim", "hidden_text"],
    });
    // Kinds only: no path, no HMAC.
    expect(JSON.stringify(claim)).not.toMatch(/messages|h1|h2|h3/);
  });

  it("is absent when nothing was found", () => {
    expect(injectionReceiptClaim([])).toBeUndefined();
    expect(injectionReceiptClaim(null)).toBeUndefined();
  });
});

describe("the inj claim", () => {
  const inj = { d: INJECTION_DETECTOR, n: 1, f: ["instruction_override"] };

  it("is carried when the request had findings", () => {
    expect(buildReceiptClaims({ ...INPUT, injection: inj }).inj).toEqual(inj);
  });

  it.each([undefined, null])("is absent otherwise (%s): the receipt is byte-identical to before", (injection) => {
    const withNone = buildReceiptClaims({ ...INPUT, injection });
    expect("inj" in withNone).toBe(false);
    expect({ ...withNone, iat: 0 }).toEqual({ ...buildReceiptClaims(INPUT), iat: 0 });
  });

  it("does not move ver", () => {
    expect(buildReceiptClaims({ ...INPUT, injection: inj }).ver).toBe(buildReceiptClaims(INPUT).ver);
  });

  it("verifies with the published SDK, which reads it and does not refuse it", async () => {
    const receipt = signReceipt({ ...INPUT, injection: inj })!;
    const fetch = (async () => {
      const res = await jwksRoute();
      const body = await res.json();
      return { ok: true, status: 200, json: async () => body };
    }) as never;
    const result = await verifyReceipt(receipt, { trustedIssuers: [ISSUER], fetch });
    expect(result).toMatchObject({ ok: true });
    expect((result as { claims: Record<string, unknown> }).claims.inj).toEqual(inj);
  });
});
