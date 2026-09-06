import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  AUTH_HMAC_LABELS,
  createAuthHmacKeyDeriver,
} from "@/lib/crypto/derived-auth-hmac";

const bytes = (value: string) => new TextEncoder().encode(value);

describe("derived authentication HMAC keys", () => {
  it("never reuses VISA_SECRET or one derived key across the two purposes", async () => {
    const visaSecret = "v".repeat(32);
    const derive = createAuthHmacKeyDeriver(visaSecret);

    const fingerprint = await derive.bytes(AUTH_HMAC_LABELS.passportSourceFingerprint);
    const rateLimit = await derive.bytes(AUTH_HMAC_LABELS.challengeRateLimit);

    expect(Buffer.from(fingerprint).equals(Buffer.from(bytes(visaSecret)))).toBe(false);
    expect(Buffer.from(fingerprint).equals(Buffer.from(rateLimit))).toBe(false);
  });

  it("imports and derives each purpose once, then reuses the same CryptoKey", async () => {
    const importKey = vi.spyOn(crypto.subtle, "importKey");
    const sign = vi.spyOn(crypto.subtle, "sign");
    const derive = createAuthHmacKeyDeriver("v".repeat(48));

    const first = await derive.key(AUTH_HMAC_LABELS.challengeRateLimit);
    const second = await derive.key(AUTH_HMAC_LABELS.challengeRateLimit);

    expect(second).toBe(first);
    expect(sign).toHaveBeenCalledTimes(1);
    // One import for VISA_SECRET and one for its non-extractable derived key.
    expect(importKey).toHaveBeenCalledTimes(2);
    importKey.mockRestore();
    sign.mockRestore();
  });

  it("keeps one signature-verification implementation and cached purpose keys in the challenge route", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "app/api/auth/challenge/route.ts"),
      "utf8"
    );

    expect(source.match(/verifySignature\(/gu)).toHaveLength(1);
    expect(source).toContain("authHmacKey(AUTH_HMAC_LABELS.challengeRateLimit)");
    expect(source).toContain("authHmacKey(AUTH_HMAC_LABELS.passportSourceFingerprint)");
  });
});
