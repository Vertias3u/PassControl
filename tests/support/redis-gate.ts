/**
 * Whether a real-Redis suite may skip, must run, or must fail the lane.
 *
 * Kept out of the suite it governs on purpose. A gate that lives inside the
 * tests it gates cannot be tested by them: if it decides wrongly, the suite is
 * skipped and nothing reports it.
 */
export interface RedisGateDecision {
  /** True when the suite should execute against a live SRH. */
  run: boolean;
  /**
   * Present only when the absence of SRH must turn the lane RED. Carries the
   * message to throw — it names the URL that was tried, because a lane that
   * goes red months from now must read as "the service is missing", not as
   * "this test is broken".
   */
  fail?: string;
}

export function redisGate(opts: {
  reachable: boolean;
  /** Running on CI, where a missing prerequisite is a build failure. */
  ci: boolean;
  url: string;
}): RedisGateDecision {
  if (opts.reachable) return { run: true };
  if (!opts.ci) return { run: false };
  return {
    run: false,
    fail:
      `The real-Redis money boundary could not run: no SRH at ${opts.url}. ` +
      `On CI this FAILS rather than skips — a green build that skipped the ` +
      `reserve/settle/dispatch scripts has not tested the money boundary at ` +
      `all. Check the redis and srh service containers in .github/workflows/ci.yml.`,
  };
}
