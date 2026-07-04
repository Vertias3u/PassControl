import { describe, it, expect } from "vitest";
import {
  validateAgentInput,
  validateProviderKeyInput,
  validateRotateInput,
} from "../lib/validate";

// A valid base64url-encoded 32-byte key (43 chars, no padding).
const VALID_PUBKEY = "A".repeat(43);

describe("validateAgentInput", () => {
  it("accepts a well-formed agent", () => {
    const out = validateAgentInput({
      name: "  Bot  ",
      passportPubkey: VALID_PUBKEY,
      scopes: [{ provider: "anthropic", models: ["claude-*"] }],
    });
    expect(out.name).toBe("Bot");
    expect(out.scopes[0]!.provider).toBe("anthropic");
  });
  it("rejects empty name", () => {
    expect(() => validateAgentInput({ name: "", passportPubkey: VALID_PUBKEY, scopes: [] })).toThrow();
  });
  it("rejects bad pubkey", () => {
    expect(() => validateAgentInput({ name: "x", passportPubkey: "nope", scopes: [] })).toThrow();
  });
  it("rejects unknown provider", () => {
    expect(() =>
      validateAgentInput({ name: "x", passportPubkey: VALID_PUBKEY, scopes: [{ provider: "evil", models: ["*"] }] })
    ).toThrow();
  });
});

describe("validateProviderKeyInput", () => {
  it("accepts valid", () => {
    expect(validateProviderKeyInput({ provider: "openai", label: "main", key: "sk-x" }).provider).toBe("openai");
  });
  it("rejects unknown provider + empty key", () => {
    expect(() => validateProviderKeyInput({ provider: "x", label: "", key: "k" })).toThrow();
    expect(() => validateProviderKeyInput({ provider: "openai", label: "", key: "" })).toThrow();
  });
});

describe("validateRotateInput", () => {
  it("requires a UUID credential id", () => {
    expect(() => validateRotateInput({ credentialId: "not-a-uuid", key: "k" })).toThrow();
    expect(
      validateRotateInput({ credentialId: "123e4567-e89b-12d3-a456-426614174000", key: "k" }).key
    ).toBe("k");
  });
});
