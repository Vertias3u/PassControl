"use client";
// Real-time spend: subscribes to agent_logs inserts (RLS-filtered) and renders a
// simple rolling token/cost sparkline without a chart dependency.
import { useEffect, useMemo, useState } from "react";
import { browserClient } from "@/lib/supabase/client";
import { useDashboardTime } from "@/components/dashboard/DashboardTime";

interface Log {
  id: string;
  created_at: string;
  provider?: string | null;
  model?: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_microcents: number | null;
}

export function SpendChart({ userId, initialLogs }: { userId: string; initialLogs: Log[] }) {
  const [logs, setLogs] = useState<Log[]>(initialLogs);
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

  const { totalTokens, totalCost, bars, providers } = useMemo(() => {
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
      bars: recent.map((log) => ({
        log,
        height: ((log.input_tokens ?? 0) + (log.output_tokens ?? 0)) / max,
      })),
      providers: [...byProvider.entries()].sort((a, b) => b[1].cost - a[1].cost),
    };
  }, [logs]);

  const first = bars[0]?.log.created_at;
  const last = bars.at(-1)?.log.created_at;
  const time = (value: string | undefined) => value ? format(value, "time") : "—";

  return (
    <div className="pc-spend-view">
      <div className="pc-spend-view__summary">
        <div className="pc-spend-stat">
          <div>Tokens in loaded window</div>
          <strong>{totalTokens.toLocaleString()}</strong>
          <span>{logs.length} call record{logs.length === 1 ? "" : "s"}</span>
        </div>
        <div className="pc-spend-stat">
          <div>Cost in loaded window</div>
          <strong>${(totalCost / 1e8).toFixed(4)}</strong>
          <span>Not an all-time total</span>
        </div>
        <div className="pc-spend-stat">
          <div>Data state</div>
          <strong className={live ? "is-live" : "is-stale"}>{live ? "Live" : "Connecting"}</strong>
          <span>Realtime inserts · {zoneLabel}</span>
        </div>
      </div>

      <div className="pc-spend-chart" aria-label="Token volume for the most recent 40 loaded calls">
        {bars.length === 0 ? (
          <div className="pc-spend-chart__empty">
            <span>No governed calls in this loaded window.</span>
            <small>Once an agent routes a call through the gateway, token volume appears here.</small>
          </div>
        ) : (
          <>
            <div className="pc-spend-chart__plot">
              {bars.map(({ log, height }) => {
                const tokens = (log.input_tokens ?? 0) + (log.output_tokens ?? 0);
                const label = `${time(log.created_at)} · ${log.provider ?? "unknown"}/${log.model ?? "unknown"} · ${tokens.toLocaleString()} tokens · $${((log.cost_microcents ?? 0) / 1e8).toFixed(6)}`;
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
