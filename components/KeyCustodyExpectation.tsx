"use client";
// The one thing the settings tab may honestly do about key custody.
//
// ── Why this is a statement and not a switch ────────────────────────────────
//
// research/passport-key-protection.md §5 answers the question an operator will
// ask the moment they see a declared tier: "can I just set this here?" No. The
// dashboard runs on the server, the passport private key lives on the agent's
// machine, and the server has never seen it — so nothing here can move a key,
// and §5 is blunt about the alternative: "Do not build a toggle that silently
// does nothing."
//
// What it allows instead is this: state an expectation, and let every surface
// that shows a declared tier say whether it was met. That is a real thing an
// operator can act on — it just acts on people, not on agents.
//
// ── The wording is the whole control ────────────────────────────────────────
//
// A control that LOOKS like enforcement is the forbidden toggle wearing a
// different label, so every state here has to keep two facts on screen: nothing
// is blocked, and the tier it is compared against is a self-report this gateway
// cannot check at any tier (§4). There is no tick, no "compliant", no count of
// violations.
import { useState, useTransition } from "react";

import { setKeyCustodyExpectation } from "@/app/dashboard/settings/key-custody-actions";
import type { KeyCustodyExpectationState } from "@/lib/key-custody-expectation";

const CHOICES: { value: string; label: string }[] = [
  { value: "none", label: "No expectation stated" },
  { value: "os", label: "Tier 1 — OS credential store (Keychain, libsecret, DPAPI)" },
];

export function KeyCustodyExpectation({
  state,
  expectation,
}: {
  state: KeyCustodyExpectationState["state"];
  expectation: string | null;
}) {
  const [current, setCurrent] = useState<string | null>(expectation);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <section
      className="rounded-xl border border-border bg-card p-5 shadow-sm sm:p-6"
      data-panel="key-custody-expectation"
      data-state={state}
      data-expectation={current ?? "none"}
    >
      <p className="m-0 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        Stated, not enforced
      </p>
      <h2 className="mt-2 mb-0 text-lg font-bold">Passport key custody expectation</h2>
      <p className="mt-2 mb-0 text-sm leading-6 text-muted-foreground">
        Where you expect your agents to keep their passport private keys. Every agent that
        has told this instance where it keeps its key is marked in the fleet table against
        this line. <strong>Nothing is blocked by it</strong>: an agent below the expectation
        keeps working exactly as before, no call is refused, and no receipt mentions it.
      </p>
      <p className="mt-2 mb-0 text-sm leading-6 text-muted-foreground">
        It could not be otherwise. The key never leaves the agent&rsquo;s machine — that is
        what a passport is — so this gateway cannot check a custody claim at any tier, and a
        gate whose key is &ldquo;say the right word&rdquo; would be worse than none. What
        this gives you is a line to hold people to, and a list of who is not on it.
      </p>

      {state === "ready" ? (
        <>
          <label className="mt-4 grid gap-2">
            <span className="text-sm font-semibold">Expectation for this workspace</span>
            <select
              className="rounded-lg border border-border bg-background p-2 text-sm"
              value={current ?? "none"}
              disabled={pending}
              onChange={(event) => {
                const next = event.target.value;
                start(async () => {
                  const result = await setKeyCustodyExpectation(next);
                  if (result.error) {
                    setError(result.error);
                    return;
                  }
                  setError(null);
                  setCurrent(result.expectation ?? null);
                });
              }}
            >
              {CHOICES.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </select>
          </label>
          <p className="mt-3 mb-0 text-xs leading-5 text-muted-foreground">
            Moving a key is done on the agent&rsquo;s own machine:{" "}
            <code>passcontrol key migrate</code>. Tier 0 is not offered as an expectation —
            it is the default every agent already meets, so stating it would say nothing.
          </p>
          {error ? (
            <p className="mt-3 mb-0 text-sm" style={{ color: "var(--warning)" }}>
              {error}
            </p>
          ) : null}
        </>
      ) : (
        // No control at all rather than one whose save is guaranteed to fail.
        <p className="mt-4 mb-0 text-sm leading-6" style={{ color: "var(--warning)" }}>
          {state === "unmigrated"
            ? "This instance has not applied migration 0051, so there is nowhere to record an expectation yet. Everything else on this page is unaffected, and the fleet table still shows what each agent declared."
            : "The workspace expectation could not be read from the database just now. Nothing has changed, and the fleet table still shows what each agent declared."}
        </p>
      )}
    </section>
  );
}
