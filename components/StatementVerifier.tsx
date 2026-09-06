"use client";
// The public spend-statement verifier — sdk/verify.ts, with a face.
//
// Everything here runs in the browser, exactly as the receipt verifier does. The
// pasted statement never leaves this page; the only network call is to the
// issuer's own /.well-known/jwks.json for its public keys. That is the claim the
// page is making, so it runs the SAME exported function a third party would run
// on their own machine, and anyone can open devtools and watch it.
//
// THIS PAGE PUBLISHES NOTHING. The visitor supplies the artifact. It is not the
// (deliberately unbuilt) surface that would publish a workspace's statements at
// an address, and no copy here should imply that one exists.
//
// Every outcome carries a `data-state`, because on this product a green suite
// once coexisted with a forged receipt rendering "Signature matches ✓".
import { useCallback, useState } from "react";

import {
  STEP_ORDER,
  initialStepRows,
  rowsFailingAt,
  type FailurePresentation,
  type StepRow,
} from "@/lib/verify/receipt-view";
import {
  STATEMENT_LIMITS,
  describeChain,
  describeCoverage,
  describeStatementFailure,
  formatStatementCost,
  formatWindow,
  peekStatement,
  statementPreflight,
} from "@/lib/verify/statement-view";
import { verifyStatement, type StatementClaims, type VerifyStep } from "@/sdk/verify";

type Outcome =
  | { kind: "valid"; claims: StatementClaims }
  | { kind: "invalid"; presentation: FailurePresentation };

const STEP_LABEL: Record<(typeof STEP_ORDER)[number], string> = {
  parse: "Reads as a signed document",
  algorithm: "Uses the signature algorithm we accept",
  type: "Is a spend statement, not something else",
  issuer: "Names an issuer we can go and ask",
  version: "Is a version this checker understands",
  jwks: "Issuer published its keys",
  key: "Signing key is one the issuer publishes",
  signature: "Signature matches the contents",
};

