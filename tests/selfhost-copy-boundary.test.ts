import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const MARK = "curate:";
const PRIVATE_START = `${MARK}private-start`;
const PRIVATE_END = `${MARK}private-end`;
const PUBLIC_ONLY_START = `${MARK}public-only-start`;
const PUBLIC_ONLY_END = `${MARK}public-only-end`;

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

function curated(path: string): string {
  const withoutPrivate = source(path).replace(
    new RegExp(`^[^\\n]*${PRIVATE_START}.*?${PRIVATE_END}[^\\n]*\\n`, "gms"),
    ""
  );
  const output: string[] = [];
  let insidePublicOnly = false;
  for (const line of withoutPrivate.split("\n")) {
    if (line.includes(PUBLIC_ONLY_START)) {
      insidePublicOnly = true;
      continue;
    }
    if (line.includes(PUBLIC_ONLY_END)) {
      insidePublicOnly = false;
      continue;
    }
    output.push(insidePublicOnly ? line.replace(/^(\s*)\/\/ ?/u, "$1") : line);
  }
  return output.join("\n");
}

describe("self-hosted issuer and copy boundary", () => {
  it("derives Core metadata from the configured issuer and suppresses hosted artwork", () => {
    const layout = curated("app/layout.tsx");

    expect(layout).toContain('from "@/lib/crypto/instanceKey"');
    expect(layout).toContain("instanceIssuer()");
    expect(layout).toContain("images: []");
    expect(layout).toContain('creator: "PassControl"');
    expect(layout).toContain('publisher: "PassControl"');
    expect(layout).not.toContain("passcontrol.vertias.eu");
    expect(layout).not.toContain("vertias.eu");
    expect(layout).not.toContain('name: "Vertias"');
  });

  it("names the configured instance as the passport issuer", () => {
    const detail = curated("app/verify/[passportId]/page.tsx");

    expect(detail).toContain('import { instanceIssuer } from "@/lib/crypto/instanceKey"');
    expect(detail).toContain("instanceIssuer() ??");
    expect(detail).not.toContain("Vertias · PassControl");
  });

  it("makes verifier privacy and issuance claims instance-generic", () => {
    for (const path of [
      "app/verify/page.tsx",
      "app/verify/[passportId]/page.tsx",
      "app/verify/[passportId]/not-found.tsx",
      "app/verify/receipt/page.tsx",
      "components/ReceiptVerifier.tsx",
    ]) {
      const text = curated(path);
      expect(text, path).not.toMatch(/Vertias/);
    }
    expect(curated("components/ReceiptVerifier.tsx")).toContain("never leaves this browser");
  });


  it("publishes no hosted origin from the metadata routes", () => {
    // sitemap.xml, robots.txt and llms.txt are served from the self-hoster's own
    // host, so every absolute URL in them is a claim about who runs the instance.
    // They are also the three surfaces no HTML sweep looks at: the pages were clean
    // while the sitemap still advertised our domain from their deployment.
    const sitemap = curated("app/sitemap.ts");
    const robots = curated("app/robots.ts");
    const llms = curated("app/llms.txt/route.ts");

    for (const [name, file] of [["sitemap", sitemap], ["robots", robots], ["llms.txt", llms]] as const) {
      expect(file, name).not.toContain("passcontrol.vertias.eu");
    }
    expect(sitemap).toContain("instanceIssuer()");
    expect(robots).toContain("instanceIssuer()");
    // Core's llms.txt keeps the two links about the software and drops the address
    // that would send an assistant to us about someone else's instance.
    expect(llms).toContain("github.com/Vertias3u/PassControl");
    const hostedContactToken = ["PASSCONTROL", "CONTACT_EMAIL}`"].join("_");
    expect(llms).not.toContain(hostedContactToken);
  });

  it("carries no company mark in the browser tab", () => {
    // app/icon.svg is swapped by curation's REPLACE table rather than marked, so the
    // file is icon.selfhost.svg here and icon.svg in the mirror. Named by both, in
    // that order — both exist privately and the private icon.svg is the company
    // mark. Same fallback as tests/selfhost-landing.test.ts, same reason.
    const icon = ["app/icon.selfhost.svg", "app/icon.svg"]
      .map((candidate) => {
        try {
          return source(candidate);
        } catch {
          return null;
        }
      })
      .find((content) => content !== null);
    if (icon === undefined) throw new Error("neither icon file exists — this guard reads nothing");
    expect(icon).not.toMatch(/#b7f34a["'\s]*\/>|M29 57/);
    expect(icon).toContain('aria-label="PassControl"');
  });

  it("ships no hosted share-card artwork for Next to emit by convention", async () => {
    // `images: []` in app/layout.tsx does not settle this: Next reads
    // app/opengraph-image.* and app/twitter-image.* by FILE CONVENTION and emits
    // them anyway. Until curation pruned the four files, every page of a
    // self-hosted deployment advertised our card, served from their hostname,
    // with alt text naming the company. Checked here as a fact about the tree,
    // because it is invisible in the source of any single file.
    const { access } = await import("node:fs/promises");
    for (const asset of [
      "app/opengraph-image.png",
      "app/opengraph-image.alt.txt",
      "app/twitter-image.png",
      "app/twitter-image.alt.txt",
    ]) {
      await expect(access(new URL(`../${asset}`, import.meta.url)), asset).rejects.toThrow();
    }
  });


  it("uses neutral profile examples", () => {
    const profile = curated("components/ProfileSettings.tsx");
    for (const hostedExample of ["Vertias Ops", 'placeholder="Vertias"', "vertias.eu"]) {
      expect(profile).not.toContain(hostedExample);
    }
  });

});
