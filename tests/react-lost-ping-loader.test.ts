// The build-time repair for the vendored React that Next 15 ships to the browser.
//
// Why this exists (the full account is in lib/build/react-lost-ping-loader.cjs):
// on a production build, router.refresh() and every server action that revalidates
// a dashboard route left the transition pending forever. React registers a wake-up
// ("ping") on a streamed RSC chunk; when that chunk is already resolved, the ping
// fires synchronously, inside the render, and the vendored canary drops it once the
// render is already "suspended with delay". The lane is then marked suspended with
// nothing left to wake it. React fixed this upstream: the React Next 16.3.6 vendors
// records the ping instead of dropping it. The loader applies that one change.
//
// These tests run the loader against the REAL vendored files, so a Next upgrade
// that changes them fails here, not in a browser.
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { patchReactLostPing, TARGET_FILE } = require("../lib/build/react-lost-ping-loader.cjs") as {
  patchReactLostPing: (source: string, resourcePath: string) => string;
  TARGET_FILE: RegExp;
};

const VENDORED = "node_modules/next/dist/compiled/react-dom/cjs";
const read = (name: string) => readFileSync(`${VENDORED}/${name}`, "utf8");

// The dropped branch, exactly as each build shape writes it.
const DROPS_PING_MINIFIED = /\?\s*0 === \(executionContext & 2\) &&\s*prepareFreshStack\(root, 0\)/;
const DROPS_PING_DEV = /\?\s*\(executionContext & RenderContext\) === NoContext &&\s*prepareFreshStack\(root, 0\)/;
const RECORDS_PING_MINIFIED =
  /\?\s*0 === \(executionContext & 2\)\s*\?\s*prepareFreshStack\(root, 0\)\s*:\s*\(workInProgressRootPingedLanes \|= pingedLanes\)\s*:\s*\(workInProgressRootPingedLanes \|= pingedLanes\)/;
const RECORDS_PING_DEV =
  /\?\s*\(executionContext & RenderContext\) === NoContext\s*\?\s*prepareFreshStack\(root, 0\)\s*:\s*\(workInProgressRootPingedLanes \|= pingedLanes\)\s*:\s*\(workInProgressRootPingedLanes \|= pingedLanes\)/;

describe("the vendored React this build ships", () => {
  it("still has the dropped-ping branch the loader exists to repair", () => {
    // If this fails after a Next upgrade, check whether the new vendored React
    // records the ping (then remove the loader) — do not just delete the test.
    expect(read("react-dom-client.production.js")).toMatch(DROPS_PING_MINIFIED);
  });
});

describe("patchReactLostPing on the real vendored files", () => {
  for (const [name, drops, records] of [
    ["react-dom-client.production.js", DROPS_PING_MINIFIED, RECORDS_PING_MINIFIED],
    ["react-dom-profiling.profiling.js", DROPS_PING_MINIFIED, RECORDS_PING_MINIFIED],
    ["react-dom-client.development.js", DROPS_PING_DEV, RECORDS_PING_DEV],
    ["react-dom-profiling.development.js", DROPS_PING_DEV, RECORDS_PING_DEV],
  ] as const) {
    it(`${name}: records a ping that arrives during render instead of dropping it`, () => {
      const source = read(name);
      const out = patchReactLostPing(source, `/x/${VENDORED}/${name}`);
      expect(out).not.toMatch(drops);
      expect(out).toMatch(records);
      // One branch changed, nothing else: the rest of the file is byte-identical.
      const [before, after] = source.split(drops);
      expect(out.startsWith(before!)).toBe(true);
      expect(out.endsWith(after!)).toBe(true);
    });

    it(`${name}: is idempotent`, () => {
      const once = patchReactLostPing(read(name), `/x/${VENDORED}/${name}`);
      expect(patchReactLostPing(once, `/x/${VENDORED}/${name}`)).toBe(once);
    });
  }
});

describe("every vendored file the rule reaches", () => {
  it("is one the loader recognises, so no build stops on a file it was never meant for", () => {
    const roots = ["react-dom", "react-dom-experimental"].map((c) => `node_modules/next/dist/compiled/${c}/cjs`);
    const matched = roots.flatMap((dir) =>
      readdirSync(dir).map((f) => `${process.cwd()}/${dir}/${f}`).filter((p) => TARGET_FILE.test(p))
    );
    expect(matched.length).toBeGreaterThanOrEqual(4);
    for (const p of matched) expect(() => patchReactLostPing(readFileSync(p, "utf8"), p)).not.toThrow();
  });
});

