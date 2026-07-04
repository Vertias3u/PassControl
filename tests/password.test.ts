import { describe, it, expect } from "vitest";
import { validatePassword } from "../lib/password";

describe("validatePassword", () => {
  it("rejects passwords shorter than 12 chars", () => {
    expect(validatePassword("Ab1!xyz")).toMatch(/at least 12/);
  });

  it("rejects common passwords", () => {
    expect(validatePassword("password1234")).toMatch(/common/);
    expect(validatePassword("passcontrol1")).toBeTruthy();
  });

  it("rejects low-complexity strings that meet the length gate", () => {
    expect(validatePassword("aaaaaaaaaaaaaa")).toBeTruthy();
  });

  it("accepts a strong mixed password", () => {
    expect(validatePassword("Tr0ub4dor&3xyz")).toBeNull();
  });

  it("rejects absurdly long input", () => {
    expect(validatePassword("Aa1!".repeat(100))).toMatch(/too long/);
  });
});
