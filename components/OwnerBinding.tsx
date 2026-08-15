"use client";
// Who these passports belong to.
//
// Everything below is a wording judgement, and the wording is the security
// control. A passport already answers "was this issued by us, and is it still
// valid". This answers "whose is it" — and the value of that answer is entirely
// the TIER attached to it. So:
//
//  * Wording is keyed off `tier`, never `kind`. `kind` records the method
//    attempted; `tier` records what was actually proven. Reading a verified
//    label off `kind` would let anyone type a domain into this form and have
//    the public page vouch for it. describeOwner() applies the same rule at the
//    other end, and resolves an unknown tier DOWNWARD for the same reason.
//  * A self-attested claim is labelled as proving nothing on the operator's own
//    screen, not only on the page a stranger reads. A UI that flatters the
//    operator here is how a name ends up on a receipt looking checked.
//  * Publishing is ONE switch with TWO effects. The second — that every signed
//    receipt starts carrying the name — is the one nobody guesses, so it is
//    stated at the control rather than in documentation.
import { useState, useTransition } from "react";
import { Check, Copy } from "lucide-react";

import {
  checkOwnerDomain,
  declareOwner,
  publishOwner,
  type OwnerActionState,
} from "@/app/dashboard/owner-actions";
import { OWNER_WELL_KNOWN_PATH } from "@/lib/owner/domain";
import { OWNER_FAILURE_LIMIT, type OwnerRecord } from "@/lib/owner/manage";
import { useDashboardTime } from "@/components/dashboard/DashboardTime";

const FAILURES: Record<string, string> = {
  invalid_domain: "That hostname cannot be checked.",
  unreachable: "We could not reach that host over HTTPS. The file must be served on port 443, and we do not follow redirects.",
  not_published: "The file is not there yet, or it is empty.",
  token_mismatch: "The file is there, but it does not contain this token.",
};

