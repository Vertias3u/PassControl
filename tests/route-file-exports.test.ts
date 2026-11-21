// `next build` refuses a route file that exports anything but handlers and segment config
// ("X is not a valid Route export field"). tsc and vitest do not check that, so a whole
// release went green while `vercel --prod` would have failed (1.8.0, TRIPWIRE_REPORT_SOURCE).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const CONFIG = ["runtime", "dynamic", "dynamicParams", "revalidate", "fetchCache", "preferredRegion", "maxDuration", "generateStaticParams"];
const ALLOWED = new Set([...METHODS, ...CONFIG]);

function routeFiles(): string[] {
  // A filesystem walk, not git ls-files: the curated mirror tree is checked before it is a repo.
  return (readdirSync("app", { recursive: true }) as string[])
    .map((f) => join("app", f))
    .filter((f) => /\/route\.(ts|tsx|js|mjs)$/.test(f));
}

function exportedNames(src: string): string[] {
  const names: string[] = [];
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) names.push(m[1]!);
  for (const m of src.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}/gm)) {
    if (/^export\s+type\s/.test(m[0])) continue;
    for (const part of m[1]!.split(",")) {
      const spec = part.trim();
      if (!spec || spec.startsWith("type ")) continue;
      names.push(spec.split(/\s+as\s+/).pop()!.trim());
    }
  }
  return names;
}

describe("route files export only what next build accepts", () => {
  it("finds the route files", () => {
    expect(routeFiles().length).toBeGreaterThan(20);
  });

  it("every export is a handler or segment config", () => {
    const bad = routeFiles().flatMap((f) =>
      exportedNames(readFileSync(f, "utf8")).filter((n) => !ALLOWED.has(n)).map((n) => `${f}: ${n}`)
    );
    expect(bad).toEqual([]);
  });

  it("the parser sees a stray export", () => {
    expect(exportedNames('export const FOO = "x";\nexport async function POST() {}\nexport { a as GET, b };\nexport type { T };')).toEqual(["FOO", "POST", "GET", "b"]);
  });
});
