// Build-time repair for the React that Next 15 vendors into the browser bundle.
//
// THE BUG. On a production build, router.refresh() and every server action that
// revalidates a route could leave the transition pending forever: the RSC
// response arrived in full, the page never changed, and only a reload showed the
// new state. React suspends on a streamed RSC chunk and registers a wake-up
// ("ping") on it. When that chunk is already resolved, the ping fires
// synchronously, while React is still rendering. In the vendored
// 19.2.0-canary-0bdb9206-20250818, pingSuspendedRoot then does nothing if the
// render is already "suspended with delay" (a transition that must keep showing
// the old screen): it neither restarts the render (not allowed mid-render) nor
// records the ping. The lane is marked suspended with no wake-up left, so it
// never renders again.
//
// THE FIX is upstream React's own: in that same branch, record the ping
// (`workInProgressRootPingedLanes |= pingedLanes`) when a restart is not
// allowed. The React that Next 16.3.6 vendors (19.3.0-canary-cbb046ab-20260731)
// has exactly this shape. Next 15.5.26, the newest 15.x, does not.
//
// WHY A LOADER. Next ignores the installed react/react-dom for the App Router
// and bundles its own copy from next/dist/compiled, so there is no version to
// bump short of Next 16. Rewriting that file as webpack reads it leaves
// node_modules untouched and runs on every webpack `next build` — Vercel and a
// self-hoster's `npm run build` — with no postinstall step that a
// `--ignore-scripts` install would skip. The Cloudflare build runs `next build`
// under OpenNext, so it should apply there too; that build has not been run
// with it.
//
// FAIL LOUD. A vendored React this loader does not recognise stops the build.
// Shipping it unrepaired would bring the stall back silently; passing an
// upstream-fixed React through untouched is the only other outcome.
//
// Remove this file (and its rule in next.config.mjs) when Next is upgraded to a
// version whose vendored React already records the ping — the test
// tests/react-lost-ping-loader.test.ts says so when that happens.
"use strict";

/** The client React files Next vendors: stable and experimental channels, every build flavour. */
const TARGET_FILE =
  /[\\/]next[\\/]dist[\\/]compiled[\\/]react-dom(?:-experimental)?[\\/]cjs[\\/]react-dom-(?:client|profiling|unstable_testing)\.(?:production|development|profiling)\.js$/;

const RECORD = "(workInProgressRootPingedLanes |= pingedLanes)";

// `?  <may restart> && prepareFreshStack(root, 0)  :  <record>` — the restart is
// skipped mid-render and nothing is recorded. The minified builds inline the
// context constant; the development builds name it.
const DROPS = [
  /\?(\s*)(0 === \(executionContext & 2\)) &&\s*prepareFreshStack\(root, 0\)(\s*:\s*\(workInProgressRootPingedLanes \|= pingedLanes\))/g,
  /\?(\s*)(\(executionContext & RenderContext\) === NoContext) &&\s*prepareFreshStack\(root, 0\)(\s*:\s*\(workInProgressRootPingedLanes \|= pingedLanes\))/g,
];

// Upstream's shape: the inner condition is itself a conditional that records.
const RECORDS =
  /\?\s*(?:0 === \(executionContext & 2\)|\(executionContext & RenderContext\) === NoContext)\s*\?\s*prepareFreshStack\(root, 0\)\s*:\s*\(workInProgressRootPingedLanes \|= pingedLanes\)/;

function patchReactLostPing(source, resourcePath) {
  const hits = DROPS.map((re) => source.match(re)?.length ?? 0);
  const total = hits[0] + hits[1];
  if (total === 1) {
    const re = DROPS[hits[0] === 1 ? 0 : 1];
    return source.replace(re, (_all, space, mayRestart, recordBranch) =>
      `?${space}${mayRestart} ? prepareFreshStack(root, 0) : ${RECORD}${recordBranch}`
    );
  }
  if (total === 0 && RECORDS.test(source)) return source;
  throw new Error(
    `react-lost-ping-loader: expected exactly one dropped-ping branch in ${resourcePath}, found ${total}` +
      (total === 0 ? " and no upstream-fixed branch either" : "") +
      ". The vendored React changed; see lib/build/react-lost-ping-loader.cjs before building."
  );
}

module.exports = function reactLostPingLoader(source) {
  return patchReactLostPing(source, this.resourcePath);
};
module.exports.patchReactLostPing = patchReactLostPing;
module.exports.TARGET_FILE = TARGET_FILE;
