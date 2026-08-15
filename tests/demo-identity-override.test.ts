import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const SOURCE_DIRS = ["app", "lib", "components", "sdk"];
const OWNER = path.join("lib", "demo", "identity.ts");

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|mjs)$/.test(entry.name)) out.push(path.relative(ROOT, full));
    }
  };
  for (const d of SOURCE_DIRS) {
    const abs = path.join(ROOT, d);
    if (fs.existsSync(abs)) walk(abs);
  }
  return out;
}

/**
 * The demo passport secret and control key are committed on purpose so the
 * keyless demo works out of the box — which means anyone can read them. The
 * ONLY thing that makes a hosted deployment safe is the env override in
 * `lib/demo/identity.ts` (`process.env.PASSCONTROL_DEMO_* || SEEDED_*`).
 *
 * A call site that reaches past the accessor to the raw constant silently opts
 * out of that rotation. That is exactly what `app/verify/page.tsx` did: it
 * linked the public /verify page straight at `SEEDED_DEMO_PASSPORT_ID`, so
 * rotating the hosted credentials would have left the page advertising a
 * retired passport while every other call site moved on.
 */
describe("demo identity rotation cannot be bypassed", () => {
  it("no source file outside lib/demo/identity.ts references the seeded constants", () => {
    const offenders: string[] = [];
    for (const rel of sourceFiles()) {
      if (rel === OWNER) continue;
      const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
      if (/SEEDED_DEMO_(PASSPORT_ID|PASSPORT_SECRET|CONTROL_KEY)/.test(text)) {
        offenders.push(rel);
      }
    }
    expect(
      offenders,
      `These files use a seeded demo constant directly and would ignore a rotation.\n` +
        `Call demoPassportId() / demoPassportSecret() / demoControlKey() instead:\n  ` +
        offenders.join("\n  "),
    ).toEqual([]);
  });

  it("the accessors prefer the environment over the committed fallback", () => {
    const text = fs.readFileSync(path.join(ROOT, OWNER), "utf8");
    for (const envVar of [
      "PASSCONTROL_DEMO_PASSPORT_ID",
      "PASSCONTROL_DEMO_PASSPORT_SECRET",
      "PASSCONTROL_DEMO_CONTROL_KEY",
    ]) {
      expect(text, `${envVar} must be readable as an override`).toContain(envVar);
    }
    // The env read has to come first in each accessor — `SEEDED || env` would
    // make the override dead code.
    const accessorBodies = text.match(/return\s*\(?[\s\S]*?;/g) ?? [];
    const bad = accessorBodies.filter(
      (b) => /SEEDED_DEMO_/.test(b) && /process\.env/.test(b) && b.indexOf("SEEDED_DEMO_") < b.indexOf("process.env"),
    );
    expect(bad, "an accessor falls back the wrong way round").toEqual([]);
  });
});
