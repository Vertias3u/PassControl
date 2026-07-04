"use client";
// Operator-accountability trail: privileged dashboard mutations recorded in
// public.admin_audit (RLS-scoped to the owner). Read-only; mirrors AuditLogTable.
import { useState } from "react";
import { UserPlus, Power, PlayCircle, KeyRound, RefreshCw, ShieldAlert, ShieldCheck, Activity } from "lucide-react";

export interface AdminAuditRow {
  id: string;
  created_at: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata: Record<string, unknown> | null;
}

type Tone = "info" | "warning" | "danger";
const TONE_HEX: Record<Tone, string> = {
  info: "#22d3ee", // neon cyan (mission-control theme)
  warning: "#f59e0b",
  danger: "#ef4444",
};

// Some actions read differently depending on their payload (suspend vs resume,
// arm vs disarm), so the label/tone/icon are derived from the row, not just the
// action name.
function describe(row: AdminAuditRow): { label: string; Icon: typeof UserPlus; tone: Tone } {
  const m = row.metadata ?? {};
  switch (row.action) {
    case "agent.create":
      return { label: "Agent created", Icon: UserPlus, tone: "info" };
    case "agent.suspend":
      return m.suspended === false
        ? { label: "Agent resumed", Icon: PlayCircle, tone: "info" }
        : { label: "Agent suspended", Icon: Power, tone: "warning" };
    case "provider_key.add":
      return { label: "Provider key added", Icon: KeyRound, tone: "info" };
    case "provider_key.rotate":
      return { label: "Provider key rotated", Icon: RefreshCw, tone: "info" };
    case "killswitch.master":
      return m.on === true
        ? { label: "Master kill ARMED", Icon: ShieldAlert, tone: "danger" }
        : { label: "Master kill disarmed", Icon: ShieldCheck, tone: "info" };
    default:
      return { label: row.action, Icon: Activity, tone: "info" };
  }
}

// Human-readable context from the metadata/target, minus the fields already
// folded into the label.
function details(row: AdminAuditRow): string {
  const m = { ...(row.metadata ?? {}) } as Record<string, unknown>;
  if (row.action === "agent.suspend") delete m.suspended;
  if (row.action === "killswitch.master") delete m.on;
  const parts = Object.entries(m).map(([k, v]) => `${k}: ${String(v)}`);
  if (row.target_id) parts.unshift(`${row.target_type ?? "target"} ${row.target_id.slice(0, 12)}…`);
  return parts.join(" · ") || "—";
}

export function AdminAuditTable({ rows }: { rows: AdminAuditRow[] }) {
  const [filter, setFilter] = useState("");
  const q = filter.toLowerCase();
  const shown = rows.filter((r) =>
    !q ? true : [describe(r).label, r.action, details(r)].some((f) => f.toLowerCase().includes(q))
  );

  if (rows.length === 0) {
    return <p className="muted">No admin actions recorded yet.</p>;
  }

  return (
    <div className="grid">
      <input
        placeholder="Filter by action / target / detail…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Action</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => {
            const { label, Icon, tone } = describe(r);
            const color = TONE_HEX[tone];
            return (
              <tr key={r.id}>
                <td className="muted" title={new Date(r.created_at).toLocaleString()}>
                  {new Date(r.created_at).toLocaleString()}
                </td>
                <td>
                  <span
                    className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold"
                    style={{ color, background: `${color}26` }}
                  >
                    <Icon className="h-3 w-3" />
                    {label}
                  </span>
                </td>
                <td className="mono">{details(r)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
