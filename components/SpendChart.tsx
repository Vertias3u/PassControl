"use client";
// Real-time spend: subscribes to agent_logs inserts (RLS-filtered) and renders a
// simple rolling token/cost sparkline without a chart dependency.
import { useEffect, useMemo, useState } from "react";
import { browserClient } from "@/lib/supabase/client";

interface Log {
  id: string;
  created_at: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_microcents: number | null;
}

export function SpendChart({ userId, initialLogs }: { userId: string; initialLogs: Log[] }) {
  const [logs, setLogs] = useState<Log[]>(initialLogs);

  useEffect(() => {
    const supabase = browserClient();
    const channel = supabase
      .channel("agent_logs_spend")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "agent_logs", filter: `user_id=eq.${userId}` },
        (payload) => setLogs((prev) => [payload.new as Log, ...prev].slice(0, 200))
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId]);

  const { totalTokens, totalCost, bars } = useMemo(() => {
    const recent = [...logs].slice(0, 40).reverse();
    const max = Math.max(1, ...recent.map((l) => (l.input_tokens ?? 0) + (l.output_tokens ?? 0)));
    return {
      totalTokens: logs.reduce((s, l) => s + (l.input_tokens ?? 0) + (l.output_tokens ?? 0), 0),
      totalCost: logs.reduce((s, l) => s + (l.cost_microcents ?? 0), 0),
      bars: recent.map((l) => ((l.input_tokens ?? 0) + (l.output_tokens ?? 0)) / max),
    };
  }, [logs]);

  return (
    <div className="grid gap-4">
      <div className="flex gap-8">
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Tokens (window)</div>
          <div className="text-2xl font-bold text-primary">{totalTokens.toLocaleString()}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Cost (window)</div>
          <div className="text-2xl font-bold text-primary">${(totalCost / 1e8).toFixed(4)}</div>
        </div>
      </div>
      <div className="flex h-20 items-end gap-[3px]">
        {bars.length === 0 ? (
          <span className="text-sm text-muted-foreground">No calls yet.</span>
        ) : (
          bars.map((h, i) => (
            <div
              key={i}
              className="flex-1 rounded-sm bg-primary"
              style={{ height: `${Math.max(2, h * 100)}%` }}
            />
          ))
        )}
      </div>
    </div>
  );
}
