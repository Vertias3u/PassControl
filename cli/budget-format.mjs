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
export function formatTokens(n) {
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

/** "at 16:00" within a day, "Sat 12:00" within a week, "on 1 Nov" past that, in local time. */
export function when(ms, nowMs, timeZone) {
  const d = new Date(ms);
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone });
  if (ms - nowMs < 86_400_000) return `at ${time}`;
  if (ms - nowMs < 7 * 86_400_000) return `${d.toLocaleDateString("en-GB", { weekday: "short", timeZone })} ${time}`;
  return `on ${d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone })}`;
}

// The pace (GET /api/v1/self, 1.6.0): when the first limit runs out at the current rate.
const PACE_NAME = { cost: "the total budget", tokens: "the token limit" };
function paceOf(self, { nowMs = Date.now(), timeZone } = {}) {
  const pace = self?.pace;
  if (!pace || typeof pace !== "object" || !["period", "cost", "tokens"].includes(pace.limit)) return null;
  const kind = self?.budget?.period?.kind;
  const name = pace.limit === "period" ? `${kind === "month" ? "this month's" : "today's"} limit` : PACE_NAME[pace.limit];
  const at = pace.reaches_limit_at ? Date.parse(pace.reaches_limit_at) : NaN;
  if (Number.isFinite(at)) return { limit: pace.limit, name, runsOut: when(at, nowMs, timeZone) };
  if (pace.reaches_limit_at === null) return { limit: pace.limit, name, runsOut: null };
  return null;
}
// The soft pause (GET /api/v1/self `pause`, 1.6.0): while the agent is paused every
// call is refused, so the pause replaces the pace wherever both would be said.

/** Whether /self says the gateway is refusing this agent's calls for its pause line. */
export function paused(self) {
  return self?.pause?.paused === true && Number.isFinite(Number(self.pause.percent));
}

/** The lift's end as `when` says it, or null with no readable lift. */
function liftedUntil(self, { nowMs = Date.now(), timeZone } = {}) {
  const at = self?.pause?.lifted_until ? Date.parse(self.pause.lifted_until) : NaN;
  return Number.isFinite(at) && !paused(self) ? when(at, nowMs, timeZone).replace(/^at /, "") : null;
}

// L7 (0088): the owner's cheaper model at the line, when /self names one. Printed
// in a terminal and an agent's context, so only a plain printable name is used.
const printable = (v) => typeof v === "string" && /^[\x20-\x7e]{1,200}$/u.test(v);
function switchOf(self) {
  const s = self?.pause?.switch_to;
  return s && printable(s.provider) && printable(s.model) ? { provider: s.provider, model: s.model, active: s.active === true } : null;
}

const pausePercent = (self) => {
  const p = Number(self?.pause?.percent);
  return Number.isInteger(p) && p >= 1 && p <= 99 ? p : null;
};

const paceSentence = (p) =>
  p.runsOut ? `${p.name} runs out ${p.runsOut}` : `${p.name} ${p.limit === "period" ? "lasts until it resets" : "is not running out"}`;

/**
 * One line for Claude Code's status line. The most pressing limit wins, and when the
 * pace says that limit runs out, when.
 */
export function statusLine(self, opts = {}) {
  const b = self?.budget ?? {};
  const prefix = "PassControl · ";
  if (b.period && b.period.unknown) return `${prefix}limit unknown`;
  const pace = paused(self) ? null : paceOf(self, opts);
  const runsOut = (kind) => (pace?.limit === kind && pace.runsOut ? ` · runs out ${pace.runsOut}` : "");
  const sw = switchOf(self);
  const line = pausePercent(self);
  const head = paused(self)
    ? `${prefix}paused at its ${self.pause.percent}% line · `
    : sw?.active && line !== null
      ? `${prefix}on ${sw.model} past its ${line}% line · `
      : prefix;
  if (b.period) {
    return `${head}${formatUsd(b.period.used_microcents)} of ${formatUsd(b.period.limit_microcents)} ${PERIOD_WORD[b.period.kind] ?? ""}`.trimEnd() + runsOut("period");
  }
  if (b.cost) return `${head}${formatUsd(b.cost.used_microcents)} of ${formatUsd(b.cost.limit_microcents)} total${runsOut("cost")}`;
  if (b.tokens) return `${head}${formatTokens(b.tokens.used)} of ${formatTokens(b.tokens.limit)} tokens${runsOut("tokens")}`;
  return `${prefix}no limit`;
}

