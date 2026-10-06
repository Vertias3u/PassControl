import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The PassControl card in the sign-in/sign-up trust diagram carries the
// Vertias petal mark, not a stock shield icon (owner, 2026-10-04). Agent and
// Vault keep their generic icons: they are not ours.
describe("auth trust diagram", () => {
  const shell = readFileSync("components/auth/AuthShell.tsx", "utf8");

  it("marks the PassControl card with the Vertias logo", () => {
    const card = shell.slice(shell.indexOf('className="is-control"'), shell.indexOf("policy boundary"));
    expect(card).toMatch(/<SiteLogo size=\{16\} decorative \/>/);
    expect(card).not.toContain("ShieldCheck");
  });
});
