import { CheckCircle2, AlertCircle, XCircle, HelpCircle } from "lucide-react";
import type { LogEntry } from "@/lib/log";

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

const CONFIG: Record<StatusType, { label: string; Icon: typeof CheckCircle2; tone: Tone }> = {
  active: { label: "Active", Icon: CheckCircle2, tone: "success" },
  ok: { label: "OK", Icon: CheckCircle2, tone: "success" },
  suspended: { label: "Suspended", Icon: AlertCircle, tone: "warning" },
  blocked_budget: { label: "Budget exceeded", Icon: AlertCircle, tone: "warning" },
  blocked_scope: { label: "Scope violation", Icon: AlertCircle, tone: "warning" },
  // Distinct from a scope violation: the visa's scope allowed this call and a
  // policy rule on the agent refused it anyway.
  blocked_policy: { label: "Policy rule", Icon: AlertCircle, tone: "warning" },
  // "Budget exceeded" above is ours; this one is the provider's own balance.
  provider_exhausted: { label: "Provider out of credit", Icon: AlertCircle, tone: "warning" },
  // A setup gap here, not a fault out there — the call never left.
  no_provider_key: { label: "No provider key stored", Icon: AlertCircle, tone: "warning" },
  // Not "Endpoint blocked" below: that one means the requested path was outside
  // the allowed route set. This means we could not read WHERE this credential
  // goes, so the call was refused rather than aimed at a guess.
  endpoint_unavailable: { label: "Endpoint lookup failed", Icon: AlertCircle, tone: "warning" },
  credential_state_unavailable: { label: "Credential check unavailable", Icon: AlertCircle, tone: "warning" },
  // Warning, not danger. Nothing was refused on the agent's account and nothing
  // failed: an operator changed the credential while this call was being
  // assembled, and the retry will be fine.
  credential_changed: { label: "Credential changed mid-call", Icon: AlertCircle, tone: "warning" },
  // A configuration answer, not a spend answer — deliberately not the tone or
  // the wording of a budget denial. The agent is not out of money.
  blocked_unpriced_endpoint: { label: "Cost cap cannot be priced here", Icon: AlertCircle, tone: "warning" },
  upstream_error: { label: "Provider error", Icon: HelpCircle, tone: "warning" },
  // The call reached a provider and the accounting did not come back. Warning
  // rather than danger: nothing was refused and nothing necessarily failed.
  usage_unknown: { label: "Usage unconfirmed", Icon: HelpCircle, tone: "warning" },
  // Deliberately NOT the same tone or wording as a budget denial. The agent is
  // not out of money; PassControl cannot currently vouch for how much it has
  // spent, and refuses instead of inventing a figure.
  blocked_budget_state: { label: "Budget state unavailable", Icon: AlertCircle, tone: "warning" },
  // Same warning tone as its sibling above, and for the same reason: nothing was
  // spent and nothing is broken about the agent, but an operator should look.
  dispatch_unavailable: { label: "Dispatch unconfirmed", Icon: AlertCircle, tone: "warning" },
  blocked_endpoint: { label: "Endpoint blocked", Icon: AlertCircle, tone: "warning" },
  revoked: { label: "Revoked", Icon: XCircle, tone: "danger" },
  blocked_suspended: { label: "Agent suspended", Icon: XCircle, tone: "danger" },
  // Distinct from "Agent suspended": this call was stopped by the kill switch
  // (platform, tenant, or denylist), not by anything set on the agent itself.
  blocked_killed: { label: "Kill switch", Icon: XCircle, tone: "danger" },
};

export function StatusPill({ status, label }: { status: StatusType; label?: string }) {
  const { label: defaultLabel, Icon, tone } = CONFIG[status] ?? CONFIG.upstream_error;
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
