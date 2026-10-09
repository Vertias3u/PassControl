// Lineage on the signed receipt (sprint Q5, D1): the session and sub-agent a call
// DECLARED, as an additive `ctx` claim.
//
// `src: "declared"` is the whole point of the claim's shape. Every value in it came
// from a header the client chose, so it must never read as passport-proven (trust
// boundary 1). Additive like `cr`/`cw`/`unp`: present only when something was
// declared, so a receipt for a call without lineage is byte-identical to before,
// and `ver` does not move, so every verifier already in the field keeps working.
import { beforeEach, describe, expect, it } from "vitest";

import { bytesToBase64url } from "@/lib/encoding";
import { RECEIPT_VER, buildReceiptClaims } from "@/lib/receipt";

const INPUT = {
  receiptId: "receipt-1",
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

beforeEach(() => {
  process.env.INSTANCE_SIGNING_KEY = bytesToBase64url(new Uint8Array(32).fill(7));
  process.env.PASSCONTROL_ISSUER = "https://gw.example.com";
});

describe("the ctx claim", () => {
  it("carries a nested sub-agent's declared lineage, marked declared", () => {
    const claims = buildReceiptClaims({
      ...INPUT,
      lineage: { kind: "claude-code", session: "s-1", agent: "a-2", parent: "a-1" },
    });
    expect(claims.ctx).toEqual({ src: "declared", cli: "claude-code", ses: "s-1", agt: "a-2", par: "a-1" });
  });

  it("omits agt and par for the main agent rather than writing null", () => {
    const claims = buildReceiptClaims({
      ...INPUT,
      lineage: { kind: "codex", session: "s-1", agent: null, parent: null },
    });
    expect(claims.ctx).toEqual({ src: "declared", cli: "codex", ses: "s-1" });
  });

  it("records the sidecar's run id as its own source", () => {
    const claims = buildReceiptClaims({
      ...INPUT,
      lineage: { kind: "sidecar", session: "run-1", agent: null, parent: null },
    });
    expect(claims.ctx).toEqual({ src: "declared", cli: "sidecar", ses: "run-1" });
  });

  it.each([undefined, null])("is absent when nothing was declared (%s): the receipt is byte-identical to before", (lineage) => {
    const withNone = buildReceiptClaims({ ...INPUT, lineage });
    const before = buildReceiptClaims(INPUT);
    expect("ctx" in withNone).toBe(false);
    expect({ ...withNone, iat: 0 }).toEqual({ ...before, iat: 0 });
  });

  it("does not move ver on either door", () => {
    const lineage = { kind: "claude-code" as const, session: "s-1", agent: null, parent: null };
    expect(buildReceiptClaims({ ...INPUT, lineage }).ver).toBe(1);
    const direct = buildReceiptClaims({
      ...INPUT,
      passportId: undefined,
      visaJti: undefined,
      authMethod: "direct_key",
      agentAccessKeyId: "key-1",
      credentialUseId: "use-1",
      lineage,
    } as never);
    expect(direct.ver).toBe(RECEIPT_VER);
    expect(direct.ctx).toEqual({ src: "declared", cli: "claude-code", ses: "s-1" });
  });

  it("never puts lineage into the identity claims", () => {
    const claims = buildReceiptClaims({
      ...INPUT,
      lineage: { kind: "claude-code", session: "s-1", agent: "a-2", parent: null },
    });
    expect(claims.sub).toBe(INPUT.passportId);
    expect(claims.agid).toBe(INPUT.agentId);
    expect("auth" in claims).toBe(false);
  });
});
