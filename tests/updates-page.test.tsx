import { readFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import UpdatesPage from "@/app/updates/page";
import sitemap from "@/app/sitemap";
import { RELEASE_NOTES } from "@/lib/release-notes";

/** What renderToStaticMarkup does to text nodes. */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
}

async function source(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

async function publicReadme(): Promise<string> {
  for (const candidate of ["PUBLIC_README.md", "README.md"]) {
    try {
      return await source(candidate);
    } catch {
      continue;
    }
  }
  throw new Error("neither public readme source exists — the updates link guard is reading nothing");
}

describe("public release notes", () => {
  it("keeps every entry useful to a non-technical reader", () => {
    expect(RELEASE_NOTES.length).toBeGreaterThan(0);

    for (const note of RELEASE_NOTES) {
      expect(note.title.trim()).not.toBe("");
      expect(note.headline.trim()).not.toBe("");
      expect(note.highlights.length).toBeGreaterThan(0);
      for (const highlight of note.highlights) {
        expect(highlight.title.trim()).not.toBe("");
        expect(highlight.body.trim()).not.toBe("");
      }
    }
  });

  it("orders unique releases newest first", () => {
    const versions = RELEASE_NOTES.map((note) => note.version);
    expect(new Set(versions).size).toBe(versions.length);

    const timestamps = RELEASE_NOTES.map((note) => Date.parse(`${note.date}T00:00:00Z`));
    expect(timestamps.every(Number.isFinite)).toBe(true);
    expect(timestamps).toEqual([...timestamps].sort((a, b) => b - a));
  });

  it("keeps private paths, project refs, and credential shapes out of public copy", () => {
    const publicCopy = JSON.stringify(RELEASE_NOTES);
    expect(publicCopy).not.toMatch(/[a-z]{20}\.supabase\.co/i);
    expect(publicCopy).not.toMatch(/\b(?:pc_|sk-|eyJ)[A-Za-z0-9_-]+/);
    expect(publicCopy).not.toMatch(/\b(?:hardening|plans)\//i);
    expect(publicCopy).not.toMatch(/TEAMSHARE/i);
  });

  it("renders exactly one linkable section per release", () => {
    const html = renderToStaticMarkup(<UpdatesPage />);
    expect(html.match(/data-release-version=/g) ?? []).toHaveLength(RELEASE_NOTES.length);

    for (const note of RELEASE_NOTES) {
      expect(html).toContain(`id="v${note.version.replaceAll(".", "-")}"`);
      // Escaped, because React escapes it on the way out. Comparing raw copy
      // against rendered markup passes only while the copy happens to contain no
      // apostrophe, quote or ampersand — so the first headline written in plain
      // English ("Google's Gemini models…") turned this red, which reads as the
      // page failing to render a release rather than as an encoding mismatch.
      expect(html).toContain(escapeHtml(note.headline));
    }
  });

  it("publishes the archive through the sitemap and public entry points", async () => {
    expect(sitemap().map((entry) => entry.url)).toContain(
      "https://passcontrol.vertias.eu/updates"
    );

    const [home, middleware, readme] = await Promise.all([
      source("app/page.tsx"),
      source("middleware.ts"),
      publicReadme(),
    ]);
    expect(home).toContain('href="/updates"');
    expect(middleware).toMatch(/const PUBLIC_PATHS = \[[^\]]*"\/updates"/);
    expect(readme).toContain("https://passcontrol.vertias.eu/updates");
  });
});
