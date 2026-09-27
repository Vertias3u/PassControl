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
  /**
   * Whether the call-log read behind three of these four cards succeeded.
   *
   * REQUIRED, with no default, for the same reason `controlExerciseAt` is
   * required in lib/first-call-activation.ts: a default here would make a
   * caller that never thought about it publish a census it did not take. An
   * unreadable log arrives as an empty array, and an empty array renders as
   * "0 refused calls" — a confident measurement of the fault itself.
   */
  logsAvailable: boolean;
  /**
   * Whether the agents read succeeded. Required for the same reason as
   * `logsAvailable`: an unreadable agent list also arrives as an empty array,
   * and Session 07 saw it render "0 of 0 · No passports issued" and "$0.00"
   * with PostgREST down. The agent count, the settled charges (summed from the
   * agents' own counters) and the attention queue all come from that read.
   */
  agentsAvailable: boolean;
}) {
  const probes = props.housekeepingCalls ?? 0;
  const agents = props.agentsAvailable;
  const scanNote = !props.logsAvailable
    ? "Call history unavailable"
    : `Latest ${props.recentCalls} agent call${props.recentCalls === 1 ? "" : "s"}` +
      (probes ? ` · ${probes} SDK probe${probes === 1 ? "" : "s"}` : "");
  // The queue itself is still true as far as it goes — expiry and status come
  // from the agent rows. What it can no longer see is anything call-derived
  // (recent refusals, burn rate), so an empty queue must not read as all clear.
  const attentionNote = !agents
    ? "Agent list unavailable"
    : props.logsAvailable
      ? props.attention.note
      : props.attention.count
        ? `${props.attention.note} · call signals unavailable`
        : "Call signals unavailable";
  return (
    <div className="pc-metric-grid pc-overview-status-rail" aria-label="Fleet operational summary">
      <MetricCard
        label="Active agents"
        value={agents ? props.activeAgents : "—"}
        unit={agents ? `of ${props.totalAgents}` : undefined}
        state={agents ? undefined : "unavailable"}
        icon={<Users className="h-5 w-5" />}
        note={!agents ? "Agent list unavailable" : props.totalAgents ? "Open the fleet" : "No agents yet"}
        href="#fleet"
        tone="signal"
      />
      <MetricCard
        // NOT "Tracked spend", and the rename is the fix rather than a tidy-up
        // (T4-02). This figure is what PassControl charged against budgets —
        // Postgres defines it once, in 0055, as
        // `coalesce(enforced_microcents, coalesce(cost_microcents, 0))`. It
        // equals observed cost for every provider PassControl prices, and for a
        // call it cannot price it contains a conservative estimate while the
        // receipt for that same call says the cost is unknown. Labelling it
        // "Tracked spend" made this card contradict a signed receipt.
        label="Settled budget charges"
        value={agents ? `$${(props.spentMicrocents / 1e8).toFixed(2)}` : "—"}
        state={agents ? undefined : "unavailable"}
        icon={<DollarSign className="h-5 w-5" />}
        note={agents ? "Counted against cumulative agent caps · all time" : "Agent counters unavailable"}
        href="#spend"
      />
      <MetricCard
        label="Refused calls"
        // An em dash, not a zero. The count is unknown, and the two are not the
        // same statement — the operator most likely to read this card is the
        // one investigating the incident that broke the read.
        value={props.logsAvailable ? props.blockedCalls : "—"}
        state={props.logsAvailable ? undefined : "unavailable"}
        icon={<ShieldAlert className="h-5 w-5" />}
        note={scanNote}
        href="#activity"
        tone={props.logsAvailable && props.blockedCalls ? "warning" : "neutral"}
      />
      <MetricCard
        label="Needs attention"
        value={agents ? props.attention.count : "—"}
        state={agents && props.logsAvailable ? undefined : "unavailable"}
        icon={<Activity className="h-5 w-5" />}
        note={attentionNote}
        href="#fleet"
        tone={props.attention.tone}
      />
    </div>
  );
}
