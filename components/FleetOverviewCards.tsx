import { MetricCard } from "./MetricCard";
import { Users, DollarSign, ShieldAlert, Activity } from "lucide-react";

export function FleetOverviewCards(props: {
  activeAgents: number;
  totalAgents: number;
  spentMicrocents: number;
  blockedCalls: number;
  recentCalls: number;
  attentionAgents: number;
}) {
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
        note={`Latest ${props.recentCalls} call record${props.recentCalls === 1 ? "" : "s"}`}
        href="#activity"
        tone={props.blockedCalls ? "warning" : "neutral"}
      />
      <MetricCard
        label="Needs attention"
        value={props.attentionAgents}
        icon={<Activity className="h-5 w-5" />}
        note={props.attentionAgents ? "Suspended, revoked, or near budget" : "No agent alerts"}
        href="#fleet"
        tone={props.attentionAgents ? "danger" : "neutral"}
      />
    </div>
  );
}
