import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function source(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("homepage marketing contract", () => {

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
