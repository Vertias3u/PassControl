import { describe, it, expect, beforeEach, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha256";

import { bytesToBase64url, utf8ToBytes } from "@/lib/encoding";
import { AGENT_TOKEN_TYP, RECEIPT_TYP, verifyCompactJws } from "@/lib/crypto/jws";
import { loadInstanceSigner } from "@/lib/crypto/instanceKey";
import { RECEIPT_VER, buildReceiptClaims, requestDigest, signReceipt } from "@/lib/receipt";

const SEED = bytesToBase64url(new Uint8Array(32).fill(7));

const INPUT = {
  receiptId: "receipt-1",
  passportId: "cGFzc3BvcnQ",
  agentId: "agent-1",
  visaJti: "visa-1",
  provider: "openai",
  model: "gpt-4o-mini",
  method: "POST",
  path: "v1/chat/completions",
  rawBody: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] }),
  inputTokens: 11,
  outputTokens: 22,
  costMicrocents: 3300,
  status: "ok" as const,
  httpStatus: 200,
  startedAt: 1_700_000_000_000,
  latencyMs: 420,
};

beforeEach(() => {
  process.env.INSTANCE_SIGNING_KEY = SEED;
  process.env.PASSCONTROL_ISSUER = "https://gw.example.com";
  delete process.env.INSTANCE_SIGNING_KEY_PREV;
});

describe("the request digest", () => {
  it("is sha-256 over the utf8 bytes of the body, base64url encoded", () => {
    const digest = requestDigest(INPUT.rawBody);
    expect(digest.alg).toBe("sha-256");
    expect(digest.dig).toBe(bytesToBase64url(sha256(utf8ToBytes(INPUT.rawBody))));
    expect(digest.len).toBe(utf8ToBytes(INPUT.rawBody).length);
  });

  it("reports the byte length, not the character count, for multi-byte bodies", () => {
    const body = JSON.stringify({ q: "café — 日本語" });
    expect(requestDigest(body).len).toBe(utf8ToBytes(body).length);
    expect(requestDigest(body).len).toBeGreaterThan(body.length);
  });

  it("handles an empty body (a GET) without throwing", () => {
    expect(() => requestDigest("")).not.toThrow();
    expect(requestDigest("").len).toBe(0);
  });
});

