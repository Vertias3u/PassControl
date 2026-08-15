import { afterEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";

/**
 * `importKey()` caches the CryptoKey in module scope, so every case needs a
 * fresh module instance to re-read the environment.
 */
async function freshAesgcm(cacheEncKey: string) {
  vi.resetModules();
  process.env.CACHE_ENC_KEY = cacheEncKey;
  return import("../lib/crypto/aesgcm");
}

const ORIGINAL = process.env.CACHE_ENC_KEY;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CACHE_ENC_KEY;
  else process.env.CACHE_ENC_KEY = ORIGINAL;
  vi.resetModules();
});

const raw32 = () => crypto.randomBytes(32);

describe("CACHE_ENC_KEY normalisation", () => {
  it("accepts the value .env.example tells you to generate", async () => {
    // `openssl rand -base64 32` — standard base64, with `=` padding.
    const { seal, open } = await freshAesgcm(raw32().toString("base64"));
    expect(await open(await seal("hello"))).toBe("hello");
  });

  it("accepts that value with the trailing newline a paste leaves behind", async () => {
    // The bug: importKey() did not trim, so a newline reached atob() and threw
    // InvalidCharacterError. It surfaced as an opaque "error occurred in the
    // Server Components render" from the key-import probe, because that is the
    // one path which seals — and nothing else had ever exercised seal().
    const { seal, open } = await freshAesgcm(raw32().toString("base64") + "\n");
    expect(await open(await seal("hello"))).toBe("hello");
  });

  it("accepts surrounding whitespace generally", async () => {
    const { seal, open } = await freshAesgcm(`  ${raw32().toString("base64")}\r\n`);
    expect(await open(await seal("hello"))).toBe("hello");
  });

  it("accepts base64url as well as standard base64", async () => {
    const { seal, open } = await freshAesgcm(raw32().toString("base64url"));
    expect(await open(await seal("hello"))).toBe("hello");
  });

  it("still rejects a key that is not 32 bytes, with a message naming the variable", async () => {
    const { seal } = await freshAesgcm(crypto.randomBytes(16).toString("base64"));
    await expect(seal("hello")).rejects.toThrow(/CACHE_ENC_KEY/);
  });

  it("still rejects an unset key", async () => {
    vi.resetModules();
    delete process.env.CACHE_ENC_KEY;
    const { seal } = await import("../lib/crypto/aesgcm");
    await expect(seal("hello")).rejects.toThrow(/CACHE_ENC_KEY is not set/);
  });

  it("normalises the same inputs instanceKey.ts accepts", async () => {
    // instanceKey.ts:decodeSeed claims to apply "the same normalisation
    // aesgcm.ts applies to CACHE_ENC_KEY". It trimmed; aesgcm did not. Pin the
    // parity the comment asserts so the two cannot drift apart again.
    const seed = raw32();
    for (const variant of [
      seed.toString("base64"),
      seed.toString("base64") + "\n",
      seed.toString("base64url"),
      `  ${seed.toString("base64")}  `,
    ]) {
      vi.resetModules();
      process.env.INSTANCE_SIGNING_KEY = variant;
      const { loadInstanceSigner } = await import("../lib/crypto/instanceKey");
      expect(loadInstanceSigner(), `instanceKey rejected: ${JSON.stringify(variant)}`).not.toBeNull();

      const { seal, open } = await freshAesgcm(variant);
      expect(await open(await seal("x")), `aesgcm rejected: ${JSON.stringify(variant)}`).toBe("x");
    }
    delete process.env.INSTANCE_SIGNING_KEY;
  });
});
