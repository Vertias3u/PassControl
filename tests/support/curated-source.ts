import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Read a repo file the way scripts/curate-public.sh publishes it to the
// self-host mirror: private marker blocks removed, and each public-only block
// uncommented (one leading `//`). Lets a private-tree test assert what
// self-hosters will actually get. The marker words are assembled from MARK
// below and never written out whole here: curation would act on them.

const MARK = "curate:";
const PRIVATE_START = `${MARK}private-start`;
const PRIVATE_END = `${MARK}private-end`;
const PUBLIC_ONLY_START = `${MARK}public-only-start`;
const PUBLIC_ONLY_END = `${MARK}public-only-end`;

export function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

export function curated(path: string): string {
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

/**
 * What the self-host mirror ships at `path`. A file with a `.selfhost` sibling
 * (scripts/curate-public.sh's REPLACE table) is swapped for that sibling, which
 * is already Core's text; anything else is the curated private file.
 */
export function coreSource(path: string): string {
  const sibling = path.replace(/(\.[a-z]+)$/u, ".selfhost$1");
  return existsSync(resolve(process.cwd(), sibling)) ? source(sibling) : curated(path);
}
