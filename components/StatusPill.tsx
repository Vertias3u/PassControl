import { CheckCircle2, AlertCircle, XCircle, HelpCircle } from "lucide-react";

export type StatusType =
  | "active"
  | "suspended"
  | "revoked"
  | "ok"
  | "blocked_budget"
  | "blocked_suspended"
  | "blocked_scope"
  | "upstream_error";

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
  revoked: { label: "Revoked", Icon: XCircle, tone: "danger" },
  blocked_suspended: { label: "Agent suspended", Icon: XCircle, tone: "danger" },
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
