// Where an agent SAYS it keeps its passport private key.
//
// ── This panel's whole job is not overstating ───────────────────────────────
//
// The gateway cannot check a custody claim at any tier: tier 1 leaves no trace
// in a signature, and tiers 2 and 3 would need hardware attestation
// (research/passport-key-protection.md §4). So there is no green tick anywhere
// here, no "verified", and — deliberately — no control: the server has never
// held this key and cannot move it, and a toggle that silently did nothing
// would be worse than no toggle. The command that does change it runs on the
// agent's own machine, and is named instead.
//
// Four states, and the fourth is the one worth guarding. Silence means one of:
// the agent has not minted since this shipped, it uses the SDK or an older CLI,
// or the record expired. None of those is "the key is in a file", so silence
// gets its own state rather than being folded into tier 0.
import { expectationVerdict } from "@/lib/key-custody-expectation";
import type { DeclaredKeyStorageView } from "@/lib/passport-key-storage";

const STORE_LABEL: Record<string, string> = {
  file: "Tier 0 — file or environment variable",
  os: "Tier 1 — OS credential store",
};

function when(value: string | null) {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toLocaleString("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  });
}

export function KeyStoragePanel({
  view,
  expectation = null,
}: {
  view: DeclaredKeyStorageView;
  /**
   * The workspace expectation, stated by the operator in Settings and enforced
   * by nothing. Two unverified things are being compared here — a policy
   * somebody typed against a claim an agent made about itself — so the verdict
   * is about the CLAIM, never about the agent. See lib/key-custody-expectation.
   */
  expectation?: string | null;
}) {
  const declaredAt = when(view.declaredAt);
  const verdict = expectationVerdict(view, expectation);

  return (
    <section
      className="rounded-xl border border-border bg-card p-5 shadow-sm sm:p-6"
      data-panel="key-storage"
      data-key-storage={view.dataState}
      aria-labelledby="passport-key-storage-heading"
    >
      <p className="m-0 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        Declared by the agent
      </p>
      <h2 id="passport-key-storage-heading" className="mt-2 mb-0 text-lg font-bold">
        Passport key custody
      </h2>
      <p className="mt-2 mb-0 text-sm leading-6 text-muted-foreground">
        Where this agent reports it keeps its passport private key. Nothing here was
        checked. The key never leaves the agent&rsquo;s machine — that is the point of a
        passport — so this gateway cannot check a custody claim at any tier. Read it as
        a report from the agent, not as a property of it.
      </p>

      <p className="mt-4 mb-0 text-sm font-semibold text-foreground">
        {view.state === "declared"
          ? STORE_LABEL[view.store as string]
          : view.state === "unrecognised"
            ? `A storage kind this dashboard does not recognise: ${view.store}`
            : "No custody claim recorded"}
      </p>

      {view.state === "undeclared" ? (
        <p className="mt-2 mb-0 text-sm leading-6 text-muted-foreground">
          This agent has not declared where it keeps its key. That happens when it has not
          minted a work-visa since this instance began recording claims, when it
          authenticates through the SDK or an older CLI, or when the record simply expired.
          It is not evidence that the key sits in a file.
        </p>
      ) : null}

      {view.state === "unrecognised" ? (
        <p className="mt-2 mb-0 text-sm leading-6 text-muted-foreground">
          The agent is running a newer PassControl CLI than this instance, and named a
          storage kind that shipped after it. Upgrade this instance to read the claim.
          {declaredAt ? ` Declared ${declaredAt} UTC.` : null}
        </p>
      ) : null}

      {view.state === "declared" ? (
        <p className="mt-2 mb-0 text-sm leading-6 text-muted-foreground">
          {declaredAt ? `Declared ${declaredAt} UTC, ` : "Declared "}
          on the last work-visa this agent signed for.
        </p>
      ) : null}

      {view.fellBack ? (
        <p className="mt-3 mb-0 text-sm leading-6" style={{ color: "var(--warning)" }}>
          This agent is configured for the OS credential store and fell back to its file
          key: the store could not be read. Its configuration says one tier and it is
          running on the other. Run <code>passcontrol key status</code> on that machine.
        </p>
      ) : null}

      {view.supersededByLaterActivity ? (
        <p className="mt-3 mb-0 text-sm leading-6 text-muted-foreground">
          This agent has authenticated since, carrying no claim. The line above describes
          the moment it was made, not necessarily the machine running now.
        </p>
      ) : null}

      {verdict === "not_stated" ? null : (
        <p
          className="mt-3 mb-0 text-sm leading-6"
          data-expectation-verdict={verdict}
          style={verdict === "short" ? { color: "var(--warning)" } : undefined}
        >
          {verdict === "short" ? (
            <>
              This is below the custody your workspace expects (
              {STORE_LABEL[expectation as string] ?? expectation}). Nothing was blocked and
              nothing will be — the expectation is a line you set, not a control.
            </>
          ) : verdict === "meets" ? (
            <>
              Your workspace expects {STORE_LABEL[expectation as string] ?? expectation}, and
              that is what this agent declared. Still a claim, still unchecked.
            </>
          ) : (
            // `unknown` covers two different silences: an agent that declared
            // nothing, and one on a tier newer than this build. Neither is a
            // shortfall, and they are not the same sentence.
            <>
              Your workspace expects {STORE_LABEL[expectation as string] ?? expectation}.{" "}
              {view.state === "unrecognised"
                ? "This agent declared a tier this instance cannot name, so it cannot be placed against that line — which is not the same as falling short of it."
                : "This agent has declared nothing to compare against, which is not the same as falling short of it."}
            </>
          )}
        </p>
      )}

      {/* The migrate half is withheld on an unrecognised store. That agent is on
          a tier newer than this build, so "move your file key into the OS
          credential store" is a downgrade instruction — confidently given about
          the one state this panel has just admitted it cannot read. */}
      <p className="mt-4 mb-0 text-xs leading-5 text-muted-foreground">
        This is changed on the agent&rsquo;s own machine, never here:{" "}
        <code>passcontrol key status</code> reports what that machine is using
        {view.state === "unrecognised" ? (
          ", and it is the authority on a tier this instance cannot name"
        ) : (
          <>
            , and <code>passcontrol key migrate</code> moves a file key into the OS
            credential store
          </>
        )}
        . This server has never held the key and cannot move it.
      </p>
    </section>
  );
}