describe("receipt claims", () => {
  it("binds the identity, the verdict, the usage and the cost", () => {
    const claims = buildReceiptClaims(INPUT) as Record<string, any>;

    expect(claims.iss).toBe("https://gw.example.com");
    expect(claims.sub).toBe(INPUT.passportId);
    expect(claims.jti).toBe(INPUT.receiptId);
    expect(claims.agid).toBe(INPUT.agentId);
    expect(claims.vjti).toBe(INPUT.visaJti);
    expect(claims.prov).toBe("openai");
    expect(claims.mdl).toBe("gpt-4o-mini");
    expect(claims.use).toEqual({ in: 11, out: 22 });
    expect(claims.cost).toBe(3300);
    expect(claims.res).toEqual({ status: "ok", http: 200 });
    expect(claims.ver).toBe(1);
  });

  // A receipt is a historical record of something that happened. An `exp` would
  // imply it stops being true, and would make an old receipt unverifiable
  // exactly when it matters — in a dispute months later.
  it("carries no expiry", () => {
    expect(buildReceiptClaims(INPUT)).not.toHaveProperty("exp");
  });

  // A receipt is a bearer artifact: the owner hands it to a counterparty. The
  // internal tenant uuid must not ride along — it identifies the PassControl
  // account, which is nobody's business but the owner's.
  it("never carries the tenant id", () => {
    const claims = buildReceiptClaims(INPUT) as Record<string, unknown>;
    expect(claims.uid).toBeUndefined();
    expect(JSON.stringify(claims)).not.toContain("uid");
  });

  // The revocation gate runs before the body is read, so a kill-blocked call
  // genuinely has no request to digest. Absent must mean "never read" — a
  // digest of "" would assert the client sent an empty body, which is a
  // different and false claim.
  it("omits the request digest entirely when the body was never read", () => {
    const claims = buildReceiptClaims({ ...INPUT, rawBody: null }) as Record<string, unknown>;
    expect(claims).not.toHaveProperty("req");
  });

  it("still reports a digest for a genuinely empty body", () => {
    const claims = buildReceiptClaims({ ...INPUT, rawBody: "" }) as Record<string, any>;
    expect(claims.req.len).toBe(0);
    expect(claims.req.dig).toBeTruthy();
  });

  it("omits the owner until one is bound", () => {
    expect((buildReceiptClaims(INPUT) as Record<string, unknown>).own ?? null).toBeNull();
  });

  it("keeps passport receipts on version 1 and identifies the passport exactly as before", () => {
    const claims = buildReceiptClaims(INPUT) as Record<string, unknown>;
    expect(claims.ver).toBe(1);
    expect(claims.sub).toBe(INPUT.passportId);
    expect(claims.vjti).toBe(INPUT.visaJti);
    expect(claims.auth).toBeUndefined();
  });

  it("adds a distinct signed method only when passport proof was enforced for this request", () => {
    const proofed = buildReceiptClaims({
      ...INPUT,
      authMethod: "passport_proof_per_request",
    }) as Record<string, any>;
    const bearer = buildReceiptClaims({ ...INPUT, authMethod: "passport" }) as Record<string, any>;
    const direct = buildReceiptClaims({
      ...INPUT,
      authMethod: "direct_key",
      agentAccessKeyId: "key-1",
      credentialUseId: "use-1",
      passportId: undefined,
      visaJti: undefined,
    }) as Record<string, any>;

    expect(proofed.auth).toEqual({ kind: "passport_proof_per_request" });
    expect(proofed.ver).toBe(1);
    expect(bearer.auth).toBeUndefined();
    expect(direct.auth.kind).toBe("direct_key");
    expect(new Set([proofed.auth.kind, "passport", direct.auth.kind]).size).toBe(3);
  });

  it("uses version 2 for a direct call without claiming a passport or visa", () => {
    const claims = buildReceiptClaims({
      ...INPUT,
      authMethod: "direct_key",
      agentAccessKeyId: "key-1",
      credentialUseId: "use-1",
      passportId: undefined,
      visaJti: undefined,
    }) as Record<string, any>;

    expect(claims.ver).toBe(RECEIPT_VER);
    expect(claims.ver).toBe(2);
    expect(claims.sub).toBe(INPUT.agentId);
    expect(claims.vjti).toBeUndefined();
    expect(claims.auth).toEqual({ kind: "direct_key", kid: "key-1", use: "use-1" });
    expect(JSON.stringify(claims)).not.toContain(INPUT.passportId);
    expect(JSON.stringify(claims)).not.toContain(INPUT.visaJti);
  });
});

describe("signing a receipt", () => {
  it("produces a JWS that verifies against the instance public key", () => {
    const jws = signReceipt(INPUT)!;
    const signer = loadInstanceSigner()!;
    const verified = verifyCompactJws(jws, signer.publicKey, { typ: RECEIPT_TYP });

    expect(verified).not.toBeNull();
    expect(verified!.claims.jti).toBe(INPUT.receiptId);
    expect(verified!.header.kid).toBe(signer.kid);
  });

  it("is typed as a receipt and does not verify as an agent token", () => {
    const jws = signReceipt(INPUT)!;
    const signer = loadInstanceSigner()!;
    expect(verifyCompactJws(jws, signer.publicKey, { typ: AGENT_TOKEN_TYP })).toBeNull();
  });

  it("detects any alteration of the usage or cost claims", () => {
    const jws = signReceipt(INPUT)!;
    const signer = loadInstanceSigner()!;
    const [header, , signature] = jws.split(".");
    const tampered = buildReceiptClaims({ ...INPUT, costMicrocents: 1 });
    const forged = bytesToBase64url(utf8ToBytes(JSON.stringify(tampered)));

    expect(verifyCompactJws(`${header}.${forged}.${signature}`, signer.publicKey)).toBeNull();
  });

  it("returns null rather than signing when no instance key is configured", () => {
    delete process.env.INSTANCE_SIGNING_KEY;
    expect(signReceipt(INPUT)).toBeNull();
  });

  it("returns null rather than signing when no issuer is configured", () => {
    delete process.env.PASSCONTROL_ISSUER;
    expect(signReceipt(INPUT)).toBeNull();
  });

  // signReceipt is called inline while building the writeLog argument inside
  // reconcile(). A throw there destroys the whole tasks array — the budget is
  // never reconciled and the audit row is never written. It must swallow.
  it("never throws, whatever the input", () => {
    const hostile = { ...INPUT, rawBody: undefined, use: null } as never;
    expect(() => signReceipt(hostile)).not.toThrow();
  });

  it("never throws when the signing primitive itself fails", async () => {
    vi.resetModules();
    vi.doMock("@/lib/crypto/jws", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/crypto/jws")>()),
      signCompactJws: () => {
        throw new Error("hsm on fire");
      },
    }));
    const { signReceipt: fragile } = await import("@/lib/receipt");
    expect(() => fragile(INPUT)).not.toThrow();
    expect(fragile(INPUT)).toBeNull();
    vi.doUnmock("@/lib/crypto/jws");
    vi.resetModules();
  });
});

