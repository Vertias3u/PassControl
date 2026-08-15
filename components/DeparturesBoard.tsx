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
import { Pause, Play, Search, Radio, WifiOff } from "lucide-react";
import { browserClient } from "@/lib/supabase/client";
import {
  fare,
  flightCode,
  mergeDeparture,
  totalTokens,
  verdictFor,
  type DepartureRow,
  type DepartureTone,
} from "@/lib/departures";
import { CallDetailDrawer, type CallContext } from "@/components/dashboard/CallDetailDrawer";
import { useDashboardTime } from "@/components/dashboard/DashboardTime";

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
  callContext,
}: {
  userId: string;
  initialRows: DepartureRow[];
  callContext: CallContext;
}) {
  const [rows, setRows] = useState<DepartureRow[]>(() => initialRows.slice(0, MAX_ROWS));
  const [live, setLive] = useState(false);
  const [paused, setPaused] = useState(false);
  const [queued, setQueued] = useState(0);
  const [filter, setFilter] = useState<"all" | "cleared" | "refused">("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<DepartureRow | null>(null);
  const { format, zoneLabel } = useDashboardTime();
  const pausedRef = useRef(false);
  const queuedRows = useRef<DepartureRow[]>([]);
  // Rows that arrived after mount, so only genuinely new ones animate. Without
  // this the whole board flaps on first paint and the movement means nothing.
  const arrived = useRef<Set<string>>(new Set());

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

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
          if (pausedRef.current) {
            queuedRows.current = mergeDeparture(queuedRows.current, row, MAX_ROWS);
            setQueued(queuedRows.current.length);
            return;
          }
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

  const visibleRows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => {
      const verdict = verdictFor(row.status);
      if (filter === "cleared" && verdict.tone !== "clear") return false;
      if (filter === "refused" && !(row.status ?? "").startsWith("blocked_")) return false;
      if (!needle) return true;
      return [row.provider, row.model, row.passport_id, row.jti, row.agent_access_key_id, row.credential_use_id, row.status]
        .filter((value): value is string => typeof value === "string")
        .some((value) => value.toLowerCase().includes(needle));
    });
  }, [filter, query, rows]);

  const resume = () => {
    setRows((current) =>
      queuedRows.current.reduce(
        (next, row) => mergeDeparture(next, row, MAX_ROWS),
        current
      )
    );
    queuedRows.current = [];
    setQueued(0);
    setPaused(false);
  };

  return (
    <div className="pc-live-calls">
      <div className="pc-live-calls__bar">
        <div className="flex flex-wrap items-center gap-3">
          <span className="pc-live-calls__board-label">
            Departures
          </span>
          <span className="pc-live-calls__window">
            newest first · {zoneLabel} · up to {MAX_ROWS} rows
          </span>
        </div>
        <div className="pc-live-calls__signals">
          <span className="is-clear">{cleared} cleared</span>
          <span className="is-refused">{refused} refused</span>
          <span className={live ? "is-live" : "is-connecting"} role="status">
            {live ? <Radio aria-hidden="true" /> : <WifiOff aria-hidden="true" />}
            {live ? (paused ? `paused${queued ? ` · ${queued} new` : ""}` : "live") : "connecting"}
          </span>
        </div>
      </div>

      <div className="pc-live-calls__controls">
        <label className="pc-search-field">
          <Search aria-hidden="true" />
          <span className="sr-only">Filter live calls</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Agent identity, provider, model, status…"
          />
        </label>
        <div className="pc-segmented" aria-label="Call outcome filter">
          {(["all", "cleared", "refused"] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={filter === option}
              onClick={() => setFilter(option)}
            >
              {option === "all" ? "All" : option === "cleared" ? "Cleared" : "Refused"}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="ghost pc-live-calls__pause"
          onClick={() => (paused ? resume() : setPaused(true))}
          disabled={!live}
        >
          {paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
          {paused ? (queued ? `Resume · ${queued} new` : "Resume") : "Pause live"}
        </button>
      </div>

      <div className="pc-live-calls__table">
        <table>
          <caption className="sr-only">
            Calls handled by the gateway, newest first, with the verdict for each.
          </caption>
          <thead>
            <tr className="text-left font-bold uppercase tracking-[0.14em] text-amber-400/50 [&>th]:px-4 [&>th]:py-2 [&>th]:text-[0.65rem]">
              <th scope="col">Time</th>
              <th scope="col">Flight</th>
              <th scope="col">Destination</th>
              <th scope="col">Identity</th>
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
            {visibleRows.length === 0 ? (
              <tr>
                <td colSpan={7} className="pc-live-calls__empty">
                  {rows.length === 0
                    ? "No governed calls yet. Route a call through the gateway and it will appear here."
                    : "No loaded calls match these filters."}
                </td>
              </tr>
            ) : (
              visibleRows.map((row) => {
                const verdict = verdictFor(row.status);
                const refusedRow = verdict.tone === "denied";
                return (
                  <tr
                    key={row.id}
                    className={`pc-call-row ${
                      refusedRow ? "is-refused" : ""
                    } ${arrived.current.has(row.id) ? "pc-departure-new" : ""}`}
                    data-call-state={selected?.id === row.id ? "selected" : "idle"}
                    role="button"
                    tabIndex={0}
                    aria-label={`Open recorded call ${flightCode(row)}`}
                    onClick={() => setSelected(row)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelected(row);
                      }
                    }}
                  >
                    <td className="pc-live-calls__time">
                      {format(row.created_at, "time")}
                    </td>
                    <td className="pc-live-calls__flight">
                      {flightCode(row)}
                    </td>
                    <td className="pc-live-calls__destination">
                      {row.provider ?? "—"}
                      {row.model ? <span> / {row.model}</span> : null}
                    </td>
                    <td className="pc-live-calls__passport" title={row.passport_id ?? ""}>
                      {row.passport_id
                        ? `${row.passport_id.slice(0, 10)}…`
                        : row.auth_method === "direct_key"
                          ? `KEY ${row.agent_access_key_id?.slice(0, 8) ?? "recorded"}`
                          : "—"}
                    </td>
                    <td className="pc-live-calls__number">
                      {totalTokens(row) || "—"}
                    </td>
                    <td className="pc-live-calls__number">
                      {fare(row.cost_microcents)}
                    </td>
                    <td className={`pc-live-calls__verdict ${TONE_CLASS[verdict.tone]}`}>
                      {verdict.word}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <ol className="pc-live-calls__cards" aria-label="Calls handled by the gateway">
        {visibleRows.length === 0 ? (
          <li className="pc-live-calls__empty">
            {rows.length === 0
              ? "No governed calls yet. Route a call through the gateway and it will appear here."
              : "No loaded calls match these filters."}
          </li>
        ) : (
          visibleRows.map((row) => {
            const verdict = verdictFor(row.status);
            return (
              <li
                key={row.id}
                className={`pc-call-row ${verdict.tone === "denied" ? "is-refused" : ""}`}
                data-call-state={selected?.id === row.id ? "selected" : "idle"}
                role="button"
                tabIndex={0}
                onClick={() => setSelected(row)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setSelected(row);
                  }
                }}
              >
                <div>
                  <strong>{row.provider ?? "Unknown provider"}</strong>
                  <span>{row.model ?? "Model unavailable"}</span>
                </div>
                <span className={TONE_CLASS[verdict.tone]}>{verdict.word}</span>
                <dl>
                  <div><dt>{zoneLabel}</dt><dd>{format(row.created_at, "time")}</dd></div>
                  <div><dt>Identity</dt><dd>{row.passport_id ? row.passport_id.slice(0, 10) : row.auth_method === "direct_key" ? "Direct key" : "—"}</dd></div>
                  <div><dt>Tokens</dt><dd>{totalTokens(row) || "—"}</dd></div>
                  <div><dt>Cost</dt><dd>{fare(row.cost_microcents)}</dd></div>
                </dl>
              </li>
            );
          })
        )}
      </ol>
      <CallDetailDrawer
        row={selected}
        open={Boolean(selected)}
        onOpenChange={(open) => { if (!open) setSelected(null); }}
        currentShadowRevision={selected?.agent_id ? callContext.shadowRevisions[selected.agent_id] ?? null : null}
      />
    </div>
  );
}
