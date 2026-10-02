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

  it("keeps Bearer precedence when x-api-key contains a Direct Agent Key", () => {
    const h = new Headers({
      authorization: "Bearer passport-visa",
      "x-api-key": `pc_agent_${"A".repeat(43)}`,
    });
    expect(extractVisaToken(h)).toBe("passport-visa");
  });

  it("returns empty string when neither header carries a usable token", () => {
    expect(extractVisaToken(new Headers())).toBe("");
    expect(extractVisaToken(new Headers({ authorization: "Basic abc" }))).toBe("");
    expect(extractVisaToken(new Headers({ "x-api-key": "   " }))).toBe("");
  });
});

// GitHub's clients (Octokit's `auth`, `gh`) send `Authorization: token <x>`.
// The service route reads that scheme too — owner decision 2026-09-30 — and
// ONLY as the last resort: a request that carries Bearer or x-api-key reads
// exactly what it read before, so no request that authenticates today changes.
describe("extractVisaToken — GitHub's `token` scheme, opt-in", () => {
  it("is not read unless the route asks for it", () => {
    expect(extractVisaToken(new Headers({ authorization: "token visa-abc" }))).toBe("");
  });

  it("is read when the route asks, case-insensitively, trimmed", () => {
    const opt = { tokenScheme: true };
    expect(extractVisaToken(new Headers({ authorization: "token visa-abc" }), opt)).toBe("visa-abc");
    expect(extractVisaToken(new Headers({ authorization: "Token visa-abc" }), opt)).toBe("visa-abc");
    expect(extractVisaToken(new Headers({ authorization: "TOKEN   visa-abc  " }), opt)).toBe("visa-abc");
  });

  it("is still no credential when empty", () => {
    const opt = { tokenScheme: true };
    expect(extractVisaToken(new Headers({ authorization: "token " }), opt)).toBe("");
    expect(extractVisaToken(new Headers({ authorization: "token" }), opt)).toBe("");
    expect(extractVisaToken(new Headers({ authorization: "tokenvisa-abc" }), opt)).toBe("");
  });

  it("never outranks x-api-key", () => {
    const h = new Headers({ authorization: "token ghp_real_github_token", "x-api-key": "visa-key" });
    expect(extractVisaToken(h, { tokenScheme: true })).toBe("visa-key");
  });

  it("leaves Bearer exactly as it was", () => {
    const h = new Headers({ authorization: "Bearer visa-auth", "x-api-key": "visa-key" });
    expect(extractVisaToken(h, { tokenScheme: true })).toBe("visa-auth");
  });
});