describe("receipt versioning", () => {
  // verifyVisa accepts only its current version plus one named migration
  // predecessor. A receipt is verified by third parties running code we do not
  // control and cannot upgrade, so adding a claim must not break every deployed
  // verifier. Additive-only, forward-compatible.
  it("declares a numeric version a verifier can range-check", () => {
    expect(typeof RECEIPT_VER).toBe("number");
    expect(RECEIPT_VER).toBe(2);
    expect((buildReceiptClaims(INPUT) as Record<string, unknown>).ver).toBe(1);
  });
});

/**
 * A receipt that says `cost: 0` for a call nobody could price is a signed false
 * statement, and it sits on the one artifact this product asks strangers to
 * trust. `lib/pricing.ts` already refuses to guess a price for a custom endpoint
 * — `isPricedEndpoint` exists for exactly this — but the zero it returns reached
 * the claims unlabelled.
 *
 * The fix follows the `cr` / `cw` precedent documented in buildReceiptClaims:
 * an OPTIONAL claim, present only in the case it describes, so every receipt for
 * a priced call stays byte-identical and every verifier already in the field
 * keeps working. `ver` deliberately does not move.
 */
describe("an unpriced call says so", () => {
  it("adds no claim at all when the call was priced", () => {
    const claims = buildReceiptClaims(INPUT) as Record<string, unknown>;

    expect("unp" in claims).toBe(false);
    expect(claims.cost).toBe(3300);
  });

  it("marks the cost as unknown rather than zero", () => {
    const claims = buildReceiptClaims({
      ...INPUT,
      costMicrocents: 0,
      unpriced: true,
    }) as Record<string, unknown>;

    expect(claims.unp).toBe(true);
    // `cost` stays a number. Omitting it would break every verifier already
    // published, which types it as required — the claim is that the number is
    // not meaningful, and `unp` is what says so.
    expect(claims.cost).toBe(0);
  });

  it("does not move the receipt version for an added optional claim", () => {
    const priced = buildReceiptClaims(INPUT) as Record<string, unknown>;
    const unpriced = buildReceiptClaims({ ...INPUT, costMicrocents: 0, unpriced: true }) as Record<
      string,
      unknown
    >;

    expect(unpriced.ver).toBe(priced.ver);
  });

  it("signs and verifies with the extra claim present, and the claim is covered", () => {
    const jws = signReceipt({ ...INPUT, costMicrocents: 0, unpriced: true })!;
    const signer = loadInstanceSigner()!;
    const verified = verifyCompactJws(jws, signer.publicKey, { typ: RECEIPT_TYP });

    expect(verified).not.toBeNull();
    expect(verified!.claims.unp).toBe(true);

    // And it is inside the signature, not decoration: stripping it invalidates.
    const [header, , signature] = jws.split(".");
    const stripped = buildReceiptClaims({ ...INPUT, costMicrocents: 0 });
    const forged = bytesToBase64url(utf8ToBytes(JSON.stringify(stripped)));
    expect(verifyCompactJws(`${header}.${forged}.${signature}`, signer.publicKey)).toBeNull();
  });
});
