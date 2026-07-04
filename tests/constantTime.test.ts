import { describe, it, expect } from "vitest";
import { timingSafeEqual } from "../lib/crypto/constantTime";

describe("timingSafeEqual", () => {
  it("returns true for identical strings", () => {
    expect(timingSafeEqual("super-secret-token", "super-secret-token")).toBe(true);
  });
  it("returns false for different strings of equal length", () => {
    expect(timingSafeEqual("super-secret-token", "super-secret-tokeX")).toBe(false);
  });
  it("returns false for different lengths", () => {
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("", "x")).toBe(false);
  });
  it("handles unicode", () => {
    expect(timingSafeEqual("clé-secrète", "clé-secrète")).toBe(true);
    expect(timingSafeEqual("clé-secrète", "cle-secrete")).toBe(false);
  });
});
