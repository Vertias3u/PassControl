import { afterEach, describe, expect, it } from "vitest";
import { operatorEmails } from "@/lib/operator-allowlist";

const originalOperatorEmails = process.env.PASSCONTROL_BETA_OPERATOR_EMAILS;

afterEach(() => {
  if (originalOperatorEmails === undefined) {
    delete process.env.PASSCONTROL_BETA_OPERATOR_EMAILS;
  } else {
    process.env.PASSCONTROL_BETA_OPERATOR_EMAILS = originalOperatorEmails;
  }
});

describe("operatorEmails", () => {
  it("returns an empty set when the allowlist is unset", () => {
    delete process.env.PASSCONTROL_BETA_OPERATOR_EMAILS;
    expect(operatorEmails()).toEqual(new Set());
  });

  it("normalises whitespace and case", () => {
    expect([...operatorEmails(" Owner@Example.com, SECOND@example.COM ")]).toEqual([
      "owner@example.com",
      "second@example.com",
    ]);
  });

  it("returns a single configured address", () => {
    expect(operatorEmails("operator@example.com")).toEqual(
      new Set(["operator@example.com"])
    );
  });

  it("returns several configured addresses", () => {
    expect([...operatorEmails("one@example.com,two@example.com,three@example.com")]).toEqual([
      "one@example.com",
      "two@example.com",
      "three@example.com",
    ]);
  });
});
