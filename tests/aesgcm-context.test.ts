// Cloud review 2026-11-03, A2: seal/open used no additional authenticated data, so a
// sealed value was not bound to the cache entry it was stored under. Anyone who could
// write to Redis (a leaked Upstash token, the threat the envelope exists for) could copy
// tenant A's sealed provider key to `key:<their agent>:<provider>`, and the gateway
// would decrypt it and send A's key on the attacker's calls. Each sealed value now names
// what it is for, and opens only there.
import { beforeAll, describe, expect, it } from "vitest";
import { bytesToBase64url } from "@/lib/encoding";

const KEY = Buffer.alloc(32, 9).toString("base64");
let aes: typeof import("@/lib/crypto/aesgcm");
beforeAll(async () => {
  process.env.CACHE_ENC_KEY = KEY;
  aes = await import("@/lib/crypto/aesgcm");
});

describe("a sealed value opens only for what it was sealed for", () => {
  it("opens under its own context", async () => {
    const ctx = aes.sealContext.providerKey("agent-a", "openai", null);
    expect(await aes.open(await aes.seal("sk-real", ctx), ctx)).toBe("sk-real");
  });

  it("another agent's cache entry does not open it (the substitution)", async () => {
    const sealed = await aes.seal("sk-tenant-a", aes.sealContext.providerKey("agent-a", "openai", null));
    expect(await aes.open(sealed, aes.sealContext.providerKey("agent-b", "openai", null))).toBeNull();
  });

  it("nor another provider, nor another credential", async () => {
    const sealed = await aes.seal("sk", aes.sealContext.providerKey("agent-a", "openai", "cred-1"));
    expect(await aes.open(sealed, aes.sealContext.providerKey("agent-a", "anthropic", "cred-1"))).toBeNull();
    expect(await aes.open(sealed, aes.sealContext.providerKey("agent-a", "openai", "cred-2"))).toBeNull();
    expect(await aes.open(sealed, aes.sealContext.providerKey("agent-a", "openai", null))).toBeNull();
  });

  it("the three uses never open each other's values", async () => {
    const ctxs = [
      aes.sealContext.providerKey("u", "openai", null),
      aes.sealContext.keyImport("u", "openai"),
      aes.sealContext.deviceGrant("u"),
    ];
    for (const a of ctxs) {
      const sealed = await aes.seal("x", a);
      for (const b of ctxs) expect(await aes.open(sealed, b)).toBe(a === b ? "x" : null);
    }
  });

  it("contexts cannot be forged by joining fields differently", () => {
    expect(aes.sealContext.providerKey("a:b", "c", null)).not.toBe(aes.sealContext.providerKey("a", "b:c", null));
    expect(aes.sealContext.keyImport("a", "b|c")).not.toBe(aes.sealContext.keyImport("a|b", "c"));
  });

  it("a value sealed before contexts existed is a clean miss, not an error", async () => {
    const raw = Buffer.from(KEY, "base64");
    const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode("sk-old")));
    const legacy = `${bytesToBase64url(iv)}.${bytesToBase64url(ct)}`;
    expect(await aes.open(legacy, aes.sealContext.providerKey("agent-a", "openai", null))).toBeNull();
  });
});
