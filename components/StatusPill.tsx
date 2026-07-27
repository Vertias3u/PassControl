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
  upstream_error: { label: "Provider error", Icon: HelpCircle, tone: "warning" },
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
