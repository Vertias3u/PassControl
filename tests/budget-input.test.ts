import { describe, expect, it } from "vitest";
import {
  formatCentsAsUsdDisplay,
  formatCentsAsUsdInput,
  parseTokenBudgetInput,
  parseUsdBudgetToCents,
} from "@/lib/budget-input";

describe("dashboard budget input helpers", () => {
  it("parses blank token and dollar budgets as unlimited null", () => {
    expect(parseTokenBudgetInput("")).toBeNull();
    expect(parseTokenBudgetInput("   ")).toBeNull();
    expect(parseUsdBudgetToCents("")).toBeNull();
    expect(parseUsdBudgetToCents("   ")).toBeNull();
  });

  it("parses token budgets as non-negative whole numbers", () => {
    expect(parseTokenBudgetInput("0")).toBe(0);
    expect(parseTokenBudgetInput("250000")).toBe(250000);
    expect(() => parseTokenBudgetInput("-1")).toThrow();
    expect(() => parseTokenBudgetInput("1.5")).toThrow();
    expect(() => parseTokenBudgetInput("abc")).toThrow();
  });

  it("converts dollar budget input to integer cents", () => {
    expect(parseUsdBudgetToCents("0")).toBe(0);
    expect(parseUsdBudgetToCents("5")).toBe(500);
    expect(parseUsdBudgetToCents("5.00")).toBe(500);
    expect(parseUsdBudgetToCents("12.34")).toBe(1234);
  });

  it("rejects invalid dollar budget shapes", () => {
    expect(() => parseUsdBudgetToCents("-1")).toThrow();
    expect(() => parseUsdBudgetToCents("1.234")).toThrow();
    expect(() => parseUsdBudgetToCents("abc")).toThrow();
  });

  it("formats cents for edit inputs and table display", () => {
    expect(formatCentsAsUsdInput(null)).toBe("");
    expect(formatCentsAsUsdInput(500)).toBe("5.00");
    expect(formatCentsAsUsdDisplay(null)).toBe("∞");
    expect(formatCentsAsUsdDisplay(1234)).toBe("$12.34");
  });
});
