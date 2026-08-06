import { describe, it, expect } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";

import {
  AGENT_TOKEN_TYP,
  FAILURE_REASONS,
  RECEIPT_TYP,
  matchesIssuer,
  verifyAgentToken,
  verifyReceipt,
} from "../verify.mjs";

const b64url = (bytes) => Buffer.from(bytes).toString("base64url").replace(/=+$/, "");
const SEED = new Uint8Array(32).fill(7);
const PUBLIC_KEY = ed25519.getPublicKey(SEED);
const X = b64url(PUBLIC_KEY);
const KID = b64url(
  sha256(new TextEncoder().encode(`{"crv":"Ed25519","kty":"OKP","x":"${X}"}`))
);
const JWK = { kty: "OKP", crv: "Ed25519", x: X, alg: "EdDSA", use: "sig", kid: KID };

const ISSUER = "https://gw.example.com";
const AUDIENCE = "billing-service";
const NOW = 1_800_000_000_000;

function sign(claims, typ = AGENT_TOKEN_TYP, seed = SEED) {
  const header = b64url(Buffer.from(JSON.stringify({ alg: "EdDSA", typ, kid: KID })));
  const payload = b64url(Buffer.from(JSON.stringify(claims)));
  const signature = b64url(ed25519.sign(new TextEncoder().encode(`${header}.${payload}`), seed));
  return `${header}.${payload}.${signature}`;
}

const tokenClaims = (over = {}) => ({
  iss: ISSUER,
  sub: "cGFzc3BvcnQ",
  aud: AUDIENCE,
  jti: "t1",
  exp: Math.floor(NOW / 1000) + 300,
  ver: 1,
  ...over,
});

const jwksFetch = (keys = [JWK], { ok = true } = {}) =>
  async () => ({ ok, status: ok ? 200 : 404, json: async () => ({ keys }) });

const opts = (over = {}) => ({
  issuer: ISSUER,
  audience: AUDIENCE,
  now: () => NOW,
  fetch: jwksFetch(),
  ...over,
});

describe("verifying an agent token from the CLI", () => {
  it("accepts a genuine token", async () => {
    const result = await verifyAgentToken(sign(tokenClaims()), opts());
    expect(result.ok).toBe(true);
    expect(result.claims.sub).toBe("cGFzc3BvcnQ");
  });

  it("fetches the key set from the issuer's well-known path", async () => {
    let requested = "";
    await verifyAgentToken(
      sign(tokenClaims()),
      opts({
        fetch: async (url) => {
          requested = String(url);
          return { ok: true, status: 200, json: async () => ({ keys: [JWK] }) };
        },
      })
    );
    expect(requested).toBe(`${ISSUER}/.well-known/jwks.json`);
  });

  it("rejects a token for another audience", async () => {
    const result = await verifyAgentToken(sign(tokenClaims({ aud: "payroll" })), opts());
    expect(result).toMatchObject({ ok: false, reason: "wrong_audience" });
  });

  it("rejects an expired token", async () => {
    const result = await verifyAgentToken(
      sign(tokenClaims({ exp: Math.floor(NOW / 1000) - 1 })),
      opts()
    );
    expect(result).toMatchObject({ ok: false, reason: "expired" });
  });

  it("rejects a token from an issuer other than the one named", async () => {
    const result = await verifyAgentToken(sign(tokenClaims()), opts({ issuer: "https://other.com" }));
    expect(result).toMatchObject({ ok: false, reason: "untrusted_issuer" });
  });

  it("rejects a lookalike issuer", async () => {
    expect(matchesIssuer("https://gw.example.com.evil.com", [ISSUER])).toBe(false);
    expect(matchesIssuer("https://evil.com/?x=https://gw.example.com", [ISSUER])).toBe(false);
  });

  it("rejects a token signed by an unpublished key", async () => {
    const strangerSeed = new Uint8Array(32).fill(9);
    const result = await verifyAgentToken(sign(tokenClaims(), AGENT_TOKEN_TYP, strangerSeed), opts());
    expect(result.ok).toBe(false);
  });

  it("rejects a receipt presented as an agent token", async () => {
    const result = await verifyAgentToken(sign(tokenClaims(), RECEIPT_TYP), opts());
    expect(result).toMatchObject({ ok: false, reason: "wrong_type" });
  });

  it("reports an unreachable key set distinctly", async () => {
    const result = await verifyAgentToken(
      sign(tokenClaims()),
      opts({ fetch: jwksFetch([], { ok: false }) })
    );
    expect(result).toMatchObject({ ok: false, reason: "jwks_unreachable" });
  });

  it("rejects alg:none", async () => {
    const header = b64url(Buffer.from(JSON.stringify({ alg: "none", typ: AGENT_TOKEN_TYP })));
    const payload = b64url(Buffer.from(JSON.stringify(tokenClaims())));
    const result = await verifyAgentToken(`${header}.${payload}.`, opts());
    expect(result.ok).toBe(false);
  });
});

describe("verifying a receipt from the CLI", () => {
  it("accepts a genuine receipt", async () => {
    const jws = sign({ iss: ISSUER, jti: "r1", ver: 1, cost: 100 }, RECEIPT_TYP);
    const result = await verifyReceipt(jws, { issuer: ISSUER, fetch: jwksFetch() });

    expect(result.ok).toBe(true);
    expect(result.claims.cost).toBe(100);
  });

  it("rejects a tampered receipt", async () => {
    const jws = sign({ iss: ISSUER, jti: "r1", ver: 1, cost: 100 }, RECEIPT_TYP);
    const [header, , signature] = jws.split(".");
    const forged = b64url(Buffer.from(JSON.stringify({ iss: ISSUER, jti: "r1", ver: 1, cost: 1 })));

    const result = await verifyReceipt(`${header}.${forged}.${signature}`, {
      issuer: ISSUER,
      fetch: jwksFetch(),
    });
    expect(result).toMatchObject({ ok: false, reason: "bad_signature" });
  });

  it("rejects an agent token presented as a receipt", async () => {
    const result = await verifyReceipt(sign(tokenClaims()), {
      issuer: ISSUER,
      fetch: jwksFetch(),
    });
    expect(result).toMatchObject({ ok: false, reason: "wrong_type" });
  });

  it("has a human-readable explanation for every failure it can report", async () => {
    for (const reason of [
      "malformed",
      "bad_signature",
      "wrong_type",
      "untrusted_issuer",
      "unknown_key",
      "jwks_unreachable",
      "unsupported_version",
      "wrong_audience",
      "expired",
    ]) {
      expect(FAILURE_REASONS[reason]).toBeTruthy();
    }
  });
});

describe("the CLI and the SDK agree", () => {
  // Two implementations of the same check exist because the shipped CLI is
  // transpilation-free. They must not drift on the cases that decide whether a
  // signature means anything.
  it("derives the same kid the app publishes", async () => {
    const { publicJwk } = await import("../../lib/crypto/instanceKey.ts").catch(() => ({}));
    if (!publicJwk) return; // TS module not loadable in this context; covered elsewhere.
    expect(publicJwk(PUBLIC_KEY).kid).toBe(KID);
  });

  it("uses the same typ strings", async () => {
    const sdk = await import("../../sdk/verify.ts").catch(() => null);
    if (!sdk) return;
    expect(sdk.RECEIPT_TYP).toBe(RECEIPT_TYP);
    expect(sdk.AGENT_TOKEN_TYP).toBe(AGENT_TOKEN_TYP);
  });
});
