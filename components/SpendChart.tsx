"use client";
// Real-time spend: subscribes to agent_logs inserts (RLS-filtered) and renders a
// simple rolling token/cost sparkline without a chart dependency.
import { useEffect, useMemo, useState } from "react";
import { browserClient } from "@/lib/supabase/client";
import { useDashboardTime } from "@/components/dashboard/DashboardTime";
import { isInference } from "@/lib/call-class";

interface Log {
  id: string;
  created_at: string;
  provider?: string | null;
  model?: string | null;
  // Needed to tell an agent call from SDK housekeeping. Absent on neither the
  // dashboard's select nor the realtime payload; optional here only so the
  // interface stays a description of what is read, not what is required.
  status?: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_microcents: number | null;
}

export function SpendChart({
  userId,
  initialLogs,
  logsAvailable,
}: {
  userId: string;
  initialLogs: Log[];
  /**
   * Whether the loaded window was read at all. REQUIRED: an unreadable read
   * arrives as an empty array, and this chart's whole vocabulary ("in loaded
   * window", "no agent calls") describes a window that in that case does not
   * exist. Like the departures board it also subscribes, so the flag must
   * survive realtime rows filling the gap with a handful of calls.
   */
  logsAvailable: boolean;
}) {
  const [allLogs, setLogs] = useState<Log[]>(initialLogs);
  const [live, setLive] = useState(false);
  const { format, zoneLabel } = useDashboardTime();

  useEffect(() => {
    const supabase = browserClient();
    const channel = supabase
      .channel("agent_logs_spend")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "agent_logs", filter: `user_id=eq.${userId}` },
        (payload) => setLogs((prev) => [payload.new as Log, ...prev].slice(0, 200))
      )
      .subscribe((status) => setLive(status === "SUBSCRIBED"));
    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId]);

  const { totalTokens, totalCost, uncostedCalls, bars, providers, callCount } = useMemo(() => {
    // A spend view has nothing to say about SDK housekeeping: a model-listing
    // probe carries no tokens and no cost, so it contributed only a zero-height
    // bar and inflated the per-provider call count. Filtered here rather than in
    // the page, because this component subscribes to realtime itself and would
    // otherwise take probes straight back in off the WAL.
    const logs = allLogs.filter(isInference);
    const recent = [...logs].slice(0, 40).reverse();
    const max = Math.max(1, ...recent.map((l) => (l.input_tokens ?? 0) + (l.output_tokens ?? 0)));
    const byProvider = new Map<string, { calls: number; cost: number; tokens: number }>();
    for (const log of logs) {
      const provider = log.provider ?? "unknown";
      const current = byProvider.get(provider) ?? { calls: 0, cost: 0, tokens: 0 };
      current.calls += 1;
      current.cost += log.cost_microcents ?? 0;
      current.tokens += (log.input_tokens ?? 0) + (log.output_tokens ?? 0);
      byProvider.set(provider, current);
    }
    return {
      totalTokens: logs.reduce((s, l) => s + (l.input_tokens ?? 0) + (l.output_tokens ?? 0), 0),
      totalCost: logs.reduce((s, l) => s + (l.cost_microcents ?? 0), 0),
      // A null cost is UNKNOWN, not zero, so it cannot be added to a total —
      // but a total that silently drops rows is its own kind of wrong. Count
      // them and say so under the figure.
      //
      // Worded as "no recorded cost" rather than "unpriced" on purpose: rows
      // predating the unpriced distinction are also null, and this must not
      // retroactively relabel them as something they were never recorded as.
      uncostedCalls: logs.reduce((n, l) => n + (l.cost_microcents == null ? 1 : 0), 0),
      bars: recent.map((log) => ({
        log,
        height: ((log.input_tokens ?? 0) + (log.output_tokens ?? 0)) / max,
      })),
      providers: [...byProvider.entries()].sort((a, b) => b[1].cost - a[1].cost),
      callCount: logs.length,
    };
  }, [allLogs]);

  const first = bars[0]?.log.created_at;
  const last = bars.at(-1)?.log.created_at;
  const time = (value: string | undefined) => value ? format(value, "time") : "—";

  return (
    <div className="pc-spend-view">
      {logsAvailable ? null : (
        <p className="pc-spend-view__unavailable" data-state="unavailable" role="status">
          The call history could not be read, so there is no loaded window. Anything shown below
          arrived since this page loaded.
        </p>
      )}
      <div className="pc-spend-view__summary">
        <div className="pc-spend-stat">
          <div>Tokens in loaded window</div>
          <strong>{totalTokens.toLocaleString()}</strong>
          <span>{callCount} agent call{callCount === 1 ? "" : "s"}</span>
        </div>
        <div className="pc-spend-stat">
          <div>Cost in loaded window</div>
          <strong>${(totalCost / 1e8).toFixed(4)}</strong>
          <span>
            {uncostedCalls
              ? `Not an all-time total · excludes ${uncostedCalls} call${uncostedCalls === 1 ? "" : "s"} with no recorded cost`
              : "Not an all-time total"}
          </span>
        </div>
        <div className="pc-spend-stat">
          <div>Data state</div>
          <strong className={live ? "is-live" : "is-stale"}>{live ? "Live" : "Connecting"}</strong>
          <span>Realtime inserts · {zoneLabel}</span>
        </div>
      </div>

      <div className="pc-spend-chart" aria-label="Token volume for the most recent 40 loaded calls">
        {bars.length === 0 ? (
          <div className="pc-spend-chart__empty" data-state={logsAvailable ? undefined : "unavailable"}>
            {logsAvailable ? (
              <>
                <span>No agent calls in this loaded window.</span>
                <small>Once an agent routes a call through the gateway, token volume appears here.</small>
              </>
            ) : (
              <>
                <span>Token volume is unavailable.</span>
                <small>The call history could not be read. This is not a statement that no calls were made.</small>
              </>
            )}
          </div>
        ) : (
          <>
            <div className="pc-spend-chart__plot">
              {bars.map(({ log, height }) => {
                const tokens = (log.input_tokens ?? 0) + (log.output_tokens ?? 0);
                // No recorded cost reads as a dash, never as $0.000000 — the
                // same choice `fare()` already makes on the departures board.
                const money =
                  log.cost_microcents == null
                    ? "no recorded cost"
                    : `$${(log.cost_microcents / 1e8).toFixed(6)}`;
                const label = `${time(log.created_at)} · ${log.provider ?? "unknown"}/${log.model ?? "unknown"} · ${tokens.toLocaleString()} tokens · ${money}`;
                return (
                  <div
                    key={log.id}
                    className="pc-spend-chart__bar"
                    style={{ height: `${Math.max(3, height * 100)}%` }}
                    title={label}
                    aria-label={label}
                    tabIndex={0}
                  />
                );
              })}
            </div>
            <div className="pc-spend-chart__axis">
              <span>{time(first)}</span>
              <span>Most recent {bars.length} calls</span>
              <span>{time(last)}</span>
            </div>
          </>
        )}
      </div>

      {providers.length ? (
        <div className="pc-provider-breakdown" aria-label="Loaded spend by provider">
          {providers.map(([provider, data]) => (
            <div key={provider}>
              <span>{provider}</span>
              <strong>${(data.cost / 1e8).toFixed(4)}</strong>
              <small>{data.calls} calls · {data.tokens.toLocaleString()} tokens</small>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
