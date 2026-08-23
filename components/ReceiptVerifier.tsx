"use client";
// The public receipt verifier — sdk/verify.ts, with a face.
//
// ── Everything here runs in the browser, and that is the product ─────────────
//
// The pasted receipt never reaches Vertias. The only network call this makes is
// to the issuer's own /.well-known/jwks.json for its public keys. That is not a
// privacy nicety bolted on afterwards; it is the claim the page is making. A
// verifier you have to trust is not a verifier, so this page runs the *same*
// exported function a third party runs on their own machine, and anyone can
// open devtools and watch it do so.
//
// ── The reveal floor, and why it is not a lie ────────────────────────────────
//
// Every row below is a check that actually ran, and every duration shown is the
// real one. The one thing the UI adds is a FLOOR on how fast rows appear
// (REVEAL_FLOOR_MS), so that eight checks resolving in nine milliseconds are
// still legible. The checks are never slowed down — results that already
// happened are revealed on a paced timeline, and a step that genuinely takes
// longer (the key fetch will) simply waits for the real thing and reports it.
//
// The distinction matters more here than on most pages. On a product whose
// entire pitch is "do not take our word for it", a progress bar that invents
// duration to look busy is precisely the wrong lie to tell.
import { useCallback, useEffect, useRef, useState } from "react";
import { createPassportSigil } from "@/lib/passport-art";
import {
  applyStep,
  describeCall,
  describeTokenUse,
  describeReceiptAuthentication,
  describeFailure,
  describeOwner,
  describeFailover,
  describeVerdict,
  formatCost,
  formatSignedAt,
  initialStepRows,
  peekArtifact,
  preflight,
  rowsFailingAt,
  STEP_ORDER,
  type FailureKind,
  type FailurePresentation,
  type PeekResult,
  type RowState,
  type StepRow,
} from "@/lib/verify/receipt-view";
import { verifyReceipt, type ReceiptClaims, type VerifyStep, type VerifyStepName } from "@/sdk/verify";

const REVEAL_FLOOR_MS = 180;

const STEP_LABELS: Record<VerifyStepName, string> = {
  parse: "Reads as a signed artifact",
  algorithm: "Signed with Ed25519",
  type: "Typed as a call receipt",
  issuer: "Names an issuer we can look up",
  version: "A version this page understands",
  jwks: "Fetched the issuer's public keys",
  key: "Signed with a key that issuer publishes",
  signature: "Signature matches the contents",
};

/** Screen readers get the state as a word; the glyph is decoration. */
const STATE_WORDS: Record<RowState, string> = {
  waiting: "not started",
  active: "checking",
  pass: "passed",
  fail: "failed",
  "not-reached": "not reached",
};

/**
 * Reduced motion is not only about CSS. Pacing the reveal is itself animation,
 * so someone who has asked for less of it gets every result at once.
 */
const revealFloorMs = (): number =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ? 0
    : REVEAL_FLOOR_MS;

