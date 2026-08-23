"use client";

import { useState } from "react";
import { Check, Copy, FileClock, ShieldCheck } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { departureDestination, type DepartureRow } from "@/lib/departures";
import { isHousekeeping } from "@/lib/call-class";
import type { LogEntry } from "@/lib/log";
import { parseShadowVerdict } from "@/lib/policy-shadow";
import {
  readRecordedEndpoint,
  readRecordedUpstreamStatus,
  describeUpstreamStatus,
} from "@/lib/verify/receipt-view";
import { DashboardTimestamp } from "@/components/dashboard/DashboardTime";

export interface CallContext {
  shadowRevisions: Record<string, string | null>;
}

const STATUS: Record<LogEntry["status"], { label: string; explanation: string }> = {
  ok: { label: "Allowed and forwarded", explanation: "The stored row says the governed attempt passed PassControl and reached the provider." },
  upstream_error: { label: "Provider error", explanation: "PassControl allowed the attempt, but the upstream provider returned an error." },
  provider_exhausted: { label: "Provider credit exhausted", explanation: "PassControl allowed the attempt; the provider account, not the PassControl budget, had no credit." },
  no_provider_key: { label: "No provider key stored", explanation: "PassControl refused before forwarding: no key is stored for this provider, so there was nothing to inject. The provider never received this call — store a key for it and retry." },
  blocked_scope: { label: "Blocked by visa scope", explanation: "The visa's stored capability snapshot did not cover this provider and model." },
  blocked_policy: { label: "Blocked by live policy", explanation: "The live policy recorded on this attempt refused it." },
  blocked_budget: { label: "Blocked by PassControl budget", explanation: "The PassControl budget gate refused the attempt before provider forwarding." },
  blocked_killed: { label: "Blocked by kill switch", explanation: "A platform, tenant, or denylist kill state refused the attempt." },
  blocked_suspended: { label: "Blocked by agent suspension", explanation: "This agent was suspended when the attempt was recorded." },
  blocked_endpoint: { label: "Blocked endpoint", explanation: "The requested provider endpoint was outside the proxy's allowed route set." },
};

function statusDetail(status: string | null) {
  return STATUS[status as LogEntry["status"]] ?? {
    label: status || "Unknown status",
    explanation: "This stored status is not recognised by the current dashboard. It is shown verbatim and is not reinterpreted.",
  };
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
}: {
  row: DepartureRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentShadowRevision: string | null;
}) {
  const [copied, setCopied] = useState(false);
  const status = row ? statusDetail(row.status) : null;
  const shadow = row ? describeStoredShadow(row.policy_shadow_would, currentShadowRevision) : null;
  const tokens = row ? (row.input_tokens ?? 0) + (row.output_tokens ?? 0) : 0;
  const endpoint = readRecordedEndpoint(row?.receipt);
  const upstreamStatus = readRecordedUpstreamStatus(row?.receipt);
  const upstreamMeaning = upstreamStatus === null ? null : describeUpstreamStatus(upstreamStatus);
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

        <section className="pc-call-detail__verdict" data-status={row.status ?? "unknown"}>
          <p className="pc-kicker">Recorded outcome</p>
          <h3>{status.label}</h3>
          <p>{status.explanation}</p>
        </section>

        <dl className="pc-call-detail__grid">
          <div><dt>Recorded at</dt><dd><DashboardTimestamp value={row.created_at} /></dd></div>
          <div><dt>Stored agent ID</dt><dd><code>{row.agent_id ?? "Not recorded"}</code></dd></div>
          {/* What was presented AT THE GATEWAY, which for a passport agent is the
              visa — not the passport itself. The passport's public-key suffix and
              the visa JTI are separate rows below; this one names the credential
              the proxy actually verified. Same phrase as the Control Graph. */}
          <div><dt>Authentication method</dt><dd>{row.auth_method === "direct_key" ? "Direct Agent Key" : row.auth_method === "passport" ? "Passport visa" : "Not recorded"}</dd></div>
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
          <div><dt>Input tokens</dt><dd>{row.input_tokens?.toLocaleString() ?? "Not recorded"}</dd></div>
          <div><dt>Output tokens</dt><dd>{row.output_tokens?.toLocaleString() ?? "Not recorded"}</dd></div>
          <div><dt>Total tokens</dt><dd>{tokens.toLocaleString()}</dd></div>
          <div><dt>Cost</dt><dd>{row.cost_microcents == null ? "Not recorded" : `$${(row.cost_microcents / 100_000_000).toFixed(6)}`}</dd></div>
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
          <p>{row.receipt ? "Use the public verifier to validate this exact stored receipt." : "Older or unsigned deployments can legitimately have no receipt."}</p>
        </section>
      </div> : null}
    </Dialog>
  );
}
