// What observe mode saw, and what it is honest to conclude from it.
//
// Pure, for the same reason lib/policy-shadow.ts and lib/audit-history.ts are:
// the judgement is the part worth testing, and a test should not need a React
// tree to reach it.
//
// ── Four things this refuses to overstate ───────────────────────────────────
//
// 1. IT IS A FLOOR, NOT A CENSUS. `writeLog` is best-effort by design and gives
//    up after two failed inserts. A database blip loses the audit row and the
//    observation with it, so these numbers can only ever be "at least this
//    many". `partial` exists so the panel can say so.
//
// 2. AN EMPTY SAMPLE IS NOT A CLEAN BILL OF HEALTH. An agent that has made no
//    calls since observe was switched on has produced no evidence whatsoever,
//    and "no failures" reads identically to "no traffic" if you only count
//    failures. `safeToRequire` is therefore false on an empty sample — the
//    difference between them is a locked-out fleet.
//
// 3. ENFORCED TRAFFIC IS NOT EVIDENCE ABOUT ENFORCEMENT. Under `required` a bad
//    proof was refused, so it never reaches this sample at all. Reading a 100%
//    pass rate there as "safe to require" would be circular, so `safeToRequire`
//    is only ever true in `observe`.
//
// 4. IT ANSWERS A NARROW QUESTION. "Would requiring this have refused any of the
//    traffic I can see?" — not "is my fleet ready", which would also depend on
//    clients that have not called yet and on traffic that never happened. The
//    panel wording has to carry that distinction; the number cannot.
//
// Unlike a shadow-policy verdict, an observation is per REQUEST rather than per
// attempt: the proof is checked once, at authentication, before any provider is
// chosen. The proxy records it on the primary attempt's row only, so these are
// requests and the labels say so.
import {
  SENDER_PROOF_OBSERVATIONS,
  type SenderConstraintMode,
  type SenderProofObservation,
} from "./sender-constraint";

type FailureVerdict = Exclude<SenderProofObservation, "pass">;

export interface SenderProofSummary {
  mode: SenderConstraintMode;
  /** Requests that carried a verdict at all. The denominator. */
  observed: number;
  wouldPass: number;
  /** Every failing verdict, counted separately — the shape matters more than the total. */
  failures: Record<FailureVerdict, number>;
  /**
   * True when the sample contains requests with no verdict: the mode was off
   * when they were recorded, they used a Direct Agent Key, or an earlier gate
   * decided before authentication was reached.
   */
  partial: boolean;
  /**
   * Every request we saw would have been admitted under `required`, and we saw
   * at least one. Narrow on purpose — see the header.
   */
  safeToRequire: boolean;
}

function verdict(row: unknown): SenderProofObservation | null {
  const value = (row as { sender_proof_would?: unknown } | null)?.sender_proof_would;
  return SENDER_PROOF_OBSERVATIONS.includes(value as SenderProofObservation)
    ? (value as SenderProofObservation)
    : null;
}

export function toSenderProofObservations(
  mode: SenderConstraintMode,
  rows: readonly unknown[]
): SenderProofSummary {
  const failures: Record<FailureVerdict, number> = {
    missing: 0,
    invalid: 0,
    clock_skew: 0,
    replayed: 0,
  };
  let observed = 0;
  let wouldPass = 0;
  let partial = false;

  for (const row of rows) {
    const found = verdict(row);
    // A row we cannot read a verdict from is a request this sample says nothing
    // about — dropped, never counted as a failure. A verdict from a future build
    // counted as a failure would tell an operator an upgrade broke their fleet.
    if (found === null) {
      partial = true;
      continue;
    }
    observed += 1;
    if (found === "pass") wouldPass += 1;
    else failures[found] += 1;
  }

  return {
    mode,
    observed,
    wouldPass,
    failures,
    partial,
    safeToRequire: mode === "observe" && observed > 0 && wouldPass === observed,
  };
}
