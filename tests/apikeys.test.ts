import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { generateApiKey, hashApiKey, isApiKeyFormat, KEY_PREFIX, PREFIX_DISPLAY_LEN } from "../lib/apikeys";

describe("api key generation + hashing", () => {
  it("mints a pc_-prefixed, high-entropy token with a display prefix and matching hash", async () => {
    const k = await generateApiKey();
    expect(k.token.startsWith(KEY_PREFIX)).toBe(true);
    expect(k.token.length).toBeGreaterThanOrEqual(40); // pc_ + 32 random bytes b64url
    expect(k.prefix).toBe(k.token.slice(0, PREFIX_DISPLAY_LEN));
    expect(k.hash).toMatch(/^[0-9a-f]{64}$/); // sha-256 hex
    expect(await hashApiKey(k.token)).toBe(k.hash);
  });

  it("never repeats a token (CSPRNG)", async () => {
    const a = await generateApiKey();
    const b = await generateApiKey();
    expect(a.token).not.toBe(b.token);
    expect(a.hash).not.toBe(b.hash);
  });

  it("hashApiKey matches a reference SHA-256 and is deterministic", async () => {
    const ref = createHash("sha256").update("pc_example_token").digest("hex");
    expect(await hashApiKey("pc_example_token")).toBe(ref);
    expect(await hashApiKey("pc_example_token")).toBe(await hashApiKey("pc_example_token"));
  });

  it("does not store or expose the raw token in the generated record fields", async () => {
    const k = await generateApiKey();
    // The persisted shape is { prefix, hash } — hash is one-way, prefix is non-secret.
    expect(k.hash).not.toContain(k.token.slice(PREFIX_DISPLAY_LEN));
  });

  it("validates token format", () => {
    expect(isApiKeyFormat("pc_abcdefghijklmnopqrstuvwxyz123456")).toBe(true);
    expect(isApiKeyFormat("sk-not-ours")).toBe(false);
    expect(isApiKeyFormat("pc_short")).toBe(false);
    expect(isApiKeyFormat("")).toBe(false);
  });
});
