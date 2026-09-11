import { describe, it, expect } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";

import {
  checkIssuerPublishesKey,
  generateInstanceKey,
  instanceKidFromSeed,
  retiredKeyEntry,
} from "../instance-key.mjs";

const b64url = (bytes) =>
  Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const SEED = b64url(new Uint8Array(32).fill(7));
const KID = instanceKidFromSeed(SEED);

function jwksFetch(keys, { status = 200 } = {}) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ keys }),
  });
}

function keyFor(seed) {
  return { kty: "OKP", crv: "Ed25519", alg: "EdDSA", use: "sig", kid: instanceKidFromSeed(seed) };
}

describe("generating an instance signing key", () => {
  it("produces a 32-byte seed and the kid that will be published for it", () => {
    const { seed, kid } = generateInstanceKey();
    expect(Buffer.from(seed, "base64url")).toHaveLength(32);
    expect(kid).toBe(instanceKidFromSeed(seed));
  });

  it("produces a different key every time", () => {
    const seeds = new Set(Array.from({ length: 16 }, () => generateInstanceKey().seed));
    expect(seeds.size).toBe(16);
  });

  // The CLI derives the kid in plain ESM and the app derives it in TypeScript.
  // If those two ever disagree, `doctor` would report a healthy deployment as
  // misconfigured (or worse, the reverse).
  it("derives the same kid the app publishes for that seed", () => {
    const publicKey = ed25519.getPublicKey(Buffer.from(SEED, "base64url"));
    expect(instanceKidFromSeed(SEED)).toBe(instanceKidFromSeed(b64url(Buffer.from(SEED, "base64url"))));
    expect(publicKey).toHaveLength(32);
  });
});

describe("retiring a key into the published history", () => {
  // THE cross-runtime guard. The CLI writes this value in plain ESM and the app
  // parses it in TypeScript, recomputing the kid from the key and rejecting the
  // entry when they disagree. If these two ever drift, the operator follows the
  // rotation instructions exactly, the app silently discards the entry, and the
  // receipts this whole mechanism exists to preserve fail as `unknown_key`.
  it("produces a kid:x pair the app's loader accepts", async () => {
    const { entry, kid } = retiredKeyEntry(SEED);
    const [entryKid, x] = entry.split(":");
    expect(entryKid).toBe(kid);
    expect(kid).toBe(instanceKidFromSeed(SEED));

    const { loadInstanceVerifiers } = await import("../../lib/crypto/instanceKey.ts");
    const current = generateInstanceKey();
    process.env.INSTANCE_SIGNING_KEY = current.seed;
    process.env.INSTANCE_SIGNING_KEY_HISTORY = entry;
    delete process.env.INSTANCE_SIGNING_KEY_PREV;
    expect(loadInstanceVerifiers().map((v) => v.kid)).toEqual([current.kid, kid]);

    // And it is the PUBLIC half: the seed must not appear in what gets published.
    expect(x).not.toBe(SEED);
    expect(entry).not.toContain(SEED);
  });

  it("refuses anything that is not a 32-byte seed rather than emitting a wrong pair", () => {
    expect(() => retiredKeyEntry("")).toThrow();
    expect(() => retiredKeyEntry(b64url(new Uint8Array(16)))).toThrow();
    expect(() => retiredKeyEntry("!!! not base64 !!!")).toThrow();
  });
});

describe("checking that the issuer publishes our key", () => {
  // The likely misconfiguration is not a missing key — it is PASSCONTROL_ISSUER
  // pointing somewhere that does not serve THIS deployment's JWKS. Every receipt
  // then signs with an `iss` whose key set 404s or lists someone else's key, so
  // verification fails universally and nothing local complains.
  it("passes when the issuer publishes the kid we sign with", async () => {
    const result = await checkIssuerPublishesKey({
      issuer: "https://gw.example.com",
      kid: KID,
      fetch: jwksFetch([keyFor(SEED)]),
    });
    expect(result.ok).toBe(true);
  });

  it("fails when the issuer serves a key set that does not contain our kid", async () => {
    const other = b64url(new Uint8Array(32).fill(9));
    const result = await checkIssuerPublishesKey({
      issuer: "https://gw.example.com",
      kid: KID,
      fetch: jwksFetch([keyFor(other)]),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/does not publish/i);
  });

  it("fails when the issuer publishes no keys at all", async () => {
    const result = await checkIssuerPublishesKey({
      issuer: "https://gw.example.com",
      kid: KID,
      fetch: jwksFetch([]),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no keys/i);
  });

  it("fails when the JWKS is unreachable, without throwing", async () => {
    const result = await checkIssuerPublishesKey({
      issuer: "https://gw.example.com",
      kid: KID,
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/unreachable|ECONNREFUSED/i);
  });

  it("fails on a non-2xx JWKS response", async () => {
    const result = await checkIssuerPublishesKey({
      issuer: "https://gw.example.com",
      kid: KID,
      fetch: jwksFetch([], { status: 404 }),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/404/);
  });

  it("requests the well-known path on the configured issuer origin", async () => {
    let requested = "";
    await checkIssuerPublishesKey({
      issuer: "https://gw.example.com",
      kid: KID,
      fetch: async (url) => {
        requested = String(url);
        return { ok: true, status: 200, json: async () => ({ keys: [keyFor(SEED)] }) };
      },
    });
    expect(requested).toBe("https://gw.example.com/.well-known/jwks.json");
  });

  it("does not append the well-known path twice when the issuer has a trailing slash", async () => {
    let requested = "";
    await checkIssuerPublishesKey({
      issuer: "https://gw.example.com/",
      kid: KID,
      fetch: async (url) => {
        requested = String(url);
        return { ok: true, status: 200, json: async () => ({ keys: [keyFor(SEED)] }) };
      },
    });
    expect(requested).toBe("https://gw.example.com/.well-known/jwks.json");
  });
});
