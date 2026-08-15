import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

const css = read("app/globals.css");
const shell = read("components/dashboard/DashboardShell.tsx");
const login = read("components/auth/LoginForm.tsx");
const signup = read("components/auth/SignupForm.tsx");

describe("sticky dashboard surfaces", () => {
  it("derives the agent navigation offset from the rendered sticky stack", () => {
    expect(shell).toContain("<DashboardStickyOffsets />");
    expect(css).toMatch(/\.pc-agent-subnav\s*\{[\s\S]*?top:\s*var\(--pc-sticky-stack-offset/);
    expect(css).toMatch(/\.pc-elevation-bar\s*\{[\s\S]*?top:\s*var\(--pc-sticky-header-offset/);
  });
});

describe("account entry actions", () => {
  it.each([
    ["sign in", login],
    ["create account", signup],
  ])("keeps the %s action compact instead of forcing a card-width button", (_label, source) => {
    expect(source).toContain('className="pc-auth-submit"');
    expect(source).not.toContain('style={{ width: "100%" }}');
  });

  it("keeps each submit icon next to its label in a touch-sized control", () => {
    expect(css).toMatch(/\.pc-auth-submit\s*\{[\s\S]*?display:\s*inline-flex/);
    expect(css).toMatch(/\.pc-auth-submit\s*\{[\s\S]*?min-height:\s*2\.75rem/);
    expect(css).toMatch(/\.pc-auth-submit\s*\{[\s\S]*?width:\s*fit-content/);
  });
});
