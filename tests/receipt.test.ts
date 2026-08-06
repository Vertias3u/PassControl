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
    expect(claims.ver).toBe(RECEIPT_VER);
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
  // verifyVisa uses strict `ver !== VISA_VER` because the same gateway mints and
  // verifies. A receipt is verified by third parties running code we do not
  // control and cannot upgrade, so adding a claim (owner, in Phase 2) must not
  // break every deployed verifier. Additive-only, forward-compatible.
  it("declares a numeric version a verifier can range-check", () => {
    expect(typeof RECEIPT_VER).toBe("number");
    expect((buildReceiptClaims(INPUT) as Record<string, unknown>).ver).toBe(RECEIPT_VER);
  });
});
