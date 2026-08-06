import { describe, it, expect } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import { compactVerify, importJWK } from "jose";

import { bytesToBase64url, base64urlToBytes, utf8ToBytes } from "@/lib/encoding";
import { publicJwk } from "@/lib/crypto/instanceKey";
import {
  RECEIPT_TYP,
  AGENT_TOKEN_TYP,
  signCompactJws,
  verifyCompactJws,
} from "@/lib/crypto/jws";

const SEED = new Uint8Array(32).fill(7);
const PUBLIC_KEY = ed25519.getPublicKey(SEED);
const CLAIMS = { iss: "https://gw.example.com", sub: "agent-1", n: 1 };

function sign(overrides: Partial<Parameters<typeof signCompactJws>[0]> = {}) {
  return signCompactJws({ typ: RECEIPT_TYP, kid: "test-kid", claims: CLAIMS, seed: SEED, ...overrides });
}

describe("compact JWS signing", () => {
  it("produces three base64url segments", () => {
    const parts = sign().split(".");
    expect(parts).toHaveLength(3);
    for (const part of parts) expect(part).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("declares EdDSA, the caller's typ, and the kid in the protected header", () => {
    const header = JSON.parse(new TextDecoder().decode(base64urlToBytes(sign().split(".")[0]!)));
    expect(header).toEqual({ alg: "EdDSA", typ: RECEIPT_TYP, kid: "test-kid" });
  });

  it("round-trips its own claims", () => {
    const result = verifyCompactJws(sign(), PUBLIC_KEY);
    expect(result?.claims).toEqual(CLAIMS);
  });

  // The whole third-party-verifiability claim rests on this. We hand-roll the
  // JWS because jose cannot sign EdDSA on the edge runtime (its browser build
  // rejects raw key bytes unless the alg is HS*), so nothing else proves the
  // artifact we emit is a standard RFC 8037 JWS rather than our own format.
  it("verifies under stock jose against the published JWK", async () => {
    const key = await importJWK(publicJwk(PUBLIC_KEY), "EdDSA");
    const { payload, protectedHeader } = await compactVerify(sign(), key);
    expect(protectedHeader.alg).toBe("EdDSA");
    expect(JSON.parse(new TextDecoder().decode(payload))).toEqual(CLAIMS);
  });
});

describe("compact JWS verification", () => {
  it("rejects a token signed by a different key", () => {
    const otherKey = ed25519.getPublicKey(new Uint8Array(32).fill(9));
    expect(verifyCompactJws(sign(), otherKey)).toBeNull();
  });

  it("rejects a token whose payload was altered after signing", () => {
    const [header, , signature] = sign().split(".");
    const forged = bytesToBase64url(utf8ToBytes(JSON.stringify({ ...CLAIMS, n: 99 })));
    expect(verifyCompactJws(`${header}.${forged}.${signature}`, PUBLIC_KEY)).toBeNull();
  });

  it.each([
    ["not a jws", "abc"],
    ["two segments", "a.b"],
    ["four segments", "a.b.c.d"],
    ["empty", ""],
  ])("rejects a malformed token (%s) without throwing", (_label, token) => {
    expect(() => verifyCompactJws(token, PUBLIC_KEY)).not.toThrow();
    expect(verifyCompactJws(token, PUBLIC_KEY)).toBeNull();
  });

  // The classic algorithm-confusion attack. A verifier that reads `alg` from the
  // token and dispatches on it can be handed alg:none, or an HS256 MAC keyed on
  // the public key material it just fetched from the JWKS. We pin EdDSA.
  it("rejects a token declaring alg:none", () => {
    const header = bytesToBase64url(utf8ToBytes(JSON.stringify({ alg: "none", typ: RECEIPT_TYP })));
    const payload = bytesToBase64url(utf8ToBytes(JSON.stringify(CLAIMS)));
    expect(verifyCompactJws(`${header}.${payload}.`, PUBLIC_KEY)).toBeNull();
  });

  it("rejects a token declaring an algorithm other than EdDSA", () => {
    const [, payload, signature] = sign().split(".");
    const header = bytesToBase64url(utf8ToBytes(JSON.stringify({ alg: "HS256", typ: RECEIPT_TYP })));
    expect(verifyCompactJws(`${header}.${payload}.${signature}`, PUBLIC_KEY)).toBeNull();
  });

  // RFC 8725 explicit typing. Receipts and agent tokens are signed by the same
  // key; without a typ check a historical receipt would satisfy a live
  // authentication decision. Pinned now, before agent tokens exist.
  it("rejects a receipt when an agent token was expected", () => {
    expect(verifyCompactJws(sign(), PUBLIC_KEY, { typ: AGENT_TOKEN_TYP })).toBeNull();
  });

  it("accepts a receipt when a receipt was expected", () => {
    expect(verifyCompactJws(sign(), PUBLIC_KEY, { typ: RECEIPT_TYP })?.claims).toEqual(CLAIMS);
  });

  it("uses distinct typ values for receipts and agent tokens", () => {
    expect(RECEIPT_TYP).not.toBe(AGENT_TOKEN_TYP);
  });
});
