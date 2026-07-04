import { describe, it, expect } from "vitest";
import { extractVisaToken } from "../lib/auth/visa";

// Drop-in goal: a developer points their existing SDK at the gateway without
// rewriting auth. The OpenAI SDK sends the key as `Authorization: Bearer …`;
// the Anthropic SDK sends it as `x-api-key: …`. The proxy must accept the visa
// from whichever header the provider's native SDK uses.
describe("extractVisaToken — accept the visa from the provider's native header", () => {
  it("reads a Bearer token from Authorization (OpenAI SDK shape)", () => {
    const h = new Headers({ authorization: "Bearer visa-abc" });
    expect(extractVisaToken(h)).toBe("visa-abc");
  });

  it("is case-insensitive on the Bearer scheme and trims whitespace", () => {
    expect(extractVisaToken(new Headers({ authorization: "bearer   visa-xyz  " }))).toBe("visa-xyz");
  });

  it("reads x-api-key when Authorization is absent (Anthropic SDK shape)", () => {
    const h = new Headers({ "x-api-key": "visa-anthropic" });
    expect(extractVisaToken(h)).toBe("visa-anthropic");
  });

  it("prefers Authorization Bearer over x-api-key when both are present", () => {
    const h = new Headers({ authorization: "Bearer visa-auth", "x-api-key": "visa-key" });
    expect(extractVisaToken(h)).toBe("visa-auth");
  });

  it("returns empty string when neither header carries a usable token", () => {
    expect(extractVisaToken(new Headers())).toBe("");
    expect(extractVisaToken(new Headers({ authorization: "Basic abc" }))).toBe("");
    expect(extractVisaToken(new Headers({ "x-api-key": "   " }))).toBe("");
  });
});
