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
  checkOwnerControl,
  clearCompany,
  declareOwner,
  publishOwner,
  setCompany,
  type OwnerActionState,
} from "@/app/dashboard/owner-actions";
import { OWNER_WELL_KNOWN_PATH } from "@/lib/owner/domain";
import { GITHUB_OWNER_FILE, GITHUB_OWNER_REPO, githubProofUrl } from "@/lib/owner/github";
import { OWNER_FAILURE_LIMIT, type OwnerRecord } from "@/lib/owner/manage";
import { useDashboardTime } from "@/components/dashboard/DashboardTime";

const FAILURES: Record<string, string> = {
  invalid_domain: "That hostname cannot be checked.",
  invalid_login: "That is not a GitHub username we can check.",
  unreachable: "We could not reach that host over HTTPS. The file must be served on port 443, and we do not follow redirects.",
  not_published: "The file is not there yet, or it is empty.",
  token_mismatch: "The file is there, but it does not contain this token.",
};

/** Where a claim of each kind must be published, derived and never typed. */
const PROOF = {
  domain: (subject: string) => `https://${subject}${OWNER_WELL_KNOWN_PATH}`,
  github: (subject: string) => githubProofUrl(subject),
} as const;

const CLAIM_FIELD: Record<string, { label: string; placeholder: string }> = {
  domain: { label: "Hostname", placeholder: "acme.com" },
  github: { label: "GitHub username", placeholder: "octocat" },
  self_attested: { label: "Name", placeholder: "Acme Ltd" },
};

const PROVEN_WORDING: Record<string, string> = {
  domain: "Control of this domain was demonstrated",
  github: "Control of this GitHub account was demonstrated",
  idv: "Verified by identity check",
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

  const [companyId, setCompanyId] = useState("");
  const current = state.owner ?? null;
  // Keyed off tier, never kind. `domain` and `github` are peers, not a ladder —
  // both prove control of a public identifier and neither proves who the human
  // behind it is.
  const proven =
    current?.tier === "domain" || current?.tier === "github" || current?.tier === "idv";
  const proofUrl =
    current && (current.kind === "domain" || current.kind === "github")
      ? PROOF[current.kind](current.subject)
      : null;
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
                <option value="github">A GitHub account</option>
                <option value="self_attested">A name</option>
              </select>
            </label>
            <label className="grid gap-1 text-sm">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">
                {CLAIM_FIELD[kind]?.label ?? "Name"}
              </span>
              <input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder={CLAIM_FIELD[kind]?.placeholder ?? "Acme Ltd"}
                spellCheck={false}
              />
            </label>
            <button type="submit" disabled={pending || !subject.trim()}>
              {pending ? "Saving..." : "Declare owner"}
            </button>
          </div>
          <p className="m-0 text-xs leading-5 text-muted-foreground">
            A <strong>domain</strong> and a <strong>GitHub account</strong> can both be
            checked: you publish a token we issue — on that host, or in a public repository
            only that account can create — and we fetch it. Neither proves who you are, only
            that you control that identifier, which is why the label says so. A{" "}
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
                  {PROVEN_WORDING[current.tier] ?? "Verified"}
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

          {proofUrl && current.verification_token ? (
            <div className="grid gap-2 rounded-lg border border-border bg-secondary/40 p-4">
              <p className="m-0 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                {proven ? "Keep this file in place" : "Publish this, then check"}
              </p>
              <div className="pc-copy-row">
                <code>{proofUrl}</code>
                <button type="button" className="ghost" onClick={() => copy("path", proofUrl)}>
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
                {current.kind === "github" ? (
                  <>
                    A <strong>public</strong> repository named <code>{GITHUB_OWNER_REPO}</code>{" "}
                    under this account, holding one file called <code>{GITHUB_OWNER_FILE}</code>.
                    Only that account can create a repository at that path, which is the whole
                    proof.{" "}
                  </>
                ) : (
                  "Served over HTTPS on port 443. "
                )}
                We do not follow redirects, and we never read the file back to you — a failed
                check cannot be used to fetch anything.
                {proven ? " Removing it will demote this binding at the next check." : ""}
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  className="ghost"
                  onClick={() => run(checkOwnerControl)}
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

          {/* The company line, and the reason it sits below the evidence block
              rather than inside it. A register lookup confirms an entry EXISTS;
              it cannot show that this tenant is it, because a register is a
              public record anyone can quote with nowhere to publish a token.
              So it is never worded as evidence, never keyed to `tier`, and the
              label says "asserted" in the operator's own view — not only on the
              page a stranger reads. See db/migrations/0048. */}
          <div className="grid gap-2 rounded-lg border border-border p-4" data-panel="company">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-sm font-semibold">Company register</span>
              {current.company_id ? (
                <button type="button" className="ghost" onClick={() => run(clearCompany)} disabled={pending}>
                  Remove
                </button>
              ) : null}
            </div>

            {current.company_id ? (
              <dl className="m-0 grid gap-x-6 gap-y-2 sm:grid-cols-[10rem_1fr]">
                <dt className="m-0 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  {current.company_source === "lei" ? "LEI" : "VAT number"}
                </dt>
                <dd className="m-0 break-all text-sm font-semibold text-foreground">
                  {current.company_id}
                </dd>
                <dt className="m-0 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  Register says
                </dt>
                <dd className="m-0 text-sm" data-state={current.company_active ? "active" : "inactive"}>
                  {current.company_name ?? "no name published"}
                  {current.company_active ? null : (
                    <span className="ml-2 font-semibold" style={{ color: "var(--warning)" }}>
                      not active
                    </span>
                  )}
                </dd>
                <dt className="m-0 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  Last looked up
                </dt>
                <dd className="m-0 text-sm text-muted-foreground">{when(current.company_checked_at)}</dd>
              </dl>
            ) : (
              <form
                className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end"
                onSubmit={(e) => {
                  e.preventDefault();
                  run(() => setCompany(companyId));
                }}
              >
                <label className="grid gap-1 text-sm">
                  <span className="text-xs uppercase tracking-wide text-muted-foreground">
                    EU VAT number or LEI
                  </span>
                  <input
                    value={companyId}
                    onChange={(e) => setCompanyId(e.target.value)}
                    placeholder="IE6388047V"
                    spellCheck={false}
                  />
                </label>
                <button type="submit" disabled={pending || !companyId.trim()}>
                  {pending ? "Looking up..." : "Look up"}
                </button>
              </form>
            )}

            <p className="m-0 text-xs leading-5 text-muted-foreground">
              <strong>This is asserted, not proven.</strong> We check the number against the
              register and record the name it returns — we cannot show that these passports are
              that company, because a register is a public record anyone can quote. It is worth
              publishing anyway: beside a proof above, it gives a reader something they can go
              and check for themselves in the same register we used. Nothing here moves the
              evidence label.
            </p>
          </div>

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
              self-attested claim can never be shown as a checked one — and neither can a
              company you have named but not proven.
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
