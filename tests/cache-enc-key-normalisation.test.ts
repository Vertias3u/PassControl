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
// Any context will do here: these cases are about reading the key, not about A2's binding.
type Aes = Awaited<ReturnType<typeof freshAesgcm>>;
const ctx = (aes: Aes) => aes.sealContext.deviceGrant("normalisation");

describe("CACHE_ENC_KEY normalisation", () => {
  it("accepts the value .env.example tells you to generate", async () => {
    // `openssl rand -base64 32` — standard base64, with `=` padding.
    const aes = await freshAesgcm(raw32().toString("base64"));
    expect(await aes.open(await aes.seal("hello", ctx(aes)), ctx(aes))).toBe("hello");
  });

  it("accepts that value with the trailing newline a paste leaves behind", async () => {
    // The bug: importKey() did not trim, so a newline reached atob() and threw
    // InvalidCharacterError. It surfaced as an opaque "error occurred in the
    // Server Components render" from the key-import probe, because that is the
    // one path which seals — and nothing else had ever exercised seal().
    const aes = await freshAesgcm(raw32().toString("base64") + "\n");
    expect(await aes.open(await aes.seal("hello", ctx(aes)), ctx(aes))).toBe("hello");
  });

  it("accepts surrounding whitespace generally", async () => {
    const aes = await freshAesgcm(`  ${raw32().toString("base64")}\r\n`);
    expect(await aes.open(await aes.seal("hello", ctx(aes)), ctx(aes))).toBe("hello");
  });

  it("accepts base64url as well as standard base64", async () => {
    const aes = await freshAesgcm(raw32().toString("base64url"));
    expect(await aes.open(await aes.seal("hello", ctx(aes)), ctx(aes))).toBe("hello");
  });

  it("still rejects a key that is not 32 bytes, with a message naming the variable", async () => {
    const aes = await freshAesgcm(crypto.randomBytes(16).toString("base64"));
    await expect(aes.seal("hello", ctx(aes))).rejects.toThrow(/CACHE_ENC_KEY/);
  });

  it("still rejects an unset key", async () => {
    vi.resetModules();
    delete process.env.CACHE_ENC_KEY;
    const aes = await import("../lib/crypto/aesgcm");
    await expect(aes.seal("hello", ctx(aes))).rejects.toThrow(/CACHE_ENC_KEY is not set/);
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

      const aes = await freshAesgcm(variant);
      expect(await aes.open(await aes.seal("x", ctx(aes)), ctx(aes)), `aesgcm rejected: ${JSON.stringify(variant)}`).toBe("x");
    }
    delete process.env.INSTANCE_SIGNING_KEY;
  });
});
