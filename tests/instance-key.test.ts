import { describe, it, expect, beforeEach } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";

import { bytesToBase64url } from "@/lib/encoding";
import {
  instanceIssuer,
  jwkThumbprint,
  loadInstanceSigner,
  loadInstanceVerifiers,
  publicJwk,
} from "@/lib/crypto/instanceKey";

// A fixed seed so the derived kid is stable across runs and can be asserted.
const SEED = new Uint8Array(32).fill(7);
const SEED_B64 = bytesToBase64url(SEED);
const OTHER_SEED = bytesToBase64url(new Uint8Array(32).fill(9));

function clearEnv() {
  delete process.env.INSTANCE_SIGNING_KEY;
  delete process.env.INSTANCE_SIGNING_KEY_PREV;
  delete process.env.PASSCONTROL_ISSUER;
}

beforeEach(clearEnv);

describe("loading the instance signing key", () => {
  // aesgcm.ts throws when CACHE_ENC_KEY is missing, and that is right there: the
  // proxy cannot function without it. Copying that idiom here would be a bug.
  // A missing signing key means "receipts are off", and the caller builds the
  // receipt inline in the writeLog argument list — a throw there takes out the
  // whole reconcile tasks array.
  it("yields no signer when INSTANCE_SIGNING_KEY is unset, instead of throwing", () => {
    expect(() => loadInstanceSigner()).not.toThrow();
    expect(loadInstanceSigner()).toBeNull();
  });

  it("yields no signer when the seed does not decode to 32 bytes", () => {
    process.env.INSTANCE_SIGNING_KEY = bytesToBase64url(new Uint8Array(16).fill(1));
    expect(loadInstanceSigner()).toBeNull();
  });

  it("yields no signer when the seed is not valid base64url", () => {
    process.env.INSTANCE_SIGNING_KEY = "!!!! not base64 !!!!";
    expect(loadInstanceSigner()).toBeNull();
  });

  it("derives the public key from the seed", () => {
    process.env.INSTANCE_SIGNING_KEY = SEED_B64;
    const signer = loadInstanceSigner()!;
    expect(signer).not.toBeNull();
    expect(Array.from(signer.publicKey)).toEqual(Array.from(ed25519.getPublicKey(SEED)));
  });

  // The operator supplies only a seed. Both the current and the _PREV kid have
  // to derive from it, or rotation would need a second env var per key.
  it("derives a kid that is the RFC 7638 thumbprint of the published JWK", () => {
    process.env.INSTANCE_SIGNING_KEY = SEED_B64;
    const signer = loadInstanceSigner()!;
    const jwk = publicJwk(signer.publicKey);
    expect(signer.kid).toBe(jwkThumbprint(jwk.x));
    expect(jwk.kid).toBe(signer.kid);
  });

  it("derives a stable kid across repeated loads", () => {
    process.env.INSTANCE_SIGNING_KEY = SEED_B64;
    expect(loadInstanceSigner()!.kid).toBe(loadInstanceSigner()!.kid);
  });

  // The module caches the parse. If the cache is not keyed on the raw env value,
  // a rotated key keeps signing with the old seed until the process restarts.
  it("picks up a changed seed rather than serving a stale cached signer", () => {
    process.env.INSTANCE_SIGNING_KEY = SEED_B64;
    const first = loadInstanceSigner()!.kid;
    process.env.INSTANCE_SIGNING_KEY = OTHER_SEED;
    expect(loadInstanceSigner()!.kid).not.toBe(first);
  });

  it("accepts a seed written in standard base64 as well as base64url", () => {
    const standard = SEED_B64.replace(/-/g, "+").replace(/_/g, "/");
    process.env.INSTANCE_SIGNING_KEY = standard;
    expect(loadInstanceSigner()!.kid).toBeTruthy();
  });
});

