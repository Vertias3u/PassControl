"use client";

import { useState } from "react";
import { Check, Copy, FileClock, ShieldCheck } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { departureDestination, type DepartureRow } from "@/lib/departures";
import {
  CALL_OUTCOME,
  OUTCOME_CATEGORY_LABEL,
  callOutcome,
  capCharge,
  reportedTokens,
  scopeRefusalExplanation,
  usageLabel,
  wasForwarded,
} from "@/lib/call-outcome";
import { isHousekeeping } from "@/lib/call-class";
import type { LogEntry } from "@/lib/log";
import { parseShadowVerdict } from "@/lib/policy-shadow";
import {
  readRecordedEndpoint,
  readRecordedUpstreamStatus,
  describeUpstreamStatus,
} from "@/lib/verify/receipt-view";
import { DashboardTimestamp } from "@/components/dashboard/DashboardTime";
import { authenticationProofLabel } from "@/lib/first-call-activation";

export interface CallContext {
  shadowRevisions: Record<string, string | null>;
  /**
   * The workspace's current agent names, by id. REQUIRED: a surface that shows
   * a call must be able to say which worker made it, and an optional map is how
   * one quietly goes back to showing only a UUID.
   */
  agentNames: Record<string, string>;
}

// Explanations only. The primary label for each status comes from
// lib/call-outcome.ts, shared with every other surface that names an outcome.
const STATUS: Record<LogEntry["status"], { explanation: string }> = {
  ok: { explanation: "The stored row says the governed attempt passed PassControl and reached the provider." },
  upstream_error: { explanation: "PassControl allowed the attempt, but the upstream provider returned an error." },
  provider_exhausted: { explanation: "PassControl allowed the attempt; the provider account, not the PassControl budget, had no credit." },
  no_provider_key: { explanation: "PassControl refused before forwarding: no key is stored for this provider, so there was nothing to inject. The provider never received this call — store a key for it and retry." },
  credential_state_unavailable: { explanation: "PassControl re-checks, immediately before sending, that the address and the secret still come from the same version of your credential. Here that check could not be completed — its own state store did not answer. This is NOT a report that anything changed: nothing was observed either way, and the call was refused rather than sent on an unverified pair. The provider never received it. Retry it; if it persists, check the gateway's Redis." },
  endpoint_unavailable: { explanation: "PassControl refused before forwarding because it could not read which endpoint this credential is meant to reach. It does not send the key to the provider's own host on a guess: a credential set up for your own server may not belong there. The provider never received this call — this is a PassControl-side read failure, so retry it." },
  blocked_unpriced_endpoint: { explanation: "This agent has a spending cap in dollars, and this call was bound for a custom endpoint whose price PassControl cannot know \u2014 a gateway you run may mark up, re-route, or answer to a familiar model name with something else entirely. Enforcing the cap against the built-in provider's retail price would be enforcing a number unrelated to the bill, so the call was refused instead. The provider never received it and nothing was charged. Either remove the dollar cap for this agent (a token cap still works, because token counts are real wherever the call goes) or route it through an endpoint PassControl prices." },
  blocked_unpriced_model: { explanation: "This agent has a spending limit in dollars, and PassControl has no price for this model. Its cost could only have been estimated from the provider\u2019s most expensive listed rate, and a limit enforced with a number that is not the model\u2019s price does not hold, so the call was refused instead. The provider never received it and nothing was charged. Use a model PassControl prices, remove the dollar limit for this agent (a token cap still works), or add the model\u2019s published price to the price table." },
  credential_changed: { explanation: "PassControl resolves WHERE a credential goes and WHAT the credential is as two steps. Between those two steps this provider credential was changed \u2014 rotated, switched, or pointed at a different endpoint \u2014 so the address in hand and the secret in hand no longer came from the same version of it. Rather than send a newly rotated key to an address that had already been replaced, PassControl refused. The provider never received this call, nothing was billed, and a retry gets a matching pair." },
  blocked_scope: { explanation: "The agent's allowed access did not cover this provider and model." },
  blocked_policy: { explanation: "The live policy recorded on this attempt refused it." },
  blocked_budget: { explanation: "The PassControl budget gate refused the attempt before provider forwarding." },
  blocked_budget_period: { explanation: "The agent's daily or monthly spend limit was used up for the current UTC period, so PassControl refused the attempt before provider forwarding. It clears on its own at the next UTC period boundary; raising the limit clears it sooner." },
  usage_unknown: { explanation: "PassControl allowed the attempt and it went upstream, but no usage report ever came back \u2014 the stream broke, or it closed without one. The provider may have billed for work nobody could measure, so this attempt was charged at the greater of what was observed and what was reserved. The tokens and cost shown are what was OBSERVED, and are marked unconfirmed; where the row records them, the figures charged to the budget are shown separately below." },
  dispatch_unavailable: { explanation: "Each attempt claims a single, one-use permission to reach the provider in the instant before the request is sent, and this attempt could not claim its own. Either its record was unreadable, or another handler already held it and may be inside that provider call right now. Sending anyway risks the same request being billed twice, so nothing was sent. The reservation this attempt made is deliberately still held rather than returned \u2014 handing it back would free capacity that another handler may be about to spend. No cap was reached and raising one will not change this." },
  blocked_budget_state: { explanation: "PassControl refused before forwarding because its own spend counters for this agent were lost, and it will not invent a starting balance \u2014 doing so would hand back the difference as spendable capacity. This is not a budget denial and raising the cap will not fix it. An operator rebuilds the agent's spend from the audit trail, which is authoritative." },
  blocked_killed: { explanation: "A platform, tenant, or denylist kill state refused the attempt." },
  blocked_suspended: { explanation: "This agent was suspended when the attempt was recorded." },
  blocked_endpoint: { explanation: "The requested provider endpoint was outside the proxy's allowed route set." },
};

