"use client";
// Turning per-request passport proof on, and seeing whether it is safe to.
//
// ── The wording is the control ──────────────────────────────────────────────
//
// `required` refuses every call from a client that does not sign, and today the
// connector is the only client that does. Choosing it without understanding that
// is a fleet-wide outage, and this panel is the last place anyone can say so —
// there is no confirmation screen after it and no error that will explain it
// afterwards. So the consequence is stated at the control, in the same shape
// OwnerBinding.tsx states what publishing does.
//
// `observe` is the one most likely to be misread in the other direction: a proof
// IS being checked and it decides nothing. Every sentence about it has to close
// that gap, because "proof checking is on" and "proof is protecting me" are
// different claims and only one of them is true.
import { useState, useTransition } from "react";

import {
  setAgentSenderConstraint,
  type PassportActionState,
} from "@/app/dashboard/agents/[id]/passport-actions";
import type { SenderConstraintMode } from "@/lib/sender-constraint";
import type { SenderProofSummary } from "@/lib/sender-proof-observation";

const CHOICES: { mode: SenderConstraintMode; label: string; blurb: string }[] = [
  {
    mode: "off",
    label: "Off",
    blurb: "A work-visa is enough on its own. A proof sent anyway is not looked at.",
  },
  {
    mode: "observe",
    label: "Observe",
    blurb:
      "Proofs are checked and recorded, and nothing is ever refused because of one. Use this to find out whether requiring them would break anything, before it does.",
  },
  {
    mode: "required",
    label: "Required",
    blurb:
      "A call without a valid proof is refused. Any client that does not sign stops working — today that is everything except the PassControl connector.",
  },
];

const FAILURE_LABEL: Record<string, string> = {
  missing: "sent no proof",
  invalid: "sent a proof that did not verify",
  clock_skew: "sent a proof outside the time window (usually a wrong clock)",
  replayed: "reused a proof that had already been spent",
};

export function SenderProofPanel({
  agentId,
  mode,
  summary,
  hasPassport,
}: {
  agentId: string;
  mode: SenderConstraintMode;
  summary: SenderProofSummary;
  hasPassport: boolean;
}) {
  const [state, setState] = useState<PassportActionState>({});
  const [pending, start] = useTransition();
  const current = (state.senderConstraintMode as SenderConstraintMode | undefined) ?? mode;

  const failures = Object.entries(summary.failures).filter(([, count]) => count > 0);

  return (
    <section
      className="rounded-xl border border-border bg-card p-5 shadow-sm sm:p-6"
      data-panel="sender-proof"
      data-mode={current}
    >
      <h2 className="m-0 text-lg font-bold">Proof of possession</h2>
      <p className="mt-2 mb-0 text-sm leading-6 text-muted-foreground">
        A work-visa is a bearer token: whoever holds it can spend it. With proof required,
        every request must also carry a fresh signature from this passport&rsquo;s private
        key, bound to that exact visa, method and path — so a captured visa is useless on
        its own.
      </p>

      {!hasPassport ? (
        <p className="mt-4 mb-0 text-sm" style={{ color: "var(--warning)" }}>
          This agent authenticates with a Direct Agent Key, which is a bearer credential by
          design and has no passport key to prove possession of. Issue it a passport first.
        </p>
      ) : (
        <>
          <div className="mt-4 grid gap-2">
            {CHOICES.map((choice) => (
              <label
                key={choice.mode}
                className="grid cursor-pointer gap-1 rounded-lg border border-border p-3"
                data-choice={choice.mode}
                data-selected={current === choice.mode ? "true" : "false"}
                style={
                  current === choice.mode
                    ? { borderColor: "var(--pc-brand)", background: "var(--secondary)" }
                    : undefined
                }
              >
                <span className="flex items-center gap-2 text-sm font-semibold">
                  <input
                    type="radio"
                    name="sender-constraint-mode"
                    value={choice.mode}
                    checked={current === choice.mode}
                    disabled={pending}
                    onChange={() =>
                      start(async () =>
                        setState(await setAgentSenderConstraint(agentId, choice.mode))
                      )
                    }
                  />
                  {choice.label}
                </span>
                <span className="text-xs leading-5 text-muted-foreground">{choice.blurb}</span>
              </label>
            ))}
          </div>

          {/* The panel's whole reason for existing: an operator should be able to
              answer "would this break us?" from their own traffic rather than by
              trying it. Every claim here is bounded by what was actually seen. */}
          <div className="mt-4 rounded-lg border border-border bg-secondary/30 p-4" data-observations>
            {current === "observe" && summary.observed === 0 ? (
              <p className="m-0 text-sm text-muted-foreground">
                Nothing observed yet. This agent has made no calls since observing was
                switched on — which is not the same as passing, so it is shown as neither.
              </p>
            ) : summary.observed === 0 ? (
              <p className="m-0 text-sm text-muted-foreground">
                No observations. Switch to <strong>Observe</strong> to find out whether
                requiring proof would refuse any of your real traffic.
              </p>
            ) : (
              <>
                <p className="m-0 text-sm">
                  <strong>
                    {summary.wouldPass} of {summary.observed}
                  </strong>{" "}
                  recent requests carried a proof that verified.
                  {summary.partial
                    ? " Some requests in this window carried no proof verdict at all — they were decided before authentication, or came from before this was switched on."
                    : ""}
                </p>
                {failures.length ? (
                  <ul className="mt-2 mb-0 grid gap-1 pl-5 text-xs leading-5 text-muted-foreground">
                    {failures.map(([verdict, count]) => (
                      <li key={verdict}>
                        {count} {FAILURE_LABEL[verdict] ?? verdict}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <p className="mt-2 mb-0 text-xs leading-5 text-muted-foreground">
                  {summary.safeToRequire
                    ? "Every request we saw would have been admitted. That covers the traffic in this window only — a client that has not called yet has not been tested."
                    : current === "required"
                      ? "These were recorded while proof was already required, so a bad one was refused rather than counted. They are not evidence about whether requiring it is safe."
                      : "Requiring proof now would have refused the requests listed above."}
                </p>
              </>
            )}
          </div>
        </>
      )}

      {state.error ? (
        <p className="mt-3 mb-0 text-sm" style={{ color: "var(--danger)" }}>
          {state.error}
        </p>
      ) : null}
    </section>
  );
}
