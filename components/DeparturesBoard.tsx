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
import { ChevronDown, Pause, Play, Search, Radio, WifiOff } from "lucide-react";
import { browserClient } from "@/lib/supabase/client";
import {
  budgetChargeMicrocents,
  departureCounts,
  departureDestination,
  groupDepartures,
  groupKey,
  groupSpan,
  groupUpstreamStatus,
  repeatBurstTitle,
  fare,
  flightCode,
  mergeDeparture,
  totalTokens,
  usageStatusLabel,
  verdictFor,
  visibleDepartures,
  type DepartureRow,
  type DepartureTone,
} from "@/lib/departures";
import { isHousekeeping } from "@/lib/call-class";
import { describeUpstreamStatus } from "@/lib/verify/receipt-view";
import { CallDetailDrawer, type CallContext } from "@/components/dashboard/CallDetailDrawer";
import { useDashboardTime } from "@/components/dashboard/DashboardTime";

export type { DepartureRow };

const MAX_ROWS = 40;
const PAGE_ROWS = 40;
const DEPARTURE_COLUMNS = "id, agent_id, user_id, created_at, passport_id, jti, auth_method, agent_access_key_id, credential_use_id, provider, model, input_tokens, output_tokens, cost_microcents, enforced_tokens, enforced_microcents, status, latency_ms, receipt, policy_shadow_would";

const TONE_CLASS: Record<DepartureTone, string> = {
  clear: "text-emerald-400",
  held: "text-amber-400",
  denied: "text-red-400",
};