describe("the published verifier set", () => {
  it("is empty when no signing key is configured", () => {
    expect(loadInstanceVerifiers()).toEqual([]);
  });

  it("publishes the current key alone when no previous key is set", () => {
    process.env.INSTANCE_SIGNING_KEY = SEED_B64;
    expect(loadInstanceVerifiers()).toHaveLength(1);
  });

  // _PREV means the OPPOSITE of VISA_SECRET_PREV. We never sign with it; we
  // publish its public half so receipts signed before the rotation still verify.
  it("publishes both the current and the previous public key during a rotation", () => {
    process.env.INSTANCE_SIGNING_KEY = SEED_B64;
    process.env.INSTANCE_SIGNING_KEY_PREV = OTHER_SEED;
    const kids = loadInstanceVerifiers().map((v) => v.kid);
    expect(kids).toHaveLength(2);
    expect(new Set(kids).size).toBe(2);
  });

  it("ignores a malformed previous key rather than failing the whole key set", () => {
    process.env.INSTANCE_SIGNING_KEY = SEED_B64;
    process.env.INSTANCE_SIGNING_KEY_PREV = "garbage";
    expect(loadInstanceVerifiers()).toHaveLength(1);
  });

  it("never exposes a private component in a published JWK", () => {
    process.env.INSTANCE_SIGNING_KEY = SEED_B64;
    process.env.INSTANCE_SIGNING_KEY_PREV = OTHER_SEED;
    for (const verifier of loadInstanceVerifiers()) {
      const jwk = publicJwk(verifier.publicKey) as unknown as Record<string, unknown>;
      expect(jwk.d).toBeUndefined();
      expect(Object.keys(jwk).sort()).toEqual(["alg", "crv", "kid", "kty", "use", "x"]);
      expect(jwk).toMatchObject({ kty: "OKP", crv: "Ed25519", alg: "EdDSA", use: "sig" });
    }
  });
});

describe("the configured issuer", () => {
  it("is null when unset", () => {
    expect(instanceIssuer()).toBeNull();
  });

  it("accepts an https origin", () => {
    process.env.PASSCONTROL_ISSUER = "https://passcontrol.example.com";
    expect(instanceIssuer()).toBe("https://passcontrol.example.com");
  });

  it("normalises away a bare trailing slash", () => {
    process.env.PASSCONTROL_ISSUER = "https://passcontrol.example.com/";
    expect(instanceIssuer()).toBe("https://passcontrol.example.com");
  });

  // An issuer carrying a path, query or fragment breaks the verifier's
  // `new URL("/.well-known/jwks.json", iss)` resolution and its exact-match
  // trusted-issuer comparison. Reject it here rather than mint against it.
  it.each([
    "https://example.com/tenant-a",
    "https://example.com/?next=https://evil.com",
    "https://example.com/#x",
    "ftp://example.com",
    "https://user:pass@example.com",
    "not a url",
  ])("rejects %s", (value) => {
    process.env.PASSCONTROL_ISSUER = value;
    expect(instanceIssuer()).toBeNull();
  });

  // The local Docker stack serves http://localhost:3000. Without this carve-out
  // receipts and agent tokens would be untryable on the setup the quickstart
  // recommends — the feature would exist only for people who already deployed.
  it.each(["http://localhost:3000", "http://127.0.0.1:3000"])(
    "accepts loopback http for local development (%s)",
    (value) => {
      process.env.PASSCONTROL_ISSUER = value;
      expect(instanceIssuer()).toBe(value);
    }
  );

  // A routable http issuer is the dangerous case: anyone on the path could serve
  // their own JWKS at that origin and forge every artifact we ever signed.
  it.each([
    "http://example.com",
    "http://passcontrol.vertias.eu",
    "http://192.168.1.10:3000",
    "http://localhost.evil.com",
  ])("rejects non-loopback http (%s)", (value) => {
    process.env.PASSCONTROL_ISSUER = value;
    expect(instanceIssuer()).toBeNull();
  });
});
