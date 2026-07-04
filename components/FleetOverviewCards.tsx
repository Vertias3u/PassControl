import { MetricCard } from "./MetricCard";
import { Users, DollarSign, ShieldAlert } from "lucide-react";

export function FleetOverviewCards(props: {
  activeAgents: number;
  totalAgents: number;
  spentMicrocents: number;
  blockedCalls: number;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <MetricCard
        label="Active agents"
        value={props.activeAgents}
        unit={`of ${props.totalAgents}`}
        icon={<Users className="h-5 w-5" />}
        highlight
      />
      <MetricCard
        label="Total spend"
        value={`$${(props.spentMicrocents / 1e8).toFixed(2)}`}
        icon={<DollarSign className="h-5 w-5" />}
      />
      <MetricCard
        label="Blocked calls"
        value={props.blockedCalls}
        icon={<ShieldAlert className="h-5 w-5" />}
      />
    </div>
  );
}
