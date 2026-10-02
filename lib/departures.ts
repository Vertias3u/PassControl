// Pure presentation logic for the departures board.
//
// Split out of the component so it can be tested without a DOM renderer, and so
// the verdict vocabulary lives next to the other places that translate an audit
// status for a human — same reasoning that put the gate evaluator in lib/gate.ts.
import type { LogEntry } from "@/lib/log";
import type { AuthMethod } from "@/lib/log";
import { classifyCall, housekeepingLabel, isHousekeeping } from "@/lib/call-class";
import { describeUpstreamStatus, readRecordedUpstreamStatus } from "@/lib/verify/receipt-view";
import { callOutcome, isDeliberateRefusal, usageLabel, wasForwarded } from "@/lib/call-outcome";
import { serviceLabelFor, serviceUpstreamMeaning } from "@/lib/services/presentation";

export interface DepartureRow {
  id: string;
  agent_id?: string | null;
  user_id?: string | null;
  created_at: string | null;
  passport_id: string | null;
  jti: string | null;
  auth_method?: AuthMethod | null;
  agent_access_key_id?: string | null;
  credential_use_id?: string | null;
  provider: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_microcents: number | null;
  /**
   * What the BUDGET was charged, when that differs from what was observed.
   * Present only on a `usage_unknown` row: the observed figures there are not
   * an observation of zero, they are the absence of one, and the enforced pair
   * is the only number on the row that actually moved money. Optional because a
   * row written before migration 0055 has neither.
   */
  enforced_tokens?: number | null;
  enforced_microcents?: number | null;
  status: string | null;
  latency_ms?: number | null;
  receipt?: string | null;
  policy_shadow_would?: string | null;
  /** `service` for a call to a non-LLM API (0074); absent or null for an LLM call. */
  call_kind?: string | null;
  /** Service calls: METHOD + the matched rule's template. Null when no rule matched. */
  endpoint?: string | null;
}

export type DepartureTone = "clear" | "held" | "denied";

/**
 * Board vocabulary, as a Record over LogEntry["status"] so a new audit status
 * cannot ship without a word here. StatusPill uses the same guard for the same
 * reason: a call shown as the wrong kind of refusal sends an operator looking in
 * the wrong place. That guard has been defeated by a cast once already.
 */
export const DEPARTURE_VERDICT: Record<
  LogEntry["status"],
  { word: string; tone: DepartureTone }
> = {
  ok: { word: "CLEARED", tone: "clear" },
  // Not "DIVERTED": nothing was diverted anywhere. The call reached the
  // provider and the provider answered with an error — the board says so, and
  // the HTTP code beside it says which one.
  upstream_error: { word: "PROVIDER ERROR", tone: "held" },
  // The call went out and may well have been billed; what nobody can say is for
  // how much. NOT a variant of DIVERTED, which means the call failed — this one
  // arrived somewhere and left the accounting open.
  usage_unknown: { word: "UNCONFIRMED", tone: "held" },
  // PassControl's own spend counters for this agent were lost, so it refused
  // rather than guess a starting balance. Not NO FUNDS: the agent's money is
  // fine, the gateway's memory of it is not.
  blocked_budget_state: { word: "NO RECKONING", tone: "held" },
  // The attempt's single send could not be claimed, so nothing went out. Held
  // rather than failed: the reservation stays, because somewhere another
  // handler may be holding this attempt's permission.
  dispatch_unavailable: { word: "NOT CLEARED", tone: "held" },
  blocked_budget: { word: "NO FUNDS", tone: "held" },
  blocked_budget_period: { word: "LIMIT REACHED", tone: "held" },
  // Deliberately not a variant of NO FUNDS. That word means PassControl's own
  // budget stopped the call; this one means the call went out and the PROVIDER
  // said the account is empty. An operator who reads them as the same thing
  // raises a limit that was never the constraint.
  provider_exhausted: { word: "NO CREDIT", tone: "held" },
  // Not DIVERTED: nothing was ever forwarded. The gateway holds the call at the
  // gate because it has no credential to travel on.
  no_provider_key: { word: "NO KEY", tone: "held" },
  // Not NO KEY: the key is there. Not DIVERTED: nothing was forwarded. And not
  // NO ROUTE, which is blocked_endpoint below and means the requested path was
  // not permitted. Here the ADDRESS is what could not be read.
  endpoint_unavailable: { word: "NO ADDRESS", tone: "held" },
  // Not NO ADDRESS: that one could not READ the address. Here the read answered
  // and no address is stored with the key, so the fix is to set one.
  endpoint_required: { word: "UNADDRESSED", tone: "held" },
  // Not "ROTATED". Nothing was observed to rotate — the check itself did not run.
  credential_state_unavailable: { word: "UNCHECKED", tone: "held" },
  credential_changed: { word: "ROTATED", tone: "held" },
  blocked_unpriced_endpoint: { word: "NO PRICE", tone: "held" },
  blocked_unpriced_model: { word: "UNPRICED", tone: "held" },
  // Not "NO VISA": a Direct Agent Key call never presents a visa, and a visa
  // call that is refused HAD one. What both lacked was access to this model.
  blocked_scope: { word: "NOT ALLOWED", tone: "held" },
  blocked_endpoint: { word: "NO ROUTE", tone: "held" },
  blocked_policy: { word: "POLICY", tone: "held" },
  blocked_suspended: { word: "SUSPENDED", tone: "denied" },
  blocked_killed: { word: "KILL SWITCH", tone: "denied" },
};

