import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("the exported agent passport carries the canonical Vertias mark", () => {
  const passport = source("components/AgentPassport.tsx");
  const canonicalPaths = [
    "M29 57C25 47 12 36 10 20 8 9 14 3 19 6c6 4 7 20 9 33 1 8 1 13 1 18Z",
    "M29 57c-2-12-5-29-3-43 1-8 4-13 7-12 4 1 5 8 3 19-2 13-5 26-7 36Z",
    "M29 57c4-10 14-21 19-37 3-10-2-17-7-14-6 4-8 20-10 33-1 8-2 13-2 18Z",
  ];

  it("reuses all three SiteLogo paths instead of a hand-traced approximation", () => {
    expect(canonicalPaths).toHaveLength(3);
    for (const path of canonicalPaths) expect(passport).toContain(`d="${path}"`);
    expect(passport).toContain('<g transform="translate(44.6 36) scale(0.6)">');
  });

  it("resolves every accent to three export-safe literal fills", () => {
    const triples = [["#337fa9", "#3b95c6", "#4ab7f3"]];
    // Cloud carries green and violet. Curation removes both rows, leaving sky
    // as the public tree's only accent, so the same guard runs in both trees.
    for (const triple of triples) {
      for (const colour of triple) expect(passport).toContain(colour);
    }

    expect(passport).toContain("fill={PALETTE.petals.dark}");
    expect(passport).toContain("fill={PALETTE.petals.mid}");
    expect(passport).toContain("fill={PALETTE.petals.light}");
  });

  it("keeps the themed labels and backlights on the mark's light petal", () => {
    expect(passport).toMatch(
      /<circle cx="62" cy="54" r="18" fill=\{PALETTE\.petals\.light\}/
    );
    expect(passport).toMatch(
      /fill=\{PALETTE\.petals\.light\}[\s\S]*?>\s*WORK-VISA CONTROL\s*<\/text>/
    );
    expect(passport).toMatch(
      /fill=\{PALETTE\.petals\.light\}[\s\S]*?>\s*\{machineStrip\.slice\(0, 84\)\}\s*<\/text>/
    );
  });
});
