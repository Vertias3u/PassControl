import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

// Sibling guard to docs-integrations.test.ts, for the same failure mode one level
// up: that file stops the INTEGRATION list drifting from `cli/presets.mjs`; this
// one stops the CLI's own Quick start block drifting from the README.
//
// It drifted. `passcontrol try` — since removed in 0.8.0 — shipped and was named
// in `--help` and nowhere else. A reader arriving from npm or GitHub was sent to
// `passcontrol setup` (Docker + the Supabase CLI + a full local stack) because
// the fast path was only discoverable by running `--help` on a CLI they had not
// yet installed.
//
// A command the CLI advertises as the quick start, that the quick-start doc
// never names, effectively does not exist.

// The readme is PUBLIC_README.md here and README.md in the curated public repo
// (scripts/curate-public.sh renames it), so it is named by both — the same
// two-name fallback docs-integrations.test.ts documents.
const READMES = ["PUBLIC_README.md", "README.md"] as const;

async function readme(): Promise<string> {
  for (const candidate of READMES) {
    try {
      return await readFile(new URL(`../${candidate}`, import.meta.url), "utf8");
    } catch {
      continue;
    }
  }
  throw new Error(`none of ${READMES.join(" / ")} exists — the doc guard is not reading anything`);
}

/**
 * Pull the command words out of the CLI's Quick start help block by reading the
 * source as text. Deliberately not an import: bin/passcontrol.mjs is an
 * executable entry point, and parsing beats running it just to read a string.
 */
async function quickStartCommands(): Promise<string[]> {
  const source = await readFile(new URL("../bin/passcontrol.mjs", import.meta.url), "utf8");
  const block = /heading\("Quick start"\)\}\n([\s\S]*?)\n\n/.exec(source)?.[1];
  if (!block) throw new Error("could not find the Quick start block in bin/passcontrol.mjs");

  const commands = [...block.matchAll(/^\s*\$\{cmd\}\s+([a-z][a-z-]*)/gmu)]
    .map(([, name]) => name)
    .filter((name): name is string => typeof name === "string");
  if (commands.length === 0) throw new Error("Quick start block parsed to zero commands — the guard is vacuous");
  return commands;
}

describe("the readme names every command the CLI advertises as a quick start", () => {
  it("parses the Quick start block", async () => {
    // Non-vacuity: if the help text is reworded so the regex misses, this fails
    // loudly rather than silently asserting nothing.
    // Was "try" until 0.8.0 removed it. The probe has to name a command that is
    // actually IN the block, or the guard silently stops guarding — which is the
    // exact class of failure this file exists to catch.
    expect(await quickStartCommands()).toContain("login");
  });

  it("names each one", async () => {
    const text = await readme();
    const commands = await quickStartCommands();
    const missing = commands.filter((name) => !text.includes(`passcontrol ${name}`));

    expect(missing, `the readme never mentions: ${missing.map((n) => `passcontrol ${n}`).join(", ")}`).toEqual([]);
  });
});