/** An unrecognised status is shown as itself rather than mislabelled as a known one. */
export function verdictFor(status: string | null): { word: string; tone: DepartureTone } {
  const known = DEPARTURE_VERDICT[status as LogEntry["status"]];
  if (known) return known;
  return { word: (status ?? "UNKNOWN").toUpperCase(), tone: "held" };
}

// Fixed UTC, 24-hour. A locale-dependent time renders differently on the server
// and the client and warns on hydration — and a departures board is meant to
// read in one timezone anyway.
// `departureTime` lived here — a UTC-pinned `HH:mm:ss` formatter. It is gone
// rather than kept, because it had no callers left and a spare formatter beside
// the one that replaced it is how the next person picks the wrong one. Both the
// TIME column and the ×N tooltip now format through `useDashboardTime`, which
// honours the operator's UTC/LOCAL toggle and names the zone. Its old reason for
// existing — server and client must agree across hydration — is handled there
// instead: that provider renders UTC until it has mounted and read the stored
// preference, which is why the board flickers from UTC to local exactly once.

/**
 * The ×N badge's tooltip.
 *
 * Takes the formatter rather than choosing one. It used to call `departureTime`,
 * which is pinned to UTC, and then append a literal " UTC" — so with the board
 * switched to local time a row reading `05:44:14 EEST` carried a tooltip reading
 * `02:44:14 UTC` for that same row. The board's TIME column formats through
 * `useDashboardTime`, which honours the toggle AND already names the zone, so
 * the caller passes that in and this adds no zone of its own.
 *
 * A burst is never "×20 at 12:00:30" in general — the window chains member to
 * member, so a steady pinger folds a long stretch onto one line and the operator
 * needs the span. But when the members do share a second, "between X and X" is
 * a span with no width, which reads as a rendering fault rather than a fact.
 * So the degenerate case says one instant, and only the degenerate case.
 */
export function repeatBurstTitle(
  count: number,
  span: { from: string; to: string } | null,
  formatTime: (value: string) => string
): string {
  const kept = "every one is stored. Click to show them.";
  if (!span) return `${count} identical consecutive refusals, all stored. Click to show them.`;
  const from = formatTime(span.from);
  const to = formatTime(span.to);
  // Compared AFTER formatting: two instants inside the same displayed second are
  // one instant as far as this sentence is concerned, and printing them as a
  // range would be a distinction the reader cannot see.
  return from === to
    ? `${count} identical consecutive refusals at ${from} — ${kept}`
    : `${count} identical consecutive refusals between ${from} and ${to} — ${kept}`;
}

/**
 * Two letters from the provider plus four hex from the visa id: stable per call,
 * readable at a glance, and it reveals nothing the audit log does not already
 * show the owner of these rows.
 */
