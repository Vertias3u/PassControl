"use client";
// The departures board: every call the gateway handles, newest first, styled
// like the thing it actually is — a border post deciding who gets through.
//
// It reuses the log rows the Control Tower already fetches and the same realtime
// subscription SpendChart uses (agent_logs is in the supabase_realtime
// publication, migration 0001), so this adds a view, not a data path. Its own
// channel name, because two components sharing one channel string is the kind of
// thing that works until it doesn't.
//
// Rows arriving over realtime come straight from the WAL with no normalization,
// so every column is treated as nullable regardless of what the initial
// server-side fetch looked like.
import { useEffect, useMemo, useRef, useState } from "react";
import { browserClient } from "@/lib/supabase/client";
import {
  departureTime,
  fare,
  flightCode,
  mergeDeparture,
  totalTokens,
  verdictFor,
  type DepartureRow,
  type DepartureTone,
} from "@/lib/departures";

export type { DepartureRow };

const MAX_ROWS = 40;

const TONE_CLASS: Record<DepartureTone, string> = {
  clear: "text-emerald-400",
  held: "text-amber-400",
  denied: "text-red-400",
};

export function DeparturesBoard({
  userId,
  initialRows,
}: {
  userId: string;
  initialRows: DepartureRow[];
}) {
  const [rows, setRows] = useState<DepartureRow[]>(() => initialRows.slice(0, MAX_ROWS));
  const [live, setLive] = useState(false);
  // Rows that arrived after mount, so only genuinely new ones animate. Without
  // this the whole board flaps on first paint and the movement means nothing.
  const arrived = useRef<Set<string>>(new Set());

  useEffect(() => {
    const supabase = browserClient();
    const channel = supabase
      .channel("agent_logs_departures")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "agent_logs", filter: `user_id=eq.${userId}` },
        (payload) => {
          const row = payload.new as DepartureRow;
          if (!row?.id) return;
          arrived.current.add(row.id);
          setRows((prev) => mergeDeparture(prev, row, MAX_ROWS));
        }
      )
      .subscribe((status) => setLive(status === "SUBSCRIBED"));

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId]);

  const { cleared, refused } = useMemo(
    () => ({
      cleared: rows.filter((r) => r.status === "ok").length,
      refused: rows.filter((r) => (r.status ?? "").startsWith("blocked")).length,
    }),
    [rows]
  );

  return (
    <div className="overflow-hidden rounded-lg border border-amber-500/20 bg-[#0b0f14]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-amber-500/20 px-4 py-3">
        <div className="flex items-baseline gap-3">
          <span className="font-mono text-sm font-bold uppercase tracking-[0.28em] text-amber-400">
            Departures
          </span>
          <span className="font-mono text-[0.7rem] uppercase tracking-[0.16em] text-amber-400/50">
            Gateway · all times UTC
          </span>
        </div>
        <div className="flex items-center gap-4 font-mono text-[0.7rem] uppercase tracking-[0.14em]">
          <span className="text-emerald-400">{cleared} cleared</span>
          <span className="text-red-400">{refused} refused</span>
          <span className="flex items-center gap-1.5 text-amber-400/70">
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                live ? "bg-emerald-400" : "bg-amber-400/40"
              }`}
              aria-hidden="true"
            />
            {live ? "live" : "connecting"}
          </span>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[46rem] border-collapse font-mono text-sm">
          <caption className="sr-only">
            Calls handled by the gateway, newest first, with the verdict for each.
          </caption>
          <thead>
            <tr className="text-left font-bold uppercase tracking-[0.14em] text-amber-400/50 [&>th]:px-4 [&>th]:py-2 [&>th]:text-[0.65rem]">
              <th scope="col">Time</th>
              <th scope="col">Flight</th>
              <th scope="col">Destination</th>
              <th scope="col">Passport</th>
              <th scope="col" className="text-right">
                Tokens
              </th>
              <th scope="col" className="text-right">
                Fare
              </th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-amber-400/40">
                  No departures yet. Route a call through the gateway and it lands here.
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const verdict = verdictFor(row.status);
                const refusedRow = verdict.tone === "denied";
                return (
                  <tr
                    key={row.id}
                    className={`border-t border-amber-500/10 text-amber-100/80 ${
                      refusedRow ? "bg-red-500/[0.07]" : ""
                    } ${arrived.current.has(row.id) ? "pc-departure-new" : ""}`}
                  >
                    <td className="px-4 py-2 tabular-nums text-amber-200/60">
                      {departureTime(row.created_at)}
                    </td>
                    <td className="px-4 py-2 font-bold tracking-[0.08em] text-amber-200">
                      {flightCode(row)}
                    </td>
                    <td className="px-4 py-2 text-amber-100/70">
                      {row.provider ?? "—"}
                      {row.model ? <span className="text-amber-100/40"> / {row.model}</span> : null}
                    </td>
                    <td className="px-4 py-2 text-amber-100/40" title={row.passport_id ?? ""}>
                      {(row.passport_id ?? "—").slice(0, 10)}
                      {row.passport_id ? "…" : ""}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-amber-100/60">
                      {totalTokens(row) || "—"}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-amber-100/60">
                      {fare(row.cost_microcents)}
                    </td>
                    <td className={`px-4 py-2 font-bold tracking-[0.1em] ${TONE_CLASS[verdict.tone]}`}>
                      {verdict.word}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
