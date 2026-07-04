import { describe, it, expect, vi } from "vitest";
import { stepUpRequired, needsMfaStepUp } from "../lib/mfa";

describe("stepUpRequired", () => {
  it("requires step-up only when authenticated at aal1 with aal2 available", () => {
    expect(stepUpRequired("aal1", "aal2")).toBe(true); // has a factor, not yet verified
  });
  it("does NOT require step-up for a non-MFA user (the unchanged path)", () => {
    expect(stepUpRequired("aal1", "aal1")).toBe(false); // no factor
  });
  it("does NOT require step-up once already at aal2", () => {
    expect(stepUpRequired("aal2", "aal2")).toBe(false);
  });
  it("treats missing levels as no step-up", () => {
    expect(stepUpRequired(null, null)).toBe(false);
    expect(stepUpRequired("aal2", "aal1")).toBe(false);
  });
});

function supa(aal: { data?: { currentLevel: string; nextLevel: string }; error?: unknown } | (() => never)) {
  return {
    auth: {
      mfa: {
        getAuthenticatorAssuranceLevel: typeof aal === "function" ? aal : async () => aal,
      },
    },
  } as any;
}

describe("needsMfaStepUp", () => {
  it("true when aal1→aal2", async () => {
    expect(await needsMfaStepUp(supa({ data: { currentLevel: "aal1", nextLevel: "aal2" } }))).toBe(true);
  });
  it("false for a non-MFA user (aal1→aal1)", async () => {
    expect(await needsMfaStepUp(supa({ data: { currentLevel: "aal1", nextLevel: "aal1" } }))).toBe(false);
  });
  it("fails OPEN (false) on error — never locks out a legit user", async () => {
    expect(await needsMfaStepUp(supa({ error: { message: "down" } }))).toBe(false);
    expect(
      await needsMfaStepUp(
        supa(() => {
          throw new Error("network");
        })
      )
    ).toBe(false);
  });
});