export function flightCode(row: Pick<DepartureRow, "provider" | "jti" | "credential_use_id">): string {
  const carrier = (row.provider ?? "??").slice(0, 2).toUpperCase();
  const number = (row.jti ?? row.credential_use_id ?? "")
    .replace(/[^0-9a-f]/gi, "")
    .slice(0, 4)
    .toUpperCase();
  return `${carrier} ${number || "----"}`;
}

/** Microcents to a dollar string. A free or unmetered call shows a dash, not $0.0000. */
export function fare(costMicrocents: number | null): string {
  const cents = (costMicrocents ?? 0) / 1e6;
  if (!Number.isFinite(cents) || cents <= 0) return "—";
  return `$${(cents / 100).toFixed(4)}`;
}

/** The exact durable budget arithmetic introduced by migration 0056. */
export function budgetChargeMicrocents(
  row: Pick<DepartureRow, "status" | "cost_microcents" | "enforced_microcents">
): number {
  if (row.status !== "ok" && row.status !== "usage_unknown") return 0;
  return Math.max(0, row.cost_microcents ?? 0, row.enforced_microcents ?? 0);
}

/** Token equivalent of budgetChargeMicrocents, from the same spend view. */
export function budgetChargeTokens(
  row: Pick<DepartureRow, "status" | "input_tokens" | "output_tokens" | "enforced_tokens">
): number {
  if (row.status !== "ok" && row.status !== "usage_unknown") return 0;
  return Math.max(
    0,
    (row.input_tokens ?? 0) + (row.output_tokens ?? 0),
    row.enforced_tokens ?? 0
  );
}

/** See lib/call-outcome.ts `usageLabel`; kept as the board's name for it. */
export function usageStatusLabel(
  row: Pick<DepartureRow, "status" | "enforced_tokens" | "enforced_microcents">
): string {
  return usageLabel(row);
}

export function totalTokens(row: Pick<DepartureRow, "input_tokens" | "output_tokens">): number {
  return (row.input_tokens ?? 0) + (row.output_tokens ?? 0);
}

/**
 * What the Destination column says.
 *
 * A model-listing row has no model, and rendering it as provider-plus-nothing
 * made a handshake look like a normal call whose model failed to record. Name
 * the thing instead: `housekeepingLabel` is the single source of that word, so
 * the board and the activation panel cannot drift apart about it.
 */
/**
 * The provider column. An LLM row keeps its stored id, as it always has; a
 * service row reads "GitHub" rather than the internal `svc:github`.
 */
export function departureProvider(
  row: Pick<DepartureRow, "status" | "model" | "provider"> & Partial<Pick<DepartureRow, "call_kind">>
): string | null {
  if (classifyCall(row).klass === "service") return serviceLabelFor(row.provider);
  return row.provider ?? null;
}

/** What the upstream's own status means for this row: GitHub's wording for a service call. */
export function upstreamMeaningFor(
  row: Pick<DepartureRow, "status" | "model" | "provider"> & Partial<Pick<DepartureRow, "call_kind">>,
  status: number
): string | null {
  if (classifyCall(row).klass === "service") return serviceUpstreamMeaning(status, row.provider);
  return describeUpstreamStatus(status);
}

export function departureDestination(
  row: Pick<DepartureRow, "status" | "model"> & Partial<Pick<DepartureRow, "provider" | "call_kind" | "endpoint">>
): string {
  const { klass, reason } = classifyCall(row);
  if (klass === "housekeeping" && reason) return housekeepingLabel(reason);
  // A service call has no model; the rule that admitted it is what it reached.
  // A scope refusal has no rule by definition, and says so rather than "—".
  if (klass === "service") {
    if (row.endpoint?.trim()) return row.endpoint.trim();
    return row.status === "blocked_scope" ? "no matching rule" : "service call";
  }
  return row.model?.trim() || "—";
}

/**
 * The counters above the table.
 *
 * `cleared` deliberately excludes housekeeping: it is the figure an operator
 * reads as "calls that got through", and a startup probe is not one. The
 * housekeeping count is returned alongside rather than dropped — the number is
 * disclosed on the board, it is just not folded into agent activity.
 */