function statusDetail(row: DepartureRow) {
  const known = STATUS[row.status as LogEntry["status"]];
  if (!known) {
    return {
      label: row.status || "Unknown status",
      explanation: "This stored status is not recognised by the current dashboard. It is shown verbatim and is not reinterpreted.",
    };
  }
  // The primary label is the shared one, so the drawer, the board, the pill and
  // the agent page name the same outcome the same way. The explanation for a
  // scope refusal depends on which credential was presented.
  return {
    label: CALL_OUTCOME[row.status as LogEntry["status"]].label,
    explanation: row.status === "blocked_scope" ? scopeRefusalExplanation(row.auth_method) : known.explanation,
  };
}

export interface NextAction {
  href: string;
  label: string;
  /** Why this link, in the words the drawer shows under it. */
  note?: string;
}

/**
 * The next useful EXISTING place to go from a recorded call. Only links to
 * surfaces that already exist; never a rerun of the historical decision.
 */
export function nextActionsFor(row: DepartureRow, upstreamStatus: number | null): NextAction[] {
  const agent = row.agent_id ? `/dashboard/agents/${encodeURIComponent(row.agent_id)}` : null;
  const providers = { href: "/dashboard/settings#provider-credentials", label: "Provider credentials" };
  const actions: NextAction[] = [];
  switch (row.status) {
    case "blocked_scope":
    case "blocked_endpoint":
      if (agent) actions.push({ href: `${agent}#agent-access`, label: "Edit allowed access" });
      break;
    case "blocked_budget":
    case "blocked_budget_period":
    case "blocked_unpriced_endpoint":
    case "blocked_unpriced_model":
      if (agent) actions.push({ href: `${agent}#agent-operate`, label: "Review this agent's caps" });
      break;
    case "blocked_suspended":
      if (agent) actions.push({ href: `${agent}#agent-operate`, label: "Current suspension state" });
      break;
    case "blocked_killed":
      actions.push({ href: "/dashboard#overview", label: "Current kill switch state" });
      break;
    case "no_provider_key":
    case "provider_exhausted":
      actions.push(providers);
      break;
    case "upstream_error":
      // 401/403 from the provider means the STORED provider credential was
      // refused; 404 is usually a model id the provider does not know. Neither
      // is a PassControl rule, and neither is fixed on the agent's access page.
      if (upstreamStatus === 404 && agent) {
        actions.push(
          row.auth_method === "direct_key"
            ? { href: `${agent}#agent-setup`, label: "Check the model in Setup" }
            : { href: `${agent}#agent-access`, label: "Check the allowed model names" }
        );
      } else {
        actions.push(providers);
      }
      break;
    case "endpoint_unavailable":
    case "credential_state_unavailable":
    case "blocked_budget_state":
    case "dispatch_unavailable":
      actions.push({ href: "/dashboard/system", label: "System health" });
      break;
    default:
      break;
  }
  if (agent && row.status !== "ok") {
    actions.push({
      href: `${agent}#agent-trace`,
      label: "Test current controls",
      note: "Runs today's rules against a new request. It does not replay this call or show what the rules were then.",
    });
  }
  return actions;
}

