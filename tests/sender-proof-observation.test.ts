import { describe, it, expect } from "vitest";

import { toSenderProofObservations } from "@/lib/sender-proof-observation";

const row = (would: string | null) => ({ sender_proof_would: would });

describe("summarising what observe mode saw", () => {
  it("reports nothing observed when the mode is off", () => {
    expect(toSenderProofObservations("off", [row(null), row(null)])).toMatchObject({
      mode: "off",
      observed: 0,
      wouldPass: 0,
      safeToRequire: false,
    });
  });

  it("counts each verdict it understands", () => {
    const summary = toSenderProofObservations("observe", [
      row("pass"),
      row("pass"),
      row("missing"),
      row("invalid"),
      row("clock_skew"),
      row("replayed"),
    ]);
    expect(summary.observed).toBe(6);
    expect(summary.wouldPass).toBe(2);
    expect(summary.failures).toEqual({
      missing: 1,
      invalid: 1,
      clock_skew: 1,
      replayed: 1,
    });
  });

  // Drift is dropped, not guessed at, exactly as lib/policy-shadow.ts drops a
  // verdict it does not recognise. A future verdict counted as a failure would
  // make an operator think their fleet was broken by a build they upgraded.
  it("ignores a verdict this build does not know", () => {
    const summary = toSenderProofObservations("observe", [row("pass"), row("teleported")]);
    expect(summary.observed).toBe(1);
    expect(summary.wouldPass).toBe(1);
  });

  // The one number an operator actually wants, and the one most likely to be
  // read as more than it is. It answers "would requiring this have refused any
  // of the traffic I can see" — nothing about traffic that did not happen, and
  // nothing about clients that have not called yet.
  it("only calls it safe to require when every observed attempt passed", () => {
    expect(toSenderProofObservations("observe", [row("pass"), row("pass")]).safeToRequire).toBe(true);
    expect(toSenderProofObservations("observe", [row("pass"), row("missing")]).safeToRequire).toBe(
      false
    );
  });

  // A sample of zero is not a clean bill of health. Without this, an agent that
  // has made no calls since observe was switched on reads as "safe to require",
  // and the operator locks out a fleet on the strength of no evidence at all.
  it("refuses to call an empty sample safe", () => {
    expect(toSenderProofObservations("observe", []).safeToRequire).toBe(false);
    expect(toSenderProofObservations("observe", [row(null), row(null)]).safeToRequire).toBe(false);
  });

  // The same honesty lib/policy-shadow.ts carries: writeLog is best-effort and
  // gives up after two failed inserts, so these numbers are a floor. And rows
  // with no verdict are attempts an earlier gate decided before authentication
  // was ever reached, or attempts from before the mode was switched on.
  it("says when the sample contains attempts it saw nothing for", () => {
    expect(toSenderProofObservations("observe", [row("pass"), row(null)]).partial).toBe(true);
    expect(toSenderProofObservations("observe", [row("pass")]).partial).toBe(false);
  });

  // Enforcement is a different claim from observation: under `required` a bad
  // proof was REFUSED, so it never reaches this sample. Reporting "100% pass"
  // there would be circular.
  it("does not present enforced traffic as evidence about enforcement", () => {
    const summary = toSenderProofObservations("required", [row("pass"), row("pass")]);
    expect(summary.mode).toBe("required");
    expect(summary.safeToRequire).toBe(false);
  });
});
