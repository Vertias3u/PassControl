import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function source(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("homepage marketing contract", () => {
  it("leads with one concrete promise and the invite-beta conversion", async () => {
    const home = await source("app/page.tsx");
    expect(home).toContain("Agents get access. <em>You keep control.</em>");
    expect(home).toContain('const INVITE_URL = "/beta"');
    expect(home).toContain("Cloud access is invite-only. Self-hosting is available now.");
  });

  it("pins the security-relevant key-custody and demo promises", async () => {
    const home = await source("app/page.tsx");
    expect(home).toContain("uses your provider key server-side");
    expect(home).toContain("Provider keys stay out of agent environments.");
    expect(home).toContain("A blocked call never reaches the provider.");
    expect(home).toContain(
      "This demo does not contact a paid model or access a provider key. The control"
    );
    expect(home).toContain("decisions are real; the model response is simulated.");
    expect(home).not.toMatch(/credential (?:is )?released/i);
  });

  it("keeps the visible FAQ and FAQPage data on one shared source", async () => {
    const home = await source("app/page.tsx");
    for (const question of [
      "Where does my provider key live?",
      "Does my agent need a new SDK?",
      "Can I inspect or run PassControl myself?",
    ]) {
      expect(home.match(new RegExp(question.replace(/[?]/g, "\\?"), "g"))).toHaveLength(1);
    }
    expect(home).toContain("mainEntity: FAQ_ITEMS.map");
    expect(home).toContain("{FAQ_ITEMS.map((item) =>");
  });

  it("does not regress into generic category copy", async () => {
    const home = (await source("app/page.tsx")).toLowerCase();
    for (const phrase of [
      "revolutionary",
      "seamless",
      "next-generation",
      "agent economy",
      "trust layer",
      "unleash",
      "enterprise-grade",
      "ai-powered security",
      "secure your ai journey",
      "zero trust",
    ]) {
      expect(home).not.toContain(phrase);
    }
  });

  it("ships the scoped visual system and reduced-motion fallback", async () => {
    const [home, css] = await Promise.all([
      source("app/page.tsx"),
      source("app/home.module.css"),
    ]);
    expect(home).toContain('import styles from "./home.module.css"');
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).not.toContain("scroll-timeline");
  });
});
