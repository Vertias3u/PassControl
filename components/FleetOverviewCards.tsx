import { MetricCard } from "./MetricCard";
import { Users, DollarSign, ShieldAlert, Activity } from "lucide-react";
import type { FleetAttentionSummary } from "@/lib/dashboard-attention";

export function FleetOverviewCards(props: {
  activeAgents: number;
  totalAgents: number;
  spentMicrocents: number;
  blockedCalls: number;
  /** Agent calls only. SDK capability probes are counted separately below so
   *  the refusal figure reads against work the agent actually asked for. */
  recentCalls: number;
  /** Preserved and disclosed, never folded into the denominator. */
  housekeepingCalls?: number;
  /**
   * The queue, already summarised. A count alone cannot colour this card: the
   * queue now holds a housekeeping tier ("Set a passport expiry") alongside
   * real faults, and a card that goes red for any non-zero count is a card
   * operators learn to ignore. Both the tone and the subtitle are derived from
   * the reasons actually present — see summariseFleetAttention.
   */
  attention: FleetAttentionSummary;
}) {
  const probes = props.housekeepingCalls ?? 0;
  const scanNote =
    `Latest ${props.recentCalls} agent call${props.recentCalls === 1 ? "" : "s"}` +
    (probes ? ` · ${probes} SDK probe${probes === 1 ? "" : "s"}` : "");
  return (
    <div className="pc-metric-grid pc-overview-status-rail" aria-label="Fleet operational summary">
      <MetricCard
        label="Active agents"
        value={props.activeAgents}
        unit={`of ${props.totalAgents}`}
        icon={<Users className="h-5 w-5" />}
        note={props.totalAgents ? "Open the fleet" : "No passports issued"}
        href="#fleet"
        tone="signal"
      />
      <MetricCard
        label="Tracked spend"
        value={`$${(props.spentMicrocents / 1e8).toFixed(2)}`}
        icon={<DollarSign className="h-5 w-5" />}
        note="Aggregate agent counters"
        href="#spend"
      />
      <MetricCard
        label="Refused calls"
        value={props.blockedCalls}
        icon={<ShieldAlert className="h-5 w-5" />}
        note={scanNote}
        href="#activity"
        tone={props.blockedCalls ? "warning" : "neutral"}
      />
      <MetricCard
        label="Needs attention"
        value={props.attention.count}
        icon={<Activity className="h-5 w-5" />}
        note={props.attention.note}
        href="#fleet"
        tone={props.attention.tone}
      />
    </div>
  );
}