export function describeStoredShadow(raw: string | null | undefined, currentRevision: string | null) {
  if (!raw) return { state: "not-evaluated", label: "Not evaluated", detail: "No shadow verdict was stored on this row." };
  const parsed = parseShadowVerdict(raw);
  if (!parsed.revision) {
    return { state: "not-evaluated", label: "Not evaluated", detail: "This row predates revision-stamped shadow verdicts." };
  }
  if (!currentRevision || parsed.revision !== currentRevision) {
    return {
      state: "stale",
      label: "Draft no longer current",
      detail: "Evaluated against a draft that is no longer current.",
    };
  }
  return {
    state: parsed.verdict === "allow" ? "allow" : "deny",
    label: parsed.verdict === "allow" ? "Would allow" : parsed.verdict === "deny:policy" ? "Would block" : parsed.verdict,
    detail: `Stored verdict for current draft revision ${parsed.revision.slice(0, 8)}.`,
  };
}

export function CallDetailDrawer({
  row,
  open,
  onOpenChange,
  currentShadowRevision,
  agentName = null,
}: {
  row: DepartureRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentShadowRevision: string | null;
  /** The agent's CURRENT name, resolved by the caller from CallContext.agentNames. */
  agentName?: string | null;
}) {
  const [copied, setCopied] = useState(false);
  const status = row ? statusDetail(row) : null;
  const outcome = row ? callOutcome(row.status) : null;
  const shadow = row ? describeStoredShadow(row.policy_shadow_would, currentShadowRevision) : null;
  const tokenFacts = row ? reportedTokens(row) : null;
  const charge = row ? capCharge(row) : null;

  // ── The zero that is not an observation ────────────────────────────────────
  //
  // A `usage_unknown` row records 0/0 because no usage report ever arrived, not
  // because the call was free. Rendering that as a plain "0" beside a "Cost
  // $0.000000" is the same failure this project has already been bitten by
  // once: a stored fact displayed as a confirmation of something it does not
  // say. Worse here, because the row DID move money — it was charged at the
  // greater of observed and reserved, and that figure is the only one on the
  // row an operator can reconcile against a provider bill.
  //
  // So the observed figures are labelled unconfirmed, and the enforced pair is
  // shown beside them whenever it exists.
  const unconfirmedUsage = row?.status === "usage_unknown";
  const forwarded = outcome ? wasForwarded(outcome.category) : false;
  // A refused row stores 0/0/0 because there was nothing to measure, not
  // because a measurement came back zero. It says "not sent" instead.
  const observed = (value: number | null | undefined): string =>
    tokenFacts?.kind === "not_sent"
      ? "Not sent — nothing to measure"
      : value == null
        ? "Not reported"
        : unconfirmedUsage
          ? `${value.toLocaleString()} (unconfirmed)`
          : value.toLocaleString();
  const totalTokens =
    tokenFacts?.kind === "reported"
      ? tokenFacts.total.toLocaleString()
      : tokenFacts?.kind === "unconfirmed"
        ? `${tokenFacts.observed.toLocaleString()} (unconfirmed)`
        : tokenFacts?.kind === "partial"
          ? `${tokenFacts.known.toLocaleString()} + not reported`
          : tokenFacts?.kind === "not_reported"
            ? "Not reported"
            : "Not sent — nothing to measure";
  const endpoint = readRecordedEndpoint(row?.receipt);
  const upstreamStatus = readRecordedUpstreamStatus(row?.receipt);
  const upstreamMeaning = upstreamStatus === null ? null : describeUpstreamStatus(upstreamStatus);
  const nextActions = row ? nextActionsFor(row, upstreamStatus) : [];
  const copyReceipt = async () => {
    if (!row?.receipt) return;
    await navigator.clipboard.writeText(row.receipt);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <Dialog
      open={open && Boolean(row)}
      onOpenChange={(next) => {
        setCopied(false);
        onOpenChange(next);
      }}
      title="Recorded call detail"
      description="A historical agent_logs row. Nothing here is reconstructed by running today's gate."
      className="pc-call-drawer"
    >
      {row && status && shadow ? <div className="pc-call-detail" data-state={open ? "open" : "closed"}>
        <div className="pc-call-detail__truth">
          <ShieldCheck aria-hidden="true" />
          <span><strong>Stored record</strong>Every field below came from this append-only log row.</span>
        </div>

        <section
          className="pc-call-detail__verdict"
          data-status={row.status ?? "unknown"}
          data-outcome-category={outcome?.category ?? "passcontrol_side"}
        >
          <p className="pc-kicker">Recorded outcome · {outcome ? OUTCOME_CATEGORY_LABEL[outcome.category] : "Unknown"}</p>
          <h3>{status.label}</h3>
          <p>{status.explanation}</p>
          {/* The provider's own answer, first, when one was recorded: a 401
              here is the stored provider key being refused, which is a
              different fix from anything PassControl refused. */}
          {upstreamStatus !== null ? (
            <p className="pc-call-detail__upstream" data-upstream-status={upstreamStatus}>
              <strong>Provider answered HTTP {upstreamStatus}.</strong>{" "}
              {upstreamMeaning ?? "Recorded on the receipt; not verified here."}
            </p>
          ) : null}
          <p className="pc-call-detail__agent" data-agent-name={agentName ? "known" : "unknown"}>
            Agent:{" "}
            {row.agent_id ? (
              <a href={`/dashboard/agents/${encodeURIComponent(row.agent_id)}`}>
                {agentName || "Agent no longer in this workspace"}
              </a>
            ) : (
              "Not recorded"
            )}
            {agentName ? <small> (current name)</small> : null}
          </p>
          {nextActions.length ? (
            <ul className="pc-call-detail__next" aria-label="Next steps">
              {nextActions.map((action) => (
                <li key={action.href + action.label}>
                  <a href={action.href} data-next-action={action.label}>{action.label}</a>
                  {action.note ? <small>{action.note}</small> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        <dl className="pc-call-detail__grid">
          <div><dt>Recorded at</dt><dd><DashboardTimestamp value={row.created_at} /></dd></div>
          <div><dt>Stored agent ID</dt><dd><code>{row.agent_id ?? "Not recorded"}</code></dd></div>
          {/* What was presented AT THE GATEWAY, which for a passport agent is the
              visa — not the passport itself. The passport's public-key suffix and
              the visa JTI are separate rows below; this one names the credential
              the proxy actually verified. Same phrase as the Control Graph. */}
          <div><dt>Authentication method</dt><dd>{authenticationProofLabel(row.auth_method)}</dd></div>
          <div><dt>Request ID · JTI</dt><dd><code>{row.jti ?? "Not recorded"}</code></dd></div>
          <div><dt>Passport public-key suffix</dt><dd><code>{row.passport_id ? `…${row.passport_id.slice(-16)}` : "Not recorded"}</code></dd></div>
          <div><dt>Direct key ID</dt><dd><code>{row.agent_access_key_id ?? "Not recorded"}</code></dd></div>
          <div><dt>Credential use ID</dt><dd><code>{row.credential_use_id ?? "Not recorded"}</code></dd></div>
          {/* Named, not blank. The drawer is where an operator inspects a row
              the board hid, so it has to say what the row was — a model-listing
              probe carries no model, and rendering the provider alone made it
              read as a call whose model failed to record. */}
          <div><dt>Destination</dt><dd>{row.provider ?? "Not recorded"} / {departureDestination(row)}</dd></div>
          <div><dt>Call class</dt><dd>{isHousekeeping(row) ? "SDK housekeeping — preserved in the record, not counted as agent activity" : "Agent call"}</dd></div>
          {/* The one thing a blocked_endpoint row could never tell you: which
              endpoint. It has always been in the receipt; nothing showed it.
              Worded as RECORDED, not proven — these claims are decoded without
              checking the signature, and the verifier below is the proof path. */}
          {endpoint ? (
            <div><dt>Endpoint (recorded on the receipt, not verified here)</dt><dd><code>{endpoint}</code></dd></div>
          ) : null}
          {/* The status the PROVIDER returned, which the board flattened into one
              word: a 401, a 404 and a 429 all read "Provider error". On
              2026-08-17 that made an expired provider key indistinguishable from
              a wrong model id and cost a whole session. Same untrusted-claim
              wording as the endpoint above — decoded, not verified. */}
          {upstreamStatus !== null ? (
            <div>
              <dt>Provider response (recorded on the receipt, not verified here)</dt>
              <dd>
                <code>HTTP {upstreamStatus}</code>
                {upstreamMeaning ? <small className="pc-call-detail__hint">{upstreamMeaning}</small> : null}
              </dd>
            </div>
          ) : null}
          <div><dt>Input tokens (reported)</dt><dd>{observed(row.input_tokens)}</dd></div>
          <div><dt>Output tokens (reported)</dt><dd>{observed(row.output_tokens)}</dd></div>
          <div><dt>Total tokens</dt><dd>{totalTokens}</dd></div>
          <div>
            <dt>Calculated cost</dt>
            <dd>
              {!forwarded
                ? "Not sent — no cost"
                : row.cost_microcents == null
                  ? "No recorded cost — unknown, not zero"
                  : `$${(row.cost_microcents / 100_000_000).toFixed(6)}${unconfirmedUsage ? " (unconfirmed)" : ""}`}
              {forwarded ? (
                <small className="pc-call-detail__hint">
                  Reported tokens at PassControl&apos;s list price — an estimate, not the provider&apos;s invoice.
                </small>
              ) : null}
            </dd>
          </div>
          <div>
            <dt>Budget charge</dt>
            <dd data-cap-charge={charge?.kind ?? "none"}>
              {charge?.kind === "charged"
                ? `$${(charge.microcents / 100_000_000).toFixed(6)}`
                : charge?.kind === "not_recorded"
                  ? "Not recorded on this row"
                  : charge?.kind === "held"
                    ? "Reservation still held"
                    : "$0.000000"}
              <small className="pc-call-detail__hint">
                {charge?.kind === "not_recorded"
                  ? "Usage was not confirmed and this row stores no enforced amount — it predates that record, or its settlement did not complete. It cannot say what the cap was charged."
                  : charge?.kind === "held"
                    ? "Nothing was sent. The reservation this attempt made is still counted against the cap until an operator resolves it."
                    : row.status === "usage_unknown"
                      ? "Usage was not confirmed, so the greater observed-or-reserved amount was charged."
                      : "Only allowed or usage-unconfirmed calls count against an agent's cumulative cap."}
              </small>
            </dd>
          </div>
          <div>
            <dt>Budget tokens</dt>
            <dd>
              {charge?.kind === "charged"
                ? charge.tokens.toLocaleString()
                : charge?.kind === "not_recorded"
                  ? "Not recorded on this row"
                  : charge?.kind === "held"
                    ? "Reservation still held"
                    : "0"}
            </dd>
          </div>
          <div><dt>Usage status</dt><dd>{usageLabel(row)}</dd></div>
          <div><dt>Latency</dt><dd>{row.latency_ms == null ? "Not recorded" : `${row.latency_ms.toLocaleString()} ms`}</dd></div>
        </dl>

        <section className="pc-call-detail__shadow" data-state={shadow.state}>
          <div><FileClock aria-hidden="true" /><span><strong>Shadow policy</strong>{shadow.label}</span></div>
          <p>{shadow.detail}</p>
        </section>

        <section className="pc-call-detail__receipt" data-state={row.receipt ? "recorded" : "missing"}>
          <div>
            <span><strong>Signed receipt</strong>{row.receipt ? "Stored on this row" : "Not recorded"}</span>
            {row.receipt ? (
              <button type="button" className="ghost" onClick={copyReceipt}>
                {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                {copied ? "Copied" : "Copy receipt"}
              </button>
            ) : null}
          </div>
          {row.receipt ? <code title={row.receipt}>{row.receipt.slice(0, 44)}…{row.receipt.slice(-20)}</code> : null}
          <p>
            {row.receipt ? (
              <>
                Copy it, then paste it into the <a href="/verify/receipt">receipt verifier</a> to check the
                signature and issuer. A receipt proves this one call was recorded; it is not a complete history.
              </>
            ) : (
              "No receipt is stored on this row. Older rows, deployments without receipt signing, and rows whose signing failed have none — this is not evidence either way."
            )}
          </p>
        </section>
      </div> : null}
    </Dialog>
  );
}
