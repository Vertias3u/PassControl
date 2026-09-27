import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/**
 * Every surface that turns a stored `agent_logs.status` into words for a human.
 * A status missing from any of these does not fail loudly — it falls through to
 * whatever that map's default is, which is how `no_provider_key` came to be
 * displayed as "the upstream provider returned an error" on a call that never
 * left the gateway. StatusPill.tsx already carries a comment about a previous
 * instance of exactly this.
 */
const DISPLAY_MAPS = [
  // The shared vocabulary (Session 06). The surfaces below that DERIVE their
  // words from it are still listed: each must either name every status itself
  // or import this module — dropping them from the list would be the gate
  // quietly checking less.
  "lib/call-outcome.ts",
  "lib/departures.ts",
  "lib/verify/receipt-view.ts",
  "components/AgentPassport.tsx",
  "components/StatusPill.tsx",
  "components/dashboard/CallDetailDrawer.tsx",
];

const SHARED_MAP = "lib/call-outcome.ts";

/**
 * The statuses a call can be logged with, parsed from the union in lib/log.ts.
 *
 * COMMENTS ARE STRIPPED FIRST, and that is not tidiness. The union is written
 * with a prose comment above most of its members, the region ends at the first
 * `;`, and a semicolon inside one of those comments therefore TRUNCATES the
 * parse — silently. When `blocked_budget_state` was added under a comment
 * reading "answers 402; an agent reads that as final", this function stopped
 * seeing it, every map below went on passing, and the status this file exists to
 * protect was the one it no longer checked.
 *
 * A gate that quietly narrows itself is worse than no gate: it reports success
 * about work it did not do. Stripping comments makes the parse depend on the
 * code rather than on the punctuation someone chose in a sentence.
 */
function logStatuses(): string[] {
  const src = read("lib/log.ts")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  const block = /status\??:\s*([\s\S]*?);/.exec(src);
  const region = block?.[1] ?? src;
  const found = new Set<string>();
  for (const m of region.matchAll(/"([a-z_]+)"/g)) {
    if (m[1]) found.add(m[1]);
  }
  return [...found];
}

/**
 * The text of a single map entry starting at `idx`. Object values (`key: { … },`)
 * run to their closing brace; string values run to the end of the line. Without
 * this the next entry bleeds in and the assertion tests the wrong thing.
 */
function entryText(src: string, idx: number): string {
  const after = src.slice(idx);
  const colon = after.indexOf(":");
  const isObject = after.slice(colon + 1).trimStart().startsWith("{");
  if (isObject) {
    const close = after.indexOf("},");
    return close === -1 ? after.slice(0, 600) : after.slice(0, close + 2);
  }
  const nl = after.indexOf("\n");
  return nl === -1 ? after : after.slice(0, nl);
}

describe("every log status has words on every surface", () => {
  it("parses a plausible status union", () => {
    const statuses = logStatuses();
    expect(statuses).toContain("ok");
    expect(statuses).toContain("upstream_error");
    expect(statuses).toContain("provider_exhausted");
    // Named explicitly because these two were added under comments containing
    // punctuation that used to truncate the parse above. If a future edit
    // re-breaks it, this fails here rather than by quietly checking less.
    expect(statuses).toContain("usage_unknown");
    expect(statuses).toContain("blocked_budget_state");
    expect(statuses.length).toBeGreaterThanOrEqual(8);
  });

  it.each(DISPLAY_MAPS)("%s renders every status", (file) => {
    const src = read(file);
    // A surface that takes its words from the shared map, and keeps no status
    // map of its own, is covered by that map's entry in this list — which must
    // name every status. A surface that imports it AND keeps its own map (the
    // board's aviation words, the drawer's explanations) is still checked.
    const derivesOnly =
      file !== SHARED_MAP &&
      src.includes(`from "@/lib/call-outcome"`) &&
      !/Record<(LogEntry\["status"\]|StatusType)/.test(src);
    if (derivesOnly) {
      expect(src).toMatch(/CALL_OUTCOME|callOutcome/);
      return;
    }
    const missing = logStatuses().filter((s) => !new RegExp(`\\b${s}\\b`).test(src));
    expect(
      missing,
      `${file} has no entry for: ${missing.join(", ")}.\n` +
        `An unmapped status silently falls through to that map's default, which is ` +
        `how a local refusal got reported as a provider failure.`,
    ).toEqual([]);
  });
});

describe("no_provider_key is not reported as a provider failure", () => {
  it("is a status of its own, not an alias for upstream_error", () => {
    // The gateway refuses locally because no key is stored; nothing is sent
    // upstream. Reusing upstream_error tells the operator to go debug an
    // provider account that never saw the request.
    expect(read("lib/log.ts")).toContain("no_provider_key");
  });

  it("is what the proxy logs when no provider key is stored", () => {
    const route = read("app/api/v1/[provider]/[...path]/route.ts");
    const idx = route.indexOf('errR(409, "no_provider_key")');
    expect(idx, "the 409 no_provider_key branch moved").toBeGreaterThan(-1);
    // The reconcile() that settles this branch sits just above the return.
    const branch = route.slice(Math.max(0, idx - 900), idx);
    expect(branch).toContain('"no_provider_key"');
    expect(
      /reconcile\([^)]*"upstream_error"/.test(branch),
      "this branch still settles as upstream_error",
    ).toBe(false);
  });

  // Every surface that still words this status itself — the shared map
  // included, which is asserted rather than assumed.
  const wordsNoKey = DISPLAY_MAPS.filter((file) => /\bno_provider_key\b/.test(read(file)));
  it("checks the shared map among them", () => expect(wordsNoKey).toContain(SHARED_MAP));

  it.each(wordsNoKey)("%s does not describe it as an upstream/provider fault", (file) => {
    const src = read(file);
    const idx = src.indexOf("no_provider_key");
    expect(idx, `${file} has no no_provider_key entry`).toBeGreaterThan(-1);
    // Scope strictly to THIS entry. A wider window runs into the neighbouring
    // upstream_error entry, which is legitimately allowed to say "Provider error".
    const entry = entryText(src, idx).toLowerCase();
    for (const phrase of ["upstream provider returned", "provider returned an error", "provider error"]) {
      expect(entry.includes(phrase), `${file} calls it "${phrase}"`).toBe(false);
    }
  });
});
