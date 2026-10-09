// How an agent's limits read to a person: the MCP `budget` tool and
// `passcontrol statusline`, both fed by the gateway's GET /api/v1/self.
//
// Money arrives as integer microcents (1 USD = 100,000,000). Unknown is "?" and
// never "$0.00"; no limit says so; a real amount under a cent is "<$0.01".

const MICROCENTS_PER_USD = 100_000_000;
const MICROCENTS_PER_CENT = 1_000_000;

/** Microcents as dollars, or "?" when the count could not be read. */
export function formatUsd(microcents) {
  if (microcents === null || microcents === undefined || !Number.isFinite(Number(microcents))) return "?";
  const value = Number(microcents);
  if (value > 0 && value < MICROCENTS_PER_CENT) return "<$0.01";
  const dollars = Math.round(value / MICROCENTS_PER_CENT) / 100;
  return `$${dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** A token count the way a status line has room for: 950, 12.3k, 1.2M. */
function formatTokens(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "?";
  const v = Number(n);
  if (v >= 1_000_000) return `${trim(v / 1_000_000)}M`;
  if (v >= 1_000) return `${trim(v / 1_000)}k`;
  return String(v);
}
const trim = (v) => (Math.round(v * 10) / 10).toString();

function resetsIn(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return null;
  if (s >= 86_400) return `${Math.round(s / 86_400)}d`;
  if (s >= 3_600) return `${Math.round(s / 3_600)}h`;
  return `${Math.max(1, Math.round(s / 60))}m`;
}

const PERIOD_WORD = { day: "today", month: "this month" };
const PERIOD_LABEL = { day: "Today", month: "This month" };

/** One line for Claude Code's status line. The most pressing limit wins. */
export function statusLine(self) {
  const b = self?.budget ?? {};
  const prefix = "PassControl · ";
  if (b.period && b.period.unknown) return `${prefix}limit unknown`;
  if (b.period) {
    return `${prefix}${formatUsd(b.period.used_microcents)} of ${formatUsd(b.period.limit_microcents)} ${PERIOD_WORD[b.period.kind] ?? ""}`.trimEnd();
  }
  if (b.cost) return `${prefix}${formatUsd(b.cost.used_microcents)} of ${formatUsd(b.cost.limit_microcents)} total`;
  if (b.tokens) return `${prefix}${formatTokens(b.tokens.used)} of ${formatTokens(b.tokens.limit)} tokens`;
  return `${prefix}no limit`;
}

/** Every limit, with what is left: the MCP tool's text answer. */
export function budgetLines(self) {
  const b = self?.budget ?? {};
  const lines = [];
  if (b.period && b.period.unknown) {
    lines.push("The periodic spending limit could not be read right now.");
  } else if (b.period) {
    const reset = resetsIn(b.period.resets_in_seconds);
    lines.push(
      `${PERIOD_LABEL[b.period.kind] ?? "This period"}: ${formatUsd(b.period.used_microcents)} of ${formatUsd(b.period.limit_microcents)} used, ` +
        `${formatUsd(b.period.remaining_microcents)} left${reset ? ` (resets in ${reset})` : ""}.`
    );
  }
  if (b.cost) {
    lines.push(
      `Lifetime: ${formatUsd(b.cost.used_microcents)} of ${formatUsd(b.cost.limit_microcents)} used, ${formatUsd(b.cost.remaining_microcents)} left.`
    );
  }
  if (b.tokens) {
    lines.push(`Tokens: ${formatTokens(b.tokens.used)} of ${formatTokens(b.tokens.limit)} used, ${formatTokens(b.tokens.remaining)} left.`);
  }
  if (lines.length === 0) lines.push("No spending or token limit is set for this agent.");
  return lines;
}
