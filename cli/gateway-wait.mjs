// How long to wait for a freshly started local dashboard to answer.
//
// This was a flat 30-second budget inside bin/passcontrol.mjs, and it was wrong
// in the way that matters most: a cold Next.js first compile of this app takes
// roughly 30 seconds, so the budget expired just as the dashboard was about to
// come up. `passcontrol setup` then printed "Dashboard did not become ready"
// against a stack that was working perfectly — the first thing a new
// self-hoster ever sees from this tool, telling them their install failed.
//
// Raising the flat number is the obvious fix and it is a bad one: a genuinely
// dead start would then sit there for two minutes before admitting it. Slower
// failure in exchange for fewer false failures is not a trade worth making on a
// first run, where the user has no idea which of the two they are looking at.
//
// So the budget is conditional on evidence, and the three cases are distinct:
//
//   the supervising process has exited  →  stop now. It is not coming back, and
//                                          the log has the reason.
//   the port is listening               →  the server is up and is compiling.
//                                          That is slow exactly once, on the
//                                          first run. Extend, and SAY so.
//   neither                             →  nothing has happened yet. Keep the
//                                          original short budget so a broken
//                                          start is still reported quickly.
//
// Every probe is a parameter rather than an import: this file makes a decision
// about time, and a decision about time that can only be tested by waiting is a
// decision that does not get tested. See cli/__tests__/gateway-wait.test.mjs,
// which exercises the full 150-second path against a fake clock in no time.

const POLL_MS = 250;

/**
 * @param {object} opts
 * @param {() => Promise<boolean>} opts.probeGateway  does the gateway answer?
 * @param {() => Promise<boolean>} [opts.probePort]   is anything listening on the port?
 * @param {() => boolean} [opts.processAlive]         is the dashboard process still up?
 * @param {() => void} [opts.onCompiling]             called once, when the wait extends
 * @param {number} [opts.timeoutMs]                   budget with no sign of life
 * @param {number} [opts.compilingMs]                 budget once the port is listening
 * @param {() => number} [opts.now]
 * @param {(ms: number) => Promise<void>} [opts.pause]
 * @returns {Promise<boolean>} true if the gateway answered before the budget ran out
 */
export async function waitForGateway({
  probeGateway,
  probePort = null,
  processAlive = null,
  onCompiling = null,
  timeoutMs = 30_000,
  compilingMs = 150_000,
  now = () => Date.now(),
  pause = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const started = now();
  let deadline = started + timeoutMs;
  let announced = false;

  while (now() < deadline) {
    if (await probeGateway()) {
      // A response from the target is not proof that the process we launched
      // owns it. In particular, a port conflict can leave an unrelated server
      // answering while the launcher exits. The managed path requires both
      // facts on the same poll.
      if (processAlive && !processAlive()) return false;
      return true;
    }

    // Checked AFTER the gateway probe, never before: a process that exits the
    // instant it finishes handing off would otherwise be declared dead on the
    // same tick it became ready, which is the flaky-test version of this bug.
    if (processAlive && !processAlive()) return false;

    if (probePort && await probePort()) {
      deadline = Math.max(deadline, started + compilingMs);
      if (!announced) {
        announced = true;
        onCompiling?.();
      }
    }

    await pause(POLL_MS);
  }

  return false;
}
