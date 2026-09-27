import { CheckCircle2, AlertCircle, XCircle, HelpCircle } from "lucide-react";
import type { LogEntry } from "@/lib/log";
import { CALL_OUTCOME, callOutcome } from "@/lib/call-outcome";

// Derived from LogEntry rather than restated, so CONFIG below (a Record over
// every member) fails to compile when a new audit status ships without a label.
// A hand-kept copy silently drifted: blocked_endpoint was written to the log but
// never listed here, and fell through to the "Provider error" fallback — the
// Control Tower showed a policy block as an upstream failure.
// `import type` is erased at build time, so no server-only code reaches the client.
export type StatusType = LogEntry["status"] | "active" | "suspended" | "revoked";

type Tone = "success" | "warning" | "danger";
const TONE_HEX: Record<Tone, string> = {
  success: "#10b981",
  warning: "#f59e0b",
  danger: "#ef4444",
};

// Tone and icon per status. The WORDS for a call status come from
// lib/call-outcome.ts, shared with the board, the drawer and the agent page, so
// one outcome is never named two ways on the same screen.
const AGENT_LABEL: Record<"active" | "suspended" | "revoked", string> = {
  active: "Active",
  suspended: "Suspended",
  revoked: "Revoked",
};

const CONFIG: Record<StatusType, { Icon: typeof CheckCircle2; tone: Tone }> = {
  active: { Icon: CheckCircle2, tone: "success" },
  ok: { Icon: CheckCircle2, tone: "success" },
  suspended: { Icon: AlertCircle, tone: "warning" },
  blocked_budget: { Icon: AlertCircle, tone: "warning" },
  blocked_budget_period: { Icon: AlertCircle, tone: "warning" },
  blocked_scope: { Icon: AlertCircle, tone: "warning" },
  // Distinct from a scope violation: the visa's scope allowed this call and a
  // policy rule on the agent refused it anyway.
  blocked_policy: { Icon: AlertCircle, tone: "warning" },
  // "Budget exceeded" above is ours; this one is the provider's own balance.
  provider_exhausted: { Icon: AlertCircle, tone: "warning" },
  // A setup gap here, not a fault out there — the call never left.
  no_provider_key: { Icon: AlertCircle, tone: "warning" },
  // Not "Endpoint blocked" below: that one means the requested path was outside
  // the allowed route set. This means we could not read WHERE this credential
  // goes, so the call was refused rather than aimed at a guess.
  endpoint_unavailable: { Icon: AlertCircle, tone: "warning" },
  credential_state_unavailable: { Icon: AlertCircle, tone: "warning" },
  // Warning, not danger. Nothing was refused on the agent's account and nothing
  // failed: an operator changed the credential while this call was being
  // assembled, and the retry will be fine.
  credential_changed: { Icon: AlertCircle, tone: "warning" },
  // A configuration answer, not a spend answer — deliberately not the tone or
  // the wording of a budget denial. The agent is not out of money.
  blocked_unpriced_endpoint: { Icon: AlertCircle, tone: "warning" },
  blocked_unpriced_model: { Icon: AlertCircle, tone: "warning" },
  upstream_error: { Icon: HelpCircle, tone: "warning" },
  // The call reached a provider and the accounting did not come back. Warning
  // rather than danger: nothing was refused and nothing necessarily failed.
  usage_unknown: { Icon: HelpCircle, tone: "warning" },
  // Deliberately NOT the same tone or wording as a budget denial. The agent is
  // not out of money; PassControl cannot currently vouch for how much it has
  // spent, and refuses instead of inventing a figure.
  blocked_budget_state: { Icon: AlertCircle, tone: "warning" },
  // Same warning tone as its sibling above, and for the same reason: nothing was
  // spent and nothing is broken about the agent, but an operator should look.
  dispatch_unavailable: { Icon: AlertCircle, tone: "warning" },
  blocked_endpoint: { Icon: AlertCircle, tone: "warning" },
  revoked: { Icon: XCircle, tone: "danger" },
  blocked_suspended: { Icon: XCircle, tone: "danger" },
  // Distinct from "Agent suspended": this call was stopped by the kill switch
  // (platform, tenant, or denylist), not by anything set on the agent itself.
  blocked_killed: { Icon: XCircle, tone: "danger" },
};

function defaultLabelFor(status: StatusType): string {
  if (status in AGENT_LABEL) return AGENT_LABEL[status as keyof typeof AGENT_LABEL];
  if (status in CALL_OUTCOME) return CALL_OUTCOME[status as LogEntry["status"]].label;
  return callOutcome(status).label;
}

export function StatusPill({ status, label }: { status: StatusType; label?: string }) {
  // An unrecognised status keeps a neutral icon and says what it is. It used
  // to borrow upstream_error's entry, which labelled it "Provider error".
  const { Icon, tone } = CONFIG[status] ?? { Icon: HelpCircle, tone: "warning" as const };
  const defaultLabel = defaultLabelFor(status);
  const color = TONE_HEX[tone];
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold"
      style={{ color, background: `${color}26` }}
    >
      <Icon className="h-3 w-3" />
      {label ?? defaultLabel}
    </span>
  );
}