/** Every limit, with what is left: the MCP tool's text answer. */
export function budgetLines(self, opts = {}) {
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
  const line = pausePercent(self);
  const lifted = liftedUntil(self, opts);
  if (paused(self)) {
    lines.push(`PassControl has paused this agent at its ${line}% line: it refuses model calls until the owner lets it go on from the agent's page.`);
    return lines;
  }
  const sw = switchOf(self);
  if (line !== null && sw?.active) {
    lines.push(
      `Past its ${line}% line, PassControl sends this agent's ${sw.provider} calls to ${sw.model} instead of the model asked for; calls to any other provider are paused.`
    );
  } else if (line !== null && lifted) lines.push(`Its owner let it go on past its ${line}% pause line until ${lifted}.`);
  else if (line !== null && !self.pause.limit && sw) {
    lines.push(`At ${line}% of any limit, PassControl switches this agent's ${sw.provider} calls to ${sw.model} instead of pausing them.`);
  } else if (line !== null && !self.pause.limit) lines.push(`PassControl pauses it at ${line}% of any limit, before the limit itself is reached.`);
  const pace = paceOf(self, opts);
  if (pace) lines.push(`At this rate, ${paceSentence(pace)}.`);
  return lines;
}

/**
 * Every limit as a [label, value] row, for the `/passcontrol` panel in Claude Code
 * (`passcontrol statusline --panel`): "Today", "$0.42 of $10.00 · $9.58 left · resets in 7h".
 */
export function panelRows(self, opts = {}) {
  const b = self?.budget ?? {};
  const rows = [];
  if (b.period && b.period.unknown) {
    rows.push(["Limit", "could not be read right now"]);
  } else if (b.period) {
    const reset = resetsIn(b.period.resets_in_seconds);
    rows.push([
      PERIOD_LABEL[b.period.kind] ?? "This period",
      `${formatUsd(b.period.used_microcents)} of ${formatUsd(b.period.limit_microcents)} · ${formatUsd(b.period.remaining_microcents)} left${reset ? ` · resets in ${reset}` : ""}`,
    ]);
  }
  if (b.cost) {
    rows.push(["Lifetime", `${formatUsd(b.cost.used_microcents)} of ${formatUsd(b.cost.limit_microcents)} · ${formatUsd(b.cost.remaining_microcents)} left`]);
  }
  if (b.tokens) {
    rows.push(["Tokens", `${formatTokens(b.tokens.used)} of ${formatTokens(b.tokens.limit)} · ${formatTokens(b.tokens.remaining)} left`]);
  }
  if (rows.length === 0) rows.push(["Limit", "none set"]);
  const line = pausePercent(self);
  const lifted = liftedUntil(self, opts);
  if (paused(self)) {
    rows.push(["Paused", `at its ${line}% line · the owner can let it go on from the agent's page`]);
    return rows;
  }
  const sw = switchOf(self);
  if (line !== null && sw?.active) rows.push(["Switched", `to ${sw.model} past its ${line}% line · other providers paused`]);
  else if (line !== null && lifted) rows.push(["Pause", `lifted until ${lifted} · line at ${line}%`]);
  else if (line !== null && !self.pause.limit && sw) rows.push(["Pause", `at ${line}% of any limit · switches ${sw.provider} to ${sw.model}`]);
  else if (line !== null && !self.pause.limit) rows.push(["Pause", `at ${line}% of any limit`]);
  const pace = paceOf(self, opts);
  if (pace) rows.push(["Pace", paceSentence(pace)]);
  return rows;
}

/** Whether a limit has nothing left, so the gateway refuses calls until it resets or is raised. */
export function limitReached(self) {
  const b = self?.budget ?? {};
  const spent = (left) => left !== null && left !== undefined && Number.isFinite(Number(left)) && Number(left) <= 0;
  return Boolean(
    (b.period && !b.period.unknown && spent(b.period.remaining_microcents)) ||
      (b.cost && spent(b.cost.remaining_microcents)) ||
      (b.tokens && spent(b.tokens.remaining))
  );
}
