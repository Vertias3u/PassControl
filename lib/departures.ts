// Pure presentation logic for the departures board.
//
// Split out of the component so it can be tested without a DOM renderer, and so
// the verdict vocabulary lives next to the other places that translate an audit
// status for a human — same reasoning that put the gate evaluator in lib/gate.ts.
import type { LogEntry } from "@/lib/log";

export interface DepartureRow {
  id: string;
  agent_id?: string | null;
  user_id?: string | null;
  created_at: string | null;
  passport_id: string | null;
  jti: string | null;
  auth_method?: "passport" | "direct_key" | null;
  agent_access_key_id?: string | null;
  credential_use_id?: string | null;
  provider: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_microcents: number | null;
  status: string | null;
  latency_ms?: number | null;
  receipt?: string | null;
  policy_shadow_would?: string | null;
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
  upstream_error: { word: "DIVERTED", tone: "held" },
  blocked_budget: { word: "NO FUNDS", tone: "held" },
  // Deliberately not a variant of NO FUNDS. That word means PassControl's own
  // budget stopped the call; this one means the call went out and the PROVIDER
  // said the account is empty. An operator who reads them as the same thing
  // raises a limit that was never the constraint.
  provider_exhausted: { word: "NO CREDIT", tone: "held" },
  // Not DIVERTED: nothing was ever forwarded. The gateway holds the call at the
  // gate because it has no credential to travel on.
  no_provider_key: { word: "NO KEY", tone: "held" },
  blocked_scope: { word: "NO VISA", tone: "held" },
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
const TIME = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZone: "UTC",
});

export function departureTime(value: string | null): string {
  if (!value) return "--:--:--";
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? TIME.format(new Date(parsed)) : "--:--:--";
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

export function totalTokens(row: Pick<DepartureRow, "input_tokens" | "output_tokens">): number {
  return (row.input_tokens ?? 0) + (row.output_tokens ?? 0);
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