export function departureCounts(rows: readonly DepartureRow[]): {
  cleared: number;
  refused: number;
  housekeeping: number;
} {
  let cleared = 0;
  let refused = 0;
  let housekeeping = 0;
  for (const row of rows) {
    if (isHousekeeping(row)) housekeeping += 1;
    else if (row.status === "ok") cleared += 1;
    // Deliberate refusals only. `startsWith("blocked")` also counted
    // blocked_budget_state — PassControl failing to read its own counters —
    // as a refusal the operator's rules made.
    if (isDeliberateRefusal(callOutcome(row.status).category)) refused += 1;
  }
  return { cleared, refused, housekeeping };
}

export interface DepartureView {
  filter: "all" | "cleared" | "refused";
  query: string;
  /** Off by default in the component: the board is an activity view first. */
  showHousekeeping: boolean;
}

/**
 * Rows to render, in board order.
 *
 * The class test runs BEFORE the outcome filter, and that order is the point. A
 * capability probe is `ok`, so "Cleared" would otherwise put every hidden
 * handshake straight back on the board the operator had just cleaned.
 */
export function visibleDepartures(
  rows: readonly DepartureRow[],
  view: DepartureView,
  /**
   * The workspace's CURRENT agent names, by id. Matching on them is what lets
   * an operator type the worker's name they see on the row. Resolved at
   * presentation: the stored row keeps only the id, and a renamed agent's old
   * calls match its new name.
   */
  agentNames: Readonly<Record<string, string>> = {}
): DepartureRow[] {
  const needle = view.query.trim().toLowerCase();
  return rows.filter((row) => {
    if (!view.showHousekeeping && isHousekeeping(row)) return false;
    const verdict = verdictFor(row.status);
    if (view.filter === "cleared" && verdict.tone !== "clear") return false;
    if (view.filter === "refused" && !isDeliberateRefusal(callOutcome(row.status).category)) return false;
    if (!needle) return true;
    return [
      row.agent_id ? agentNames[row.agent_id] : null,
      row.agent_id,
      row.provider,
      row.model,
      row.endpoint,
      row.passport_id,
      row.jti,
      row.agent_access_key_id,
      row.credential_use_id,
      row.status,
    ]
      .filter((value): value is string => typeof value === "string")
      .some((value) => value.toLowerCase().includes(needle));
  });
}

/**
 * ── Collapsing repeat bursts ───────────────────────────────────────────────
 *
 * A client that pings the gateway before, during and after every prompt writes
 * one refused row per ping. Every one of them is true, and twenty of them say
 * exactly what one of them says — while pushing the rows that *don't* repeat off
 * a 40-row board. So the board draws one line per burst and puts the count on
 * it. The record is untouched: `members` carries every original row, the
 * counters above the table still count rows, and the export still exports rows.
 *
 * Three rules keep this from hiding anything real:
 *
 *   1. **Only refusals collapse.** Two cleared calls are two pieces of work and
 *      two real charges; a repeat of *nothing* is the only thing a burst can be.
 *   2. **Only consecutive rows collapse**, and only within a short window. Two
 *      bursts an hour apart are two events, and folding them together would tell
 *      an operator a story about frequency the rows do not support.
 *   3. **The kind must match exactly** — agent, status, provider and model. A
 *      scope refusal beside an endpoint refusal are two different problems.
 *
 * A row with no timestamp is never folded in: it cannot be *shown* to belong to
 * the burst, and this collapses on evidence rather than on assumption.
 */
const BURST_WINDOW_MS = 120_000;

export interface DepartureGroup {
  /** The newest row in the burst — what the board draws and the drawer opens. */
  row: DepartureRow;
  /** How many rows this line stands for. 1 for an ordinary row. */
  count: number;
  /** Every original row, newest first. Nothing is discarded. */
  members: DepartureRow[];
}

/**
 * The time a burst covers, oldest→newest, or null when it is a single row.
 *
 * The window chains member-to-member, so a client pinging steadily can fold a
 * long stretch into one line. Drawing that line at the newest timestamp alone
 * would imply twenty things happened at one moment — the same class of error as
 * rendering an unverified claim as a fact. The span is what the rows support, so
 * the span is what the board offers.
 */
