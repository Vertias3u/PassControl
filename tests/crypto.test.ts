import { describe, it, expect } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import { verifySignature, passportIdToPublicKey } from "../lib/crypto/ed25519";
import { bytesToBase64url, utf8ToBytes, jsonToBase64url, base64urlToBytes } from "../lib/encoding";
import { scopeAllows } from "../lib/scope";

describe("ed25519 passport verification", () => {
  const priv = ed25519.utils.randomPrivateKey();
  const pub = ed25519.getPublicKey(priv);
  const passportId = bytesToBase64url(pub);
  const payload = jsonToBase64url({ passport_id: passportId, ts: Date.now(), nonce: "n1" });
  const payloadBytes = base64urlToBytes(payload);
  const sig = ed25519.sign(payloadBytes, priv);

  it("accepts a valid signature", () => {
    expect(verifySignature(sig, payloadBytes, pub)).toBe(true);
  });

  it("rejects a tampered message", () => {
    const tampered = new Uint8Array(payloadBytes);
    tampered[0] = tampered[0]! ^ 0xff;
    expect(verifySignature(sig, tampered, pub)).toBe(false);
  });

  it("rejects a tampered signature", () => {
    const badSig = new Uint8Array(sig);
    badSig[0] = badSig[0]! ^ 0xff;
    expect(verifySignature(badSig, payloadBytes, pub)).toBe(false);
  });

  it("round-trips passport_id <-> public key", () => {
    expect(passportIdToPublicKey(passportId)).toEqual(pub);
  });

  it("rejects malformed passport_id", () => {
    expect(passportIdToPublicKey("not-32-bytes")).toBeNull();
  });
});

describe("scope matching", () => {
  const scopes = [{ provider: "anthropic", models: ["claude-*"] }, { provider: "openai", models: ["gpt-4o"] }];
  it("allows wildcard model match", () => {
    expect(scopeAllows(scopes, "anthropic", "claude-3-5-sonnet-20241022")).toBe(true);
  });
  it("allows exact model match", () => {
    expect(scopeAllows(scopes, "openai", "gpt-4o")).toBe(true);
  });
  it("denies model outside scope", () => {
    expect(scopeAllows(scopes, "openai", "gpt-4o-mini")).toBe(false);
  });
  it("denies wrong provider", () => {
    expect(scopeAllows(scopes, "anthropic", "gpt-4o")).toBe(false);
  });
});