export function DeparturesBoard({
  userId,
  initialRows,
  callContext,
  logsAvailable,
}: {
  userId: string;
  initialRows: DepartureRow[];
  callContext: CallContext;
  /**
   * Whether the initial window was actually read. REQUIRED — a default would
   * let a caller publish an empty board as a fact about the workspace.
   *
   * This board also SUBSCRIBES, so the flag has to outlive the empty state it
   * starts in: once a realtime row lands, `rows.length === 0` stops being true
   * while the missing history is exactly as missing as it was. A board showing
   * one call because one call happened to arrive after the failure is a more
   * convincing lie than the empty one it replaced.
   */
  logsAvailable: boolean;
}) {
  const [rows, setRows] = useState<DepartureRow[]>(() => initialRows.slice(0, MAX_ROWS));
  const [hasOlder, setHasOlder] = useState(logsAvailable && initialRows.length >= MAX_ROWS);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [paused, setPaused] = useState(false);
  const [queued, setQueued] = useState(0);
  const [filter, setFilter] = useState<"all" | "cleared" | "refused">("all");
  // Off by default: the board answers "what are my agents doing", and an SDK
  // listing models on startup is not that. The rows are still here, still
  // counted in the signal bar, and one click away — hidden, never discarded.
  const [showHousekeeping, setShowHousekeeping] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<DepartureRow | null>(null);
  // Representative ids of bursts the operator has opened. Expanding puts every
  // member back on the board as its own row, so the ×N badge is a way IN to the
  // rows rather than a wall in front of them.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const { format, zoneLabel } = useDashboardTime();
  // Formatted through the same hook as the TIME column, so the tooltip follows
  // the UTC/LOCAL toggle instead of asserting its own zone. `format(_, "time")`
  // already names the zone, so nothing appends one.
  const repeatTitle = (count: number, span: { from: string; to: string } | null) =>
    repeatBurstTitle(count, span, (value) => format(value, "time"));
  const pausedRef = useRef(false);
  const queuedRows = useRef<DepartureRow[]>([]);
  // Rows that arrived after mount, so only genuinely new ones animate. Without
  // this the whole board flaps on first paint and the movement means nothing.
  const arrived = useRef<Set<string>>(new Set());
  const historyLoaded = useRef(false);

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
          setRows((prev) => mergeDeparture(
            prev,
            row,
            historyLoaded.current ? Number.MAX_SAFE_INTEGER : MAX_ROWS
          ));
        }
      )
      .subscribe((status) => setLive(status === "SUBSCRIBED"));

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId]);

  const { cleared, refused, housekeeping } = useMemo(() => departureCounts(rows), [rows]);

  const visibleRows = useMemo(
    () => visibleDepartures(rows, { filter, query, showHousekeeping }),
    [filter, query, rows, showHousekeeping]
  );
  // Group AFTER filtering: a hidden probe between two refusals must not split a
  // burst that the operator sees as continuous.
  const visibleGroups = useMemo(() => {
    const grouped = groupDepartures(visibleRows);
    // An expanded burst becomes its members again, in place.
    return grouped.flatMap((group) =>
      group.count > 1 && expanded.has(groupKey(group))
        ? group.members.map((member) => ({ row: member, count: 1, members: [member] }))
        : [group]
    );
  }, [visibleRows, expanded]);

  const toggleGroup = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  // "Nothing matches" would be misleading when the only rows loaded are hidden
  // handshakes: the operator would go looking for calls that are right there.
  const emptyReason =
    housekeeping === rows.length && !showHousekeeping
      ? `Only SDK housekeeping has arrived — ${housekeeping} capability probe${housekeeping === 1 ? "" : "s"}, recorded but not counted as agent activity. Show them above.`
      : "No loaded calls match these filters.";
  const unavailableCopy =
    "The call history could not be read, so this window is unavailable. Any rows below arrived since this page loaded and are not the full picture.";

  const resume = () => {
    setRows((current) =>
      queuedRows.current.reduce(
        (next, row) => mergeDeparture(
          next,
          row,
          historyLoaded.current ? Number.MAX_SAFE_INTEGER : MAX_ROWS
        ),
        current
      )
    );
    queuedRows.current = [];
    setQueued(0);
    setPaused(false);
  };

  const loadOlder = async () => {
    const cursor = rows.at(-1);
    if (!cursor?.created_at || !cursor.id || loadingOlder) return;
    setLoadingOlder(true);
    setOlderError(null);
    try {
      const db = browserClient();
      const { data, error } = await db
        .from("agent_logs")
        .select(DEPARTURE_COLUMNS)
        .eq("user_id", userId)
        .or(`created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(PAGE_ROWS + 1);
      if (error) throw error;
      const page = (data ?? []).slice(0, PAGE_ROWS) as unknown as DepartureRow[];
      historyLoaded.current = true;
      setRows((current) => {
        const known = new Set(current.map((row) => row.id));
        return [...current, ...page.filter((row) => row.id && !known.has(row.id))];
      });
      setHasOlder((data?.length ?? 0) > PAGE_ROWS);
    } catch {
      setOlderError("Older calls could not be loaded. The rows already shown are unchanged.");
    } finally {
      setLoadingOlder(false);
    }
  };

  return (
    <div className="pc-live-calls">
      <div className="pc-live-calls__bar">
        <div className="flex flex-wrap items-center gap-3">
          <span className="pc-live-calls__board-label">
            Departures
          </span>
          <span className="pc-live-calls__window">
            newest first · {zoneLabel} · {rows.length} loaded
          </span>
        </div>
        <div className="pc-live-calls__signals">
          {/* "since load" is not decoration. With the initial read failed these
              two numbers count only what realtime has delivered, and "0 refused"
              on its own is a measurement nobody took. */}
          <span className="is-clear">{cleared} cleared{logsAvailable ? "" : " since load"}</span>
          <span className="is-refused">{refused} refused{logsAvailable ? "" : " since load"}</span>
          {housekeeping ? (
            <span className="is-housekeeping" data-board-signal="housekeeping">
              {housekeeping} SDK probe{housekeeping === 1 ? "" : "s"}
            </span>
          ) : null}
          <span className={live ? "is-live" : "is-connecting"} role="status">
            {live ? <Radio aria-hidden="true" /> : <WifiOff aria-hidden="true" />}
            {live ? (paused ? `paused${queued ? ` · ${queued} new` : ""}` : "live") : "connecting"}
          </span>
        </div>
      </div>

      {logsAvailable ? null : (
        // Above the table and outside the empty branch on purpose: the empty
        // branch stops rendering the moment one realtime row arrives, and that
        // is precisely when a partial board is most convincing.
        <p className="pc-live-calls__unavailable" data-state="unavailable" role="status">
          {unavailableCopy}
        </p>
      )}

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
          className="ghost pc-live-calls__housekeeping"
          aria-pressed={showHousekeeping}
          data-showing={showHousekeeping ? "shown" : "hidden"}
          onClick={() => setShowHousekeeping((shown) => !shown)}
          title="Model-listing calls an SDK makes on startup. Recorded in full either way."
        >
          {showHousekeeping ? "Hide" : "Show"} SDK probes
          {housekeeping ? ` · ${housekeeping}` : ""}
        </button>
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
                Observed cost
              </th>
              <th scope="col" className="text-right">Budget charge</th>
              <th scope="col">Usage status</th>
              <th scope="col">Outcome</th>
            </tr>
          </thead>
          <tbody>
            {visibleGroups.length === 0 ? (
              <tr>
                <td
                  colSpan={9}
                  className="pc-live-calls__empty"
                  data-state={logsAvailable ? undefined : "unavailable"}
                >
                  {!logsAvailable
                    ? unavailableCopy
                    : rows.length === 0
                      ? "No governed calls yet. Route a call through the gateway and it will appear here."
                      : emptyReason}
                </td>
              </tr>
            ) : (
              visibleGroups.map((group) => {
                const { row, count } = group;
                const span = groupSpan(group);
                const verdict = verdictFor(row.status);
                const upstreamStatus = groupUpstreamStatus(group);
                const refusedRow = verdict.tone === "denied";
                return (
                  <tr
                    key={row.id}
                    className={`pc-call-row ${
                      refusedRow ? "is-refused" : ""
                    } ${arrived.current.has(row.id) ? "pc-departure-new" : ""}`}
                    data-call-state={selected?.id === row.id ? "selected" : "idle"}
                    data-call-class={isHousekeeping(row) ? "housekeeping" : "inference"}
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
                      <span> / {departureDestination(row)}</span>
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
                    <td className="pc-live-calls__number">
                      {fare(budgetChargeMicrocents(row))}
                    </td>
                    <td className="pc-live-calls__usage" data-state={row.status === "usage_unknown" ? "unconfirmed" : undefined}>
                      {usageStatusLabel(row)}
                    </td>
                    <td className={`pc-live-calls__verdict ${TONE_CLASS[verdict.tone]}`}>
                      {verdict.word}
                      {/* The provider's own status, when every row behind this
                          line agrees on it. DIVERTED alone could not separate an
                          expired provider key from a wrong model id. */}
                      {upstreamStatus !== null ? (
                        <span
                          className="pc-live-calls__upstream"
                          title={describeUpstreamStatus(upstreamStatus) ?? `The provider returned HTTP ${upstreamStatus}.`}
                        >
                          {upstreamStatus}
                        </span>
                      ) : null}
                      {count > 1 ? (
                        <button
                          type="button"
                          className="pc-live-calls__repeat"
                          title={repeatTitle(count, span)}
                          aria-label={`Show the ${count} calls in this burst`}
                          onClick={(event) => {
                            event.stopPropagation();
                            toggleGroup(groupKey(group));
                          }}
                        >
                          ×{count}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <ol className="pc-live-calls__cards" aria-label="Calls handled by the gateway">
        {visibleGroups.length === 0 ? (
          <li className="pc-live-calls__empty" data-state={logsAvailable ? undefined : "unavailable"}>
            {!logsAvailable
              ? unavailableCopy
              : rows.length === 0
                ? "No governed calls yet. Route a call through the gateway and it will appear here."
                : emptyReason}
          </li>
        ) : (
          visibleGroups.map((group) => {
            const { row, count } = group;
            const span = groupSpan(group);
            const verdict = verdictFor(row.status);
            const upstreamStatus = groupUpstreamStatus(group);
            return (
              <li
                key={row.id}
                className={`pc-call-row ${verdict.tone === "denied" ? "is-refused" : ""}`}
                data-call-state={selected?.id === row.id ? "selected" : "idle"}
                data-call-class={isHousekeeping(row) ? "housekeeping" : "inference"}
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
                  <span>{departureDestination(row)}</span>
                </div>
                <span className={TONE_CLASS[verdict.tone]}>
                  {verdict.word}
                  {upstreamStatus !== null ? (
                    <span
                      className="pc-live-calls__upstream"
                      title={describeUpstreamStatus(upstreamStatus) ?? `The provider returned HTTP ${upstreamStatus}.`}
                    >
                      {upstreamStatus}
                    </span>
                  ) : null}
                  {count > 1 ? (
                    <button
                      type="button"
                      className="pc-live-calls__repeat"
                      title={repeatTitle(count, span)}
                      aria-label={`Show the ${count} calls in this burst`}
                      onClick={(event) => { event.stopPropagation(); toggleGroup(groupKey(group)); }}
                    >
                      ×{count}
                    </button>
                  ) : null}
                </span>
                <dl>
                  <div><dt>{zoneLabel}</dt><dd>{format(row.created_at, "time")}</dd></div>
                  <div><dt>Identity</dt><dd>{row.passport_id ? row.passport_id.slice(0, 10) : row.auth_method === "direct_key" ? "Direct key" : "—"}</dd></div>
                  <div><dt>Tokens</dt><dd>{totalTokens(row) || "—"}</dd></div>
                  <div><dt>Observed cost</dt><dd>{fare(row.cost_microcents)}</dd></div>
                  <div><dt>Budget charge</dt><dd>{fare(budgetChargeMicrocents(row))}</dd></div>
                  <div><dt>Usage status</dt><dd>{usageStatusLabel(row)}</dd></div>
                </dl>
              </li>
            );
          })
        )}
      </ol>
      {olderError ? <p className="pc-live-calls__pagination-error" role="status">{olderError}</p> : null}
      {hasOlder ? (
        <div className="pc-live-calls__pagination">
          <button type="button" className="ghost" onClick={loadOlder} disabled={loadingOlder || !logsAvailable}>
            <ChevronDown aria-hidden="true" />
            {loadingOlder ? "Loading older calls…" : "Load older calls"}
          </button>
          <span>Loads the next {PAGE_ROWS} durable rows; adjustments remain in the ledger summary above.</span>
        </div>
      ) : null}
      <CallDetailDrawer
        row={selected}
        open={Boolean(selected)}
        onOpenChange={(open) => { if (!open) setSelected(null); }}
        currentShadowRevision={selected?.agent_id ? callContext.shadowRevisions[selected.agent_id] ?? null : null}
      />
    </div>
  );
}