/**
 * A stable name for a burst, for UI state that must outlive its membership.
 *
 * NOT `group.row.id`. Rows arrive newest first, so the representative is the
 * NEWEST member and it changes the moment another call of the same kind lands
 * over realtime. Anything keyed on it — an expanded burst, most obviously —
 * loses its entry while the operator is looking at it.
 *
 * The oldest member is the fixed end: new arrivals are newer by construction,
 * so they extend the burst without renaming it.
 */
export function groupKey(group: DepartureGroup): string {
  return group.members[group.members.length - 1]?.id ?? group.row.id;
}

export function groupSpan(group: DepartureGroup): { from: string; to: string } | null {
  if (group.count < 2) return null;
  const oldest = group.members[group.members.length - 1]?.created_at;
  const newest = group.members[0]?.created_at;
  if (!oldest || !newest) return null;
  return { from: oldest, to: newest };
}

/**
 * The provider's HTTP status for a board line, or null.
 *
 * `DIVERTED` covered a 401, a 404 and a 429 alike, so an expired provider key
 * and a wrong model id read identically — the distinction that cost a whole
 * session on 2026-08-17. The code has always been on the receipt; this puts it
 * on the line.
 *
 * UNANIMOUS OR NOTHING, and that is the whole subtlety. `groupDepartures` folds
 * on agent+status+provider+model, which does not include the upstream code, so
 * one line can legitimately stand for rows that failed for different reasons.
 * Labelling it with the representative row's code would print a number that is
 * wrong for the other members — the same class of error as drawing a burst at a
 * single instant. A member that records nothing readable is a disagreement too:
 * a code covering only the rows we could decode is a guess about the rest.
 */
/**
 * The provider's own HTTP status for one row, or null.
 *
 * A receipt's `res.http` is the status PassControl RETURNED. It is the
 * provider's only when the call was forwarded; on a refusal it is PassControl's
 * own 403 or 402, and reporting it as "the provider answered" told an operator
 * that a provider (or GitHub) saw a call nobody sent.
 */
export function recordedUpstreamStatus(row: Pick<DepartureRow, "status" | "receipt">): number | null {
  if (!wasForwarded(callOutcome(row.status).category)) return null;
  return readRecordedUpstreamStatus(row.receipt);
}

export function groupUpstreamStatus(group: DepartureGroup): number | null {
  const lead = group.members[0];
  const first = lead ? recordedUpstreamStatus(lead) : null;
  if (first === null) return null;
  for (const member of group.members) {
    if (recordedUpstreamStatus(member) !== first) return null;
  }
  return first;
}

export function groupDepartures(
  rows: readonly DepartureRow[],
  windowMs: number = BURST_WINDOW_MS
): DepartureGroup[] {
  const groups: DepartureGroup[] = [];
  const kindOf = (r: DepartureRow) =>
    `${r.agent_id ?? ""}\x00${r.status ?? ""}\x00${r.provider ?? ""}\x00${r.model ?? ""}\x00${r.endpoint ?? ""}`;
  const timeOf = (r: DepartureRow) => {
    const parsed = r.created_at ? Date.parse(r.created_at) : NaN;
    return Number.isFinite(parsed) ? parsed : null;
  };

  for (const row of rows) {
    const previous = groups[groups.length - 1];
    const time = timeOf(row);
    const previousTime = previous ? timeOf(previous.members[previous.members.length - 1]!) : null;
    const collapsible =
      previous != null &&
      row.status !== "ok" &&
      time != null &&
      previousTime != null &&
      kindOf(previous.row) === kindOf(row) &&
      // Rows arrive newest first, so the previous member is the later one.
      Math.abs(previousTime - time) <= windowMs;

    if (collapsible) {
      previous.members.push(row);
      previous.count += 1;
    } else {
      groups.push({ row, count: 1, members: [row] });
    }
  }
  return groups;
}

/** Newest first, capped. Ignores a row already on the board (realtime can repeat). */
export function mergeDeparture(
  rows: readonly DepartureRow[],
  incoming: DepartureRow,
  max: number
): DepartureRow[] {
  if (!incoming?.id || rows.some((row) => row.id === incoming.id)) return [...rows];
  return [incoming, ...rows].slice(0, max);
}