type Outcome =
  | { kind: "ok"; claims: ReceiptClaims; totalMs: number }
  | { kind: "failed"; presentation: FailurePresentation; totalMs: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function Sigil({ passportId, label }: { passportId: string; label?: string }) {
  const sigil = createPassportSigil(passportId);
  return (
    <svg
      className="pcv-sigil h-20 w-20 shrink-0 rounded-xl"
      viewBox="0 0 112 112"
      role="img"
      aria-label={label ?? "Mark derived from this passport's public key"}
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect width="112" height="112" rx="12" fill={sigil.background} />
      {sigil.cells.map((cell, index) => (
        <rect
          key={`${cell.x}-${cell.y}-${index}`}
          style={{ ["--i" as string]: index }}
          x={10 + cell.x * 13}
          y={10 + cell.y * 13}
          width="11"
          height="11"
          rx={(cell.x + cell.y + index) % 3 === 0 ? 5.5 : 2.5}
          fill={(cell.x + cell.y) % 3 === 0 ? sigil.accent : sigil.foreground}
        />
      ))}
    </svg>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="m-0 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1 mb-0 text-sm text-foreground">{children}</dd>
    </div>
  );
}

export function ReceiptVerifier() {
  const [input, setInput] = useState("");
  const [peek, setPeek] = useState<PeekResult | null>(null);
  const [rows, setRows] = useState<StepRow[]>(initialStepRows);
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [copied, setCopied] = useState(false);
  /** Announced to screen readers; the glyphs and colours carry nothing for them. */
  const [said, setSaid] = useState("");
  const runId = useRef(0);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, []);

  const onInput = (value: string) => {
    setInput(value);
    setOutcome(null);
    setRows(initialStepRows());
    setPeek(value.trim() ? peekArtifact(value) : null);
  };

  const run = useCallback(async (jws: string) => {
    const id = ++runId.current;
    const stale = () => runId.current !== id;

    setOutcome(null);
    setRows(initialStepRows());
    setRunning(true);
    setSaid("Checking receipt.");

    const trimmed = jws.trim();

    // Settled locally, and therefore settled without a network call at all —
    // including the issuer check, because `iss` comes from an unverified payload
    // and is a string the receipt's author chose until a signature says
    // otherwise. preflight() mirrors the verifier's gate order exactly, and a
    // test cross-checks it against the real verifier rather than against a
    // second copy of the same assumptions.
    const local = preflight(trimmed);
    if (local) {
      // The step is passed, not just the reason: `bad_signature` means two
      // different things depending on where it arose, and only one of them is
      // evidence of tampering. See describeFailure.
      const presentation = describeFailure(local.reason, local.step);
      setRows(rowsFailingAt(local.step));
      setOutcome({ kind: "failed", presentation, totalMs: 0 });
      setSaid(presentation.title);
      setRunning(false);
      return;
    }

    const issuer = peekArtifact(trimmed).issuer!;
    const queue: VerifyStep[] = [];
    let settled = false;
    const floor = revealFloorMs();

    const finished = verifyReceipt(trimmed, {
      trustedIssuers: [issuer],
      onStep: (step) => queue.push(step),
    }).finally(() => {
      settled = true;
    });

    // Presenter: drains real results onto a paced timeline. It never invents a
    // result and never outruns one — if the queue is empty it waits for the
    // verifier, however long that takes.
    let shown = 0;
    while (shown < STEP_ORDER.length) {
      if (shown >= queue.length) {
        if (settled) break;
        await sleep(16);
        continue;
      }
      const step = queue[shown]!;
      // `at` is bound HERE, not read inside the updater. React invokes updaters
      // during a later render, by which point `shown` has moved on — reading it
      // in there put every result on the following row, so a forged receipt
      // rendered "Signature matches the contents ✓". See tests/receipt-steps.
      const at = shown;
      if (stale()) return;
      setRows((prev) => applyStep(prev, at, step));
      setSaid(
        `Check ${shown + 1} of ${STEP_ORDER.length}, ${STEP_LABELS[step.step] ?? step.step}: ${
          step.ok ? "passed" : "failed"
        }.`
      );
      shown++;
      if (!step.ok) break;
      if (floor) await sleep(floor);
    }

    // verifyReceipt is written never to reject, so this should be unreachable.
    // Unreachable is not the same as impossible, and the cost of being wrong is
    // a page stuck on "Checking…" with no way back — so it is handled.
    let result: Awaited<typeof finished>;
    try {
      result = await finished;
    } catch {
      if (stale()) return;
      setRows(rowsFailingAt(STEP_ORDER[Math.min(shown, STEP_ORDER.length - 1)]!));
      setOutcome({
        kind: "failed",
        presentation: describeFailure("unexpected_error" as never),
        totalMs: queue.reduce((sum, step) => sum + step.ms, 0),
      });
      setSaid("The receipt could not be checked.");
      setRunning(false);
      return;
    }

    if (stale()) return;

    // The sum of the real check durations, NOT wall clock. Wall clock includes
    // the paced reveal (and, in a background tab, Chrome's 1s timer clamp), so
    // it reported seconds for milliseconds of work — inventing duration on the
    // one page that promises it never will. This total is addable: a reader can
    // sum the rows on screen and land on it.
    const totalMs = queue.reduce((sum, step) => sum + step.ms, 0);
    // The gate that actually failed, so the copy can distinguish "nothing was
    // compared" from "the comparison failed".
    const failedAt = queue.at(-1)?.step;
    const presentation = result.ok ? null : describeFailure(result.reason, failedAt);
    setOutcome(
      result.ok
        ? { kind: "ok", claims: result.claims, totalMs }
        : { kind: "failed", presentation: presentation!, totalMs }
    );
    setSaid(result.ok ? "The signature is genuine." : presentation!.title);
    setRunning(false);
  }, []);

  // A receipt in the URL fragment verifies on arrival. Fragments are never sent
  // to the server, so a shared link carries the receipt to its reader without it
  // ever passing through Vertias — the page's privacy claim, made usable.
  useEffect(() => {
    const fragment = window.location.hash.replace(/^#/, "");
    if (!fragment) return;
    const decoded = decodeURIComponent(fragment);
    setInput(decoded);
    setPeek(peekArtifact(decoded));
    void run(decoded);
  }, [run]);

  const copyLink = async () => {
    const url = `${window.location.origin}${window.location.pathname}#${encodeURIComponent(input.trim())}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard permission denied. The link is not lost — the receipt is still
      // in the box — so there is nothing worth interrupting the reader over.
    }
  };

  const disabled = running || !input.trim();

  return (
    <div className="pcv grid gap-8">
      <section className="rounded-xl border border-border bg-card p-6 shadow-sm sm:p-8">
        <h2 className="m-0 text-xl font-bold text-foreground">Was this call really made?</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Paste a signed receipt. It is checked here, in your browser — the receipt is never
          sent to Vertias. The only request made is to the issuer&rsquo;s own address, for the
          public keys they publish.
        </p>

        <form
          className="mt-6 grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(input);
          }}
        >
          <label
            htmlFor="receipt"
            className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground"
          >
            Receipt
          </label>
          <textarea
            id="receipt"
            rows={6}
            spellCheck={false}
            autoComplete="off"
            value={input}
            onChange={(e) => onInput(e.target.value)}
            placeholder="eyJhbGciOiJFZERTQSIs… (one long line, two dots in it)"
            className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs leading-5 text-foreground outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          />

          {peek ? <PeekHint peek={peek} /> : null}

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={disabled}
              className="w-fit rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {running ? "Checking…" : "Verify receipt"}
            </button>
            {outcome ? (
              <button
                type="button"
                onClick={() => void copyLink()}
                className="w-fit rounded-lg border border-border bg-transparent px-4 py-2 text-sm font-semibold text-foreground transition-colors hover:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {copied ? "Link copied" : "Copy shareable link"}
              </button>
            ) : null}
          </div>
        </form>
      </section>

      <p className="sr-only" role="status" aria-live="polite">
        {said}
      </p>

      {running || outcome ? (
        <Inspection
          rows={rows}
          totalMs={outcome && !running ? outcome.totalMs : null}
          kind={outcome?.kind === "failed" && !running ? outcome.presentation.kind : null}
        />
      ) : null}
      {outcome?.kind === "ok" ? <ReceiptDocument claims={outcome.claims} /> : null}
      {outcome?.kind === "failed" ? <Failure presentation={outcome.presentation} /> : null}
    </div>
  );
}

function PeekHint({ peek }: { peek: PeekResult }) {
  // Read locally, before any network call, so the most likely mistake — pasting
  // an agent token — is named up front instead of arriving as "wrong type"
  // after a round trip, which reads like the receipt itself is broken.
  const message =
    peek.kind === "receipt"
      ? peek.issuer
        ? `A receipt claiming to come from ${peek.issuer}. Nothing is proven yet.`
        : "A receipt, but it names no issuer — there is nowhere to fetch a key from."
      : peek.kind === "agent_token"
        ? "This is an agent-to-agent token, not a call receipt. This page checks receipts."
        : peek.kind === "other_jws"
          ? "This is a signed token, but not one PassControl issues."
          : "This does not look like a receipt. A receipt is one long line with exactly two dots in it.";

  return (
    <p
      className={`m-0 text-xs leading-5 ${peek.kind === "receipt" ? "text-muted-foreground" : "text-warning"}`}
    >
      {message}
    </p>
  );
}

function Inspection({
  rows,
  totalMs,
  kind,
}: {
  rows: StepRow[];
  totalMs: number | null;
  kind: FailureKind | null;
}) {
  const ran = rows.filter((r) => r.state === "pass" || r.state === "fail").length;
  // The rail follows the KIND of failure, not merely the fact that a row failed.
  // An unreachable key list is our outage, not the receipt's fault, and a red bar
  // above a card that says "this says nothing about the receipt itself" reads as
  // an accusation anyway — undoing the forged/unchecked split one element above
  // where it was carefully made.
  const rail =
    kind === "forged" ? "bg-destructive" : kind === "unchecked" ? "bg-muted-foreground" : "bg-primary";
  return (
    <section
      data-kind={kind ?? undefined}
      className="pcv-sequence overflow-hidden rounded-xl border border-border bg-card shadow-sm"
    >
      <div className={`h-1.5 w-full ${rail}`} aria-hidden="true" />
      <div className="p-6 sm:p-8">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 className="m-0 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Inspection
          </h2>
          {/* The sequence needs an ending, but the list stays open: collapsing it
              would hide the evidence, which is the one thing this page is for. */}
          {totalMs === null ? null : (
            <p className="m-0 font-mono text-xs tabular-nums text-muted-foreground">
              {ran} of {rows.length} checks · {totalMs.toFixed(1)} ms
            </p>
          )}
        </div>
        {/* The list itself is not a live region: it rewrites on every step, and
            a screen reader would re-read all eight rows each time. One status
            line announcing just what changed is the readable equivalent of
            watching a row tick over. */}
        <ol className="mt-4 mb-0 grid list-none gap-0 p-0" aria-label="Verification checks">
          {rows.map((row, i) => (
            <li
              key={row.name}
              data-state={row.state}
              style={{ ["--i" as string]: i }}
              className="pcv-step grid grid-cols-[1.25rem_1fr_auto] items-center gap-3 border-b border-border py-2.5 last:border-b-0 text-sm"
            >
              <span className="pcv-mark" aria-hidden="true" />
              <span className="pcv-label">
                {STEP_LABELS[row.name]}
                <span className="sr-only"> — {STATE_WORDS[row.state]}</span>
              </span>
              <span className="pcv-ms font-mono text-xs tabular-nums text-muted-foreground">
                {row.state === "not-reached"
                  ? "not reached"
                  : row.ms === null
                    ? ""
                    : `${row.ms.toFixed(1)} ms`}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function ReceiptDocument({ claims }: { claims: ReceiptClaims }) {
  const verdict = describeVerdict(claims.res.status, claims.res.http);
  const authentication = describeReceiptAuthentication(claims);
  const owner = describeOwner(claims.own ?? null);
  const cost = formatCost(claims.cost);
  const failover = describeFailover(claims.why);
  const tone =
    verdict.tone === "clear"
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600"
      : verdict.tone === "denied"
        ? "border-destructive/40 bg-destructive/10 text-destructive"
        : "border-amber-500/40 bg-amber-500/10 text-amber-600";

  return (
    <section className="pcv-document overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      {/* The rail answers "is this receipt real", so it stays green even when the
          verdict inside is a refusal — a genuine receipt recording a blocked
          call is a good outcome, not a broken one. The verdict badge below
          carries the other question. Do not couple them. */}
      <div className="h-1.5 w-full bg-primary" aria-hidden="true" />
      <div className="grid gap-6 p-6 sm:p-8">
        <div className="flex flex-wrap items-start gap-5">
          <Sigil
            passportId={authentication.keyId ?? authentication.subject}
            label={
              authentication.keyId
                ? "Mark derived from this Direct Agent Key identity"
                : undefined
            }
          />
          <div className="min-w-0 flex-1">
            <span className="pcv-bars inline-flex items-end gap-0.5" aria-hidden="true">
              {Array.from({ length: 14 }, (_, i) => (
                <i key={i} style={{ height: `${6 + ((i * 7) % 13)}px` }} />
              ))}
            </span>
            <h2 className="mt-3 mb-0 text-xl font-bold leading-7 text-foreground">
              The signature is genuine.
            </h2>
            {/* Two claims, never one badge. We can vouch for the mathematics; we
                cannot vouch for the party, and pretending otherwise would launder
                an unknown issuer's word through the Vertias domain. */}
            <p className="mt-2 mb-0 text-sm leading-6 text-muted-foreground">
              This receipt was signed by{" "}
              <strong className="break-all font-semibold text-foreground">{claims.iss}</strong>{" "}
              using a key they publish, and nothing in it has been altered since. Whether you
              trust that issuer is your own judgement — this page does not vouch for them.
            </p>
            <p className="mt-3 mb-0 text-sm leading-6 text-muted-foreground">
              <strong className="font-semibold text-foreground">{authentication.label}.</strong>{" "}
              {authentication.detail}
            </p>
          </div>
        </div>

        <dl className="grid gap-4 border-t border-border pt-6 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <dt className="m-0 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Verdict recorded
            </dt>
            <dd className="mt-1 mb-0">
              <span
                className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-bold uppercase tracking-[0.1em] ${tone}`}
              >
                {verdict.label}
              </span>
              <span className="mt-2 block text-sm leading-6 text-muted-foreground">
                {verdict.detail}
              </span>
            </dd>
          </div>

          <Fact label="Call">
            <span className="font-mono text-[0.8rem] leading-5">{describeCall(claims)}</span>
          </Fact>
          <Fact label="Cost recorded">
            <span className="font-semibold">{cost.primary}</span>
            <span className="mt-1 block text-xs leading-5 text-muted-foreground">
              {describeTokenUse(claims.use)}
              {cost.exact ? ` · ${cost.exact}` : ""}
            </span>
          </Fact>
          <div className="sm:col-span-2">
            <dt className="m-0 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              {authentication.subjectLabel}
            </dt>
            <dd className="mt-1 mb-0 break-all font-mono text-[0.8rem] leading-5 text-foreground">
              {authentication.subject}
              {authentication.keyId ? (
                <span className="mt-1 block text-xs text-muted-foreground">
                  Direct key {authentication.keyId}
                </span>
              ) : null}
            </dd>
          </div>
          <Fact label="Signed">{formatSignedAt(claims.iat)}</Fact>
          <Fact label="Total time">
            <span className="font-semibold">{claims.lat.toLocaleString("en-GB")} ms</span>
            <span className="mt-1 block text-xs leading-5 text-muted-foreground">
              measured by the gateway · provider time included
            </span>
          </Fact>
          <div className="sm:col-span-2">
            <dt className="m-0 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Owner
            </dt>
            {owner ? (
              <dd className="mt-1 mb-0">
                <span className="font-semibold text-foreground">{owner.subject}</span>
                <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                  {owner.note}
                </span>
              </dd>
            ) : (
              <dd className="mt-1 mb-0 text-sm text-muted-foreground">
                The issuer publishes no owner for this agent.
              </dd>
            )}
          </div>
          {claims.req ? (
            <div className="sm:col-span-2">
              <dt className="m-0 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                Request fingerprint
              </dt>
              <dd className="mt-1 mb-0 break-all font-mono text-[0.8rem] leading-5 text-foreground">
                {claims.req.alg} {claims.req.dig}
                <span className="text-muted-foreground"> ({claims.req.len} bytes)</span>
              </dd>
            </div>
          ) : null}
        </dl>

        {/* Only on a receipt that followed a failed attempt. It is placed
            outside the fact list because it is not a fact about THIS call — it
            is a pointer at another one, and on two of the four reasons it is a
            prompt to go and check a second invoice. */}
        {failover ? (
          <div
            className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4"
            data-state={failover.mayHaveBeenCharged ? "chain-billable" : "chain"}
          >
            <p className="m-0 text-xs font-semibold uppercase tracking-[0.14em] text-amber-600">
              This was a second attempt
            </p>
            <p className="mt-2 mb-0 text-sm font-semibold leading-6 text-foreground">
              {failover.label}
            </p>
            <p className="mt-1 mb-0 text-sm leading-6 text-muted-foreground">{failover.detail}</p>
            {typeof claims.prev === "string" && claims.prev ? (
              <>
                <p className="mt-3 mb-0 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  Receipt for the attempt this replaced
                </p>
                {/* Plain text, never a link: `prev` comes out of a payload
                    signed by whoever the reader chose to trust, and building an
                    href from it would hand an untrusted string to the browser.
                    Paste it above to check it on its own. */}
                <p className="mt-1 mb-0 break-all font-mono text-[0.8rem] leading-5 text-foreground">
                  {claims.prev}
                </p>
              </>
            ) : null}
          </div>
        ) : null}

        <p className="m-0 rounded-lg border border-border bg-secondary px-4 py-3 text-xs leading-5 text-muted-foreground">
          A receipt records the request and the gateway&rsquo;s decision about it. It does not
          record what the provider replied, and the absence of a receipt proves nothing — it
          is not a complete ledger of everything an agent did.
        </p>
      </div>
    </section>
  );
}

function Failure({ presentation }: { presentation: FailurePresentation }) {
  const forged = presentation.kind === "forged";
  return (
    <section className="pcv-document overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <div
        className={`h-1.5 w-full ${forged ? "bg-destructive" : "bg-muted-foreground"}`}
        aria-hidden="true"
      />
      <div className="p-6 sm:p-8">
        <span
          className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-bold uppercase tracking-[0.1em] ${
            forged
              ? "border-destructive/40 bg-destructive/10 text-destructive"
              : "border-border bg-secondary text-muted-foreground"
          }`}
        >
          {forged ? "Do not rely on this" : "Could not check"}
        </span>
        <h2 className="mt-3 mb-0 text-xl font-bold leading-7 text-foreground">
          {presentation.title}
        </h2>
        <p className="mt-2 mb-0 text-sm leading-6 text-muted-foreground">{presentation.body}</p>
      </div>
    </section>
  );
}
