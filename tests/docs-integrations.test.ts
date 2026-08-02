import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

// The shipped plain-ESM CLI is intentionally transpilation-free.
// @ts-expect-error JavaScript preset module has no TypeScript declaration file.
import { MCP_PRESETS, SIDECAR_PRESETS } from "@/cli/presets.mjs";

const sidecarPresets: string[] = SIDECAR_PRESETS;
const mcpPresets: string[] = MCP_PRESETS;

// The CLI's own usage strings are generated from cli/presets.mjs, so they can no
// longer drift. The PROSE cannot be generated — and it drifted anyway: six
// desktop presets shipped while PUBLIC_README, DOCUMENTATION and TUTORIAL all
// still advertised the older five, each with its own hand-typed list.
//
// These are the three docs a stranger actually reads (PUBLIC_README becomes the
// public repo's README.md), so an integration missing here is an integration
// that effectively does not exist. Naming a preset is cheap; discovering months
// later that nobody knew it existed is not.
// The readme is PUBLIC_README.md here and README.md in the curated public repo
// (scripts/curate-public.sh renames it), so it is named by both. Hardcoding the
// private name passed here and failed in the public tree — the one place the
// file is actually the README, and the one place CI runs on a fresh clone.
const READMES = ["PUBLIC_README.md", "README.md"] as const;
const PUBLIC_DOCS = ["readme", "DOCUMENTATION.md", "TUTORIAL.md"] as const;

async function doc(name: string): Promise<string> {
  const candidates = name === "readme" ? READMES : [name];
  for (const candidate of candidates) {
    try {
      return await readFile(new URL(`../${candidate}`, import.meta.url), "utf8");
    } catch {
      continue;
    }
  }
  throw new Error(`none of ${candidates.join(" / ")} exists — the doc guard is not reading anything`);
}

describe("public docs advertise every integration the CLI accepts", () => {
  it.each(PUBLIC_DOCS)("%s names every sidecar preset", async (path) => {
    const text = (await doc(path)).toLowerCase();
    const missing = sidecarPresets.filter((preset) => !text.includes(preset.toLowerCase()));

    expect(missing, `${path} never mentions: ${missing.join(", ")}`).toEqual([]);
  });

  // The MCP clients are documented in the same breath and drifted for the same
  // reason, so they are held to the same rule.
  it.each(PUBLIC_DOCS)("%s names every MCP preset", async (path) => {
    const text = (await doc(path)).toLowerCase();
    const missing = mcpPresets.filter((preset) => !text.includes(preset.toLowerCase()));

    expect(missing, `${path} never mentions: ${missing.join(", ")}`).toEqual([]);
  });
});