export function OwnerBinding({ owner }: { owner: OwnerRecord | null }) {
  const [state, setState] = useState<OwnerActionState>({ owner });
  const [kind, setKind] = useState("domain");
  const [subject, setSubject] = useState("");
  const [pending, start] = useTransition();
  const [copied, setCopied] = useState<"path" | "token" | "failed" | null>(null);
  const { format } = useDashboardTime();
  const when = (value: string | null): string =>
    value && Number.isFinite(Date.parse(value)) ? format(value) : "never";

  const current = state.owner ?? null;
  const proven = current?.tier === "domain" || current?.tier === "idv";
  const demoted =
    current != null && !proven && current.failure_count >= OWNER_FAILURE_LIMIT && current.verified_at != null;
  const run = (action: () => Promise<OwnerActionState>) =>
    start(async () => setState(await action()));
  const copy = async (kind: "path" | "token", value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
    } catch {
      setCopied("failed");
    }
  };

  return (
    <div className="grid gap-4">
      {current === null ? (
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => declareOwner({ kind, subject }));
          }}
        >
          <div className="grid gap-3 sm:grid-cols-[10rem_1fr_auto] sm:items-end">
            <label className="grid gap-1 text-sm">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">Claim</span>
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="domain">A domain</option>
                <option value="self_attested">A name</option>
              </select>
            </label>
            <label className="grid gap-1 text-sm">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">
                {kind === "domain" ? "Hostname" : "Name"}
              </span>
              <input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder={kind === "domain" ? "acme.com" : "Acme Ltd"}
                spellCheck={false}
              />
            </label>
            <button type="submit" disabled={pending || !subject.trim()}>
              {pending ? "Saving..." : "Declare owner"}
            </button>
          </div>
          <p className="m-0 text-xs leading-5 text-muted-foreground">
            A <strong>domain</strong> can be checked: you publish a token on that host and we
            fetch it, which proves control of a web server answering for it. A{" "}
            <strong>name</strong> is self-attested — it proves nothing, is always labelled as
            proving nothing, and anyone reading a receipt is told so.
          </p>
        </form>
      ) : (
        <div className="grid gap-4">
          <dl className="m-0 grid gap-x-6 gap-y-2 sm:grid-cols-[10rem_1fr]">
            <dt className="m-0 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Owner
            </dt>
            <dd className="m-0 break-all text-sm font-semibold text-foreground">
              {current.subject}
            </dd>
            <dt className="m-0 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Evidence
            </dt>
            <dd className="m-0 text-sm">
              {proven ? (
                <span data-state="verified" className="font-semibold text-info">
                  {current.tier === "domain"
                    ? "Control of this domain was demonstrated"
                    : "Verified by identity check"}
                </span>
              ) : (
                <span data-state="unverified" className="font-semibold text-warning">
                  Self-attested — nothing has been checked
                </span>
              )}
            </dd>
            <dt className="m-0 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Last confirmed
            </dt>
            <dd className="m-0 text-sm text-muted-foreground">{when(current.verified_at)}</dd>
            <dt className="m-0 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Last checked
            </dt>
            <dd className="m-0 text-sm text-muted-foreground">{when(current.last_checked_at)}</dd>
          </dl>

          {/* verified_at is deliberately NOT cleared on demotion, so this can say
              when the binding last genuinely held. That is more useful than
              silence, and it is the difference between "their web server had a
              bad week" and "this was never proven". */}
          {demoted ? (
            <div
              className="rounded-lg border p-3"
              style={{
                borderColor: "var(--warning)",
                background: "color-mix(in srgb, var(--warning) 10%, transparent)",
              }}
              data-state="demoted"
            >
              <p className="m-0 text-sm font-semibold" style={{ color: "var(--warning)" }}>
                This binding stopped confirming and has been marked unproven.
              </p>
              <p className="m-0 mt-1 text-xs leading-5 text-muted-foreground">
                The check failed {current.failure_count} times in a row. It last genuinely held
                on {when(current.verified_at)}. Re-publish the token and check again — the
                claim itself has been kept, not deleted.
              </p>
            </div>
          ) : null}

          {current.kind === "domain" && current.verification_token ? (
            <div className="grid gap-2 rounded-lg border border-border bg-secondary/40 p-4">
              <p className="m-0 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                {proven ? "Keep this file in place" : "Publish this, then check"}
              </p>
              <div className="pc-copy-row">
                <code>https://{current.subject}{OWNER_WELL_KNOWN_PATH}</code>
                <button type="button" className="ghost" onClick={() => copy("path", `https://${current.subject}${OWNER_WELL_KNOWN_PATH}`)}>
                  {copied === "path" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                  {copied === "path" ? "Copied" : "Copy path"}
                </button>
              </div>
              <div className="pc-copy-row is-secret">
                <code>{current.verification_token}</code>
                <button type="button" className="ghost" onClick={() => copy("token", current.verification_token ?? "")}>
                  {copied === "token" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                  {copied === "token" ? "Copied" : "Copy token"}
                </button>
              </div>
              <p className="m-0 text-xs leading-5 text-muted-foreground">
                Served over HTTPS on port 443. We do not follow redirects, and we never read the
                file back to you — a failed check cannot be used to fetch anything.
                {proven ? " Removing it will demote this binding at the next check." : ""}
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  className="ghost"
                  onClick={() => run(checkOwnerDomain)}
                  disabled={pending}
                >
                  {pending ? "Checking..." : "Check now"}
                </button>
                {state.reason ? (
                  <span className="text-xs" style={{ color: "var(--warning)" }}>
                    {FAILURES[state.reason] ?? "The check did not pass."}
                  </span>
                ) : null}
              </div>
              {copied === "failed" ? <p role="status" className="m-0 text-xs text-warning">Clipboard access was blocked. Select and copy the value manually.</p> : null}
            </div>
          ) : null}

          <div className="grid gap-2 rounded-lg border border-border p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-sm font-semibold">
                {current.published ? "Published" : "Not published"}
              </span>
              <button
                type="button"
                className="ghost"
                onClick={() => run(() => publishOwner(!current.published))}
                disabled={pending}
              >
                {current.published ? "Stop publishing" : "Publish this owner"}
              </button>
            </div>
            {/* The second effect is the one nobody guesses. */}
            <p className="m-0 text-xs leading-5 text-muted-foreground">
              Publishing does two things: this owner appears on the public{" "}
              <code>/verify</code> page for every passport you hold, <strong>and</strong> it is
              written into every signed receipt from then on — receipts you hand to clients,
              suppliers and auditors. The tier travels with it in both places, so a
              self-attested claim can never be shown as a checked one.
            </p>
          </div>
        </div>
      )}

      {state.error ? (
        <p className="m-0 text-sm" style={{ color: "var(--danger)" }}>
          {state.error}
        </p>
      ) : null}
    </div>
  );
}
