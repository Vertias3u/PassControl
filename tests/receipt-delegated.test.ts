// Bet D slice 5 (plans/delegation-design.md §8, P2.2): a worker's receipt. It must
// never read as signed by the parent's passport (trust boundary 1), so it carries
// its own `auth.kind` AND a new version: a verifier that predates delegation refuses
// it as too new rather than rendering it as a passport receipt.
import { describe, expect, it } from "vitest";
import { buildReceiptClaims, RECEIPT_VER } from "@/lib/receipt";
import { describeReceiptAuthentication } from "@/lib/verify/receipt-view";
import { RECEIPT_PROTOCOL } from "@/cli/protocols.mjs";

const base = {
  receiptId: "r1",
  agentId: "agent-1",
  provider: "openai",
  model: "gpt-4o-mini",
  method: "POST",
  path: "v1/chat/completions",
  rawBody: "{}",
  inputTokens: 1,
  outputTokens: 1,
  costMicrocents: 10,
  status: "ok" as const,
  httpStatus: 200,
  startedAt: 0,
  latencyMs: 1,
};
const delegation = { actor: "W".repeat(43), jti: "jti-0000000000000002", depth: 2, chainHash: "c".repeat(43) };

describe("a worker's receipt", () => {
  it("is ver 3, names the root passport as sub, and the worker in auth", () => {
    const claims = buildReceiptClaims({ ...base, authMethod: "delegated", passportId: "root", visaJti: "visa-1", delegation });
    expect(RECEIPT_PROTOCOL.maximum).toBe(3);
    expect(claims).toMatchObject({
      ver: 3,
      sub: "root",
      vjti: "visa-1",
      auth: { kind: "delegated", act: delegation.actor, dlg: delegation.jti, dep: 2, ch: delegation.chainHash },
    });
    expect((claims.auth as Record<string, unknown>).prf).toBeUndefined();
  });

  it("says when the worker's per-request proof was enforced", () => {
    const claims = buildReceiptClaims({ ...base, authMethod: "delegated_proof_per_request", passportId: "root", visaJti: "visa-1", delegation });
    expect(claims.auth).toMatchObject({ kind: "delegated", prf: true });
  });

  it("leaves the other receipts' versions where they were", () => {
    expect(buildReceiptClaims({ ...base, passportId: "root", visaJti: "v" }).ver).toBe(1);
    expect(buildReceiptClaims({ ...base, authMethod: "direct_key", agentAccessKeyId: "k", credentialUseId: "u" }).ver).toBe(2);
    expect(RECEIPT_VER).toBe(3);
  });

  it("is never rendered as the parent's passport", () => {
    const view = describeReceiptAuthentication({
      sub: "root",
      agid: "agent-1",
      auth: { kind: "delegated", act: delegation.actor, dlg: delegation.jti, dep: 2, ch: delegation.chainHash },
    } as never);
    expect(view.label).toMatch(/worker|delegat/i);
    expect(view.label).not.toBe("Passport verified");
    expect(view.subject).toBe(delegation.actor);
    // The delegation id is labelled as one, never as a Direct Agent Key.
    expect(view.keyId).toBe(delegation.jti);
    expect(view.keyIdLabel).toBe("Delegation");
  });

  it("a Direct Agent Key receipt keeps its own key label", () => {
    const view = describeReceiptAuthentication({ sub: "a", agid: "a", auth: { kind: "direct_key", kid: "k1", use: "u" } } as never);
    expect(view.keyIdLabel).toBe("Direct key");
  });

  it("an authentication kind this build does not know is never rendered as a passport either", () => {
    const view = describeReceiptAuthentication({ sub: "root", agid: "a", auth: { kind: "something_new" } } as never);
    expect(view.label).not.toBe("Passport verified");
    expect(view.label).toMatch(/not recognised/i);
  });
});
