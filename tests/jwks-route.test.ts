import { describe, it, expect, beforeEach } from "vitest";

import { bytesToBase64url } from "@/lib/encoding";
import { GET } from "@/app/.well-known/jwks.json/route";

const SEED = bytesToBase64url(new Uint8Array(32).fill(7));
const PREV_SEED = bytesToBase64url(new Uint8Array(32).fill(9));

beforeEach(() => {
  delete process.env.INSTANCE_SIGNING_KEY;
  delete process.env.INSTANCE_SIGNING_KEY_PREV;
  delete process.env.JWKS_MAX_AGE_SECONDS;
});

async function get(): Promise<{ res: Response; body: { keys: Record<string, unknown>[] } }> {
  const res = await GET();
  return { res, body: await res.clone().json() };
}

describe("the published JWKS", () => {
  // This endpoint is the entire trust anchor for receipts and agent tokens. If it
  // ever emitted `d`, the deployment's signing key would be world-readable and
  // anyone could forge every artifact it has ever produced.
  it("never contains a private component", async () => {
    process.env.INSTANCE_SIGNING_KEY = SEED;
    process.env.INSTANCE_SIGNING_KEY_PREV = PREV_SEED;
    const { body } = await get();

    expect(body.keys.length).toBeGreaterThan(0);
    for (const key of body.keys) {
      expect(key.d).toBeUndefined();
      expect(Object.keys(key).sort()).toEqual(["alg", "crv", "kid", "kty", "use", "x"]);
    }
  });

  it("publishes one OKP Ed25519 key when only a current key is configured", async () => {
    process.env.INSTANCE_SIGNING_KEY = SEED;
    const { res, body } = await get();

    expect(res.status).toBe(200);
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).toMatchObject({ kty: "OKP", crv: "Ed25519", alg: "EdDSA", use: "sig" });
    expect(body.keys[0]!.kid).toBeTruthy();
  });

  it("publishes both keys during a rotation so pre-rotation artifacts still verify", async () => {
    process.env.INSTANCE_SIGNING_KEY = SEED;
    process.env.INSTANCE_SIGNING_KEY_PREV = PREV_SEED;
    const { body } = await get();

    expect(body.keys).toHaveLength(2);
    expect(new Set(body.keys.map((k) => k.kid)).size).toBe(2);
  });

  // An unconfigured deployment is a supported state, not an error. "This
  // instance publishes no keys" is a true, machine-readable statement; a 500
  // would read to a verifier as an outage and invite a retry loop.
  it("returns an empty key set with 200 when no signing key is configured", async () => {
    const { res, body } = await get();

    expect(res.status).toBe(200);
    expect(body).toEqual({ keys: [] });
  });

  it("is served as a JWK Set", async () => {
    process.env.INSTANCE_SIGNING_KEY = SEED;
    const { res } = await get();
    expect(res.headers.get("content-type")).toContain("application/jwk-set+json");
  });

  // A verifier fetches this on every cold start. It must be cacheable, and it
  // must be readable cross-origin: the global Cross-Origin-Resource-Policy in
  // next.config.mjs is same-origin, which is right for every other route and
  // wrong for the one document other deployments are meant to read.
  it("is cacheable and readable cross-origin", async () => {
    process.env.INSTANCE_SIGNING_KEY = SEED;
    const { res } = await get();

    expect(res.headers.get("cache-control")).toMatch(/public/);
    expect(res.headers.get("cache-control")).toMatch(/max-age=\d+/);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
  });

  it("honours JWKS_MAX_AGE_SECONDS", async () => {
    process.env.INSTANCE_SIGNING_KEY = SEED;
    process.env.JWKS_MAX_AGE_SECONDS = "42";
    const { res } = await get();
    expect(res.headers.get("cache-control")).toContain("max-age=42");
  });

  it("falls back to a sane max-age when the env value is not a number", async () => {
    process.env.INSTANCE_SIGNING_KEY = SEED;
    process.env.JWKS_MAX_AGE_SECONDS = "not-a-number";
    const { res } = await get();
    expect(res.headers.get("cache-control")).toContain("max-age=300");
  });
});