describe("patchReactLostPing on other inputs", () => {
  it("passes an upstream-fixed React through unchanged (the shape Next 16.3.6 ships)", () => {
    const fixed = `workInProgressRoot === root &&
    (workInProgressRootRenderLanes & pingedLanes) === pingedLanes &&
    (4 === workInProgressRootExitStatus ||
    (3 === workInProgressRootExitStatus && 300 > now() - globalMostRecentFallbackTime)
      ? 0 === (executionContext & 2)
        ? prepareFreshStack(root, 0)
        : (workInProgressRootPingedLanes |= pingedLanes)
      : (workInProgressRootPingedLanes |= pingedLanes),`;
    expect(patchReactLostPing(fixed, "/x/react-dom-client.production.js")).toBe(fixed);
  });

  it("refuses a React it does not recognise, instead of shipping it unrepaired", () => {
    const unknown = "function pingSuspendedRoot(root, wakeable, pingedLanes) { somethingNew(); }";
    expect(() => patchReactLostPing(unknown, "/x/react-dom-client.production.js")).toThrow(/react-lost-ping-loader/);
  });

  it("refuses a file with the dropped branch twice rather than guessing which one", () => {
    const twice = [
      "a ? 0 === (executionContext & 2) && prepareFreshStack(root, 0) : (workInProgressRootPingedLanes |= pingedLanes)",
      "b ? 0 === (executionContext & 2) && prepareFreshStack(root, 0) : (workInProgressRootPingedLanes |= pingedLanes)",
    ].join("\n");
    expect(() => patchReactLostPing(twice, "/x/react-dom-client.production.js")).toThrow(/2/);
  });
});

describe("which files the webpack rule sends through the loader", () => {
  it.each([
    "/app/node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.production.js",
    "/app/node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.development.js",
    "/app/node_modules/next/dist/compiled/react-dom/cjs/react-dom-profiling.profiling.js",
    "/app/node_modules/next/dist/compiled/react-dom-experimental/cjs/react-dom-client.production.js",
    "C:\\app\\node_modules\\next\\dist\\compiled\\react-dom\\cjs\\react-dom-client.production.js",
  ])("matches %s", (p) => expect(TARGET_FILE.test(p)).toBe(true));

  it.each([
    "/app/node_modules/next/dist/compiled/react-dom/cjs/react-dom-server.edge.production.js",
    "/app/node_modules/react-dom/cjs/react-dom-client.production.js",
    "/app/lib/react-dom-client.production.js",
  ])("leaves %s alone", (p) => expect(TARGET_FILE.test(p)).toBe(false));
});

// Loaded by path: the config is plain .mjs with no declaration file.
type WebpackConfig = { module: { rules: unknown[] }; cache: false | { buildDependencies: Record<string, string[]> } };
const loadNextConfig = async () =>
  ((await import("../next.config.mjs" as string)) as { default: { webpack: (c: unknown, o: unknown) => WebpackConfig } }).default;

describe("next.config.mjs", () => {
  it("routes the vendored client React through the loader and keys the build cache on it", async () => {
    const config = await loadNextConfig();
    const base = { module: { rules: [] as unknown[] }, cache: { type: "filesystem", buildDependencies: { config: ["x"] } } };
    const out = config.webpack(base, { isServer: false, dev: false });
    const rule = out.module.rules.at(-1) as { test: RegExp; use: Array<{ loader: string }> };
    expect(rule.test).toBe(TARGET_FILE);
    expect(rule.use[0]!.loader).toMatch(/lib[\\/]build[\\/]react-lost-ping-loader\.cjs$/);
    // A restored .next/cache (Vercel keeps it between builds) must not serve a
    // module compiled before the loader existed or changed.
    const cache = out.cache as Exclude<WebpackConfig["cache"], false>;
    expect(cache.buildDependencies.config).toContain("x");
    expect(cache.buildDependencies.reactLostPing).toEqual([rule.use[0]!.loader]);
  });

  it("tolerates a webpack config with the cache disabled", async () => {
    const config = await loadNextConfig();
    const out = config.webpack({ module: { rules: [] }, cache: false }, { isServer: true, dev: true });
    expect(out.cache).toBe(false);
    expect(out.module.rules).toHaveLength(1);
  });
});