export function StatementVerifier() {
  const [input, setInput] = useState("");
  const [rows, setRows] = useState<StepRow[]>(initialStepRows);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [running, setRunning] = useState(false);

  const run = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || running) return;
    setRunning(true);
    setOutcome(null);

    // Settle locally first, so the page fails at the row that actually refused
    // it — and so a malformed paste never causes a network call.
    const early = statementPreflight(trimmed);
    if (early) {
      setRows(rowsFailingAt(early.step));
      setOutcome({ kind: "invalid", presentation: describeStatementFailure(early.reason, early.step) });
      setRunning(false);
      return;
    }

    // The issuer the statement NAMES, read by the same decoder the preflight
    // used rather than by an inline base64 expression — padding rules and
    // url-alphabet swaps are exactly where a hand-rolled decode goes wrong, and
    // this one decides which origin we are about to fetch keys from.
    //
    // Trusting the named issuer is the design: this page verifies statements
    // from deployments we have never heard of. `statementPreflight` has already
    // refused anything that is not a fetchable https origin, which is the check
    // that keeps "trust what it claims" from meaning "fetch anything it says".
    const issuer = peekStatement(trimmed).issuer!;
    const seen: VerifyStep[] = [];
    setRows(initialStepRows());
    const result = await verifyStatement(trimmed, {
      trustedIssuers: [issuer],
      onStep: (step) => seen.push(step),
    });

    const failedAt = seen.find((s) => !s.ok);
    setRows(
      failedAt
        ? rowsFailingAt(failedAt.step, failedAt.ms)
        : STEP_ORDER.map((name) => ({
            name,
            state: "pass" as const,
            ms: seen.find((s) => s.step === name)?.ms ?? 0,
          }))
    );
    setOutcome(
      result.ok
        ? { kind: "valid", claims: result.claims }
        : { kind: "invalid", presentation: describeStatementFailure(result.reason, failedAt?.step) }
    );
    setRunning(false);
  }, [input, running]);

  return (
    <section className="grid gap-6">
      <div className="grid gap-3">
        <label htmlFor="statement" className="text-sm font-semibold text-foreground">
          Paste a spend statement
        </label>
        {/*
          The placeholder is truncated on purpose, exactly as ReceiptVerifier's
          is: a longer sample matches curate-public.sh's `eyJ[A-Za-z0-9_-]{20,}`
          secret scanner, and a placeholder that looks like a token cannot be
          told from a leaked one at the mirror boundary.
        */}
        <textarea
          id="statement"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={5}
          spellCheck={false}
          placeholder="eyJhbGciOiJFZERTQSIs… (one long line, two dots in it)"
          className="w-full rounded-lg border border-border bg-background p-3 font-mono text-xs"
        />
        <div>
          <button type="button" onClick={run} disabled={running || !input.trim()} className="pc-button">
            {running ? "Checking…" : "Check it"}
          </button>
        </div>
      </div>

      {outcome ? (
        <ol className="grid gap-1 text-sm" data-state="steps">
          {rows.map((row) => (
            <li key={row.name} data-step={row.name} data-state={row.state} className="flex gap-2">
              <span aria-hidden>
                {row.state === "pass" ? "✓" : row.state === "fail" ? "✗" : "·"}
              </span>
              <span className={row.state === "not-reached" ? "text-muted-foreground" : undefined}>
                {STEP_LABEL[row.name]}
              </span>
              {row.ms !== null ? (
                <span className="ml-auto text-xs text-muted-foreground">{row.ms}ms</span>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}

      {outcome?.kind === "invalid" ? (
        <div
          className="rounded-lg border border-[var(--danger)] p-4 text-sm"
          data-state="invalid"
          data-failure={outcome.presentation.kind}
        >
          <p className="m-0 font-bold text-foreground">{outcome.presentation.title}</p>
          <p className="mt-2 mb-0 text-muted-foreground">{outcome.presentation.body}</p>
        </div>
      ) : null}

      {outcome?.kind === "valid" ? <ValidStatement claims={outcome.claims} /> : null}

      <section className="rounded-xl border border-border bg-secondary/50 p-6 text-sm leading-6 text-muted-foreground">
        <h2 className="m-0 text-base font-bold text-foreground">
          What this page does and does not say
        </h2>
        <ul className="mt-3 mb-0 grid list-disc gap-2 pl-5">
          {STATEMENT_LIMITS.map((limit) => (
            <li key={limit.body}>
              <strong className="text-foreground">{limit.claim}</strong> {limit.body}
            </li>
          ))}
        </ul>
      </section>
    </section>
  );
}

function ValidStatement({ claims }: { claims: StatementClaims }) {
  const coverage = describeCoverage(claims);
  const chain = describeChain(claims);

  return (
    <div className="grid gap-4 rounded-lg border border-[var(--success)] p-4 text-sm" data-state="valid">
      <p className="m-0 font-bold text-foreground">
        Signed by {claims.iss}, and unchanged since.
      </p>

      <dl className="m-0 grid gap-2">
        <div className="flex gap-3">
          <dt className="w-28 shrink-0 text-muted-foreground">Window</dt>
          <dd className="m-0" data-field="window">{formatWindow(claims.per)}</dd>
        </div>
        <div className="flex gap-3">
          <dt className="w-28 shrink-0 text-muted-foreground">Workspace</dt>
          <dd className="m-0 font-mono text-xs" data-field="sub">{claims.sub}</dd>
        </div>
        <div className="flex gap-3">
          <dt className="w-28 shrink-0 text-muted-foreground">Total</dt>
          <dd className="m-0" data-field="cost">{formatStatementCost(claims.cost)}</dd>
        </div>
        <div className="flex gap-3">
          <dt className="w-28 shrink-0 text-muted-foreground">Commitment</dt>
          <dd className="m-0 break-all font-mono text-xs" data-field="root">
            {claims.root ?? "none — this window covered no receipts"}
          </dd>
        </div>
      </dl>

      <div data-state={`coverage-${coverage.state}`}>
        <p className="m-0">{coverage.headline}</p>
        {coverage.notes.length > 0 ? (
          <ul className="mt-2 mb-0 grid list-disc gap-1 pl-5 text-[var(--warning)]">
            {coverage.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        ) : null}
      </div>

      <p className="m-0 text-muted-foreground" data-state={`chain-${chain.state}`}>
        {chain.text}
      </p>
    </div>
  );
}
