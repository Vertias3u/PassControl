// The agent's own note (1.6.0): what Claude Code is told about its PassControl limits
// when a prompt is sent. Opt-in (`configure claude-code --agent-note`), off by default.
//
// The sidecar's prompt hook returns it as `additionalContext`, and only when its
// signature changes: the limit crossing a band (25/50/75/90 %, used up), the reset
// coming within the hour, the pace turning to reach the limit before the reset or
// away from it, the tool rules changing. So it costs the session almost no context.
//
// Two setups, two notes, because they are different facts:
//   * "api": Claude Code's calls go through the sidecar, so the budget is the one the
//     gateway enforces on them, and how much is left and when it runs out at this
//     rate (`pace`, from GET /api/v1/self) lets the agent plan before it is refused.
//     Tool rules are left out: nothing in this setup enforces them.
//   * "subscription": the calls go to Anthropic directly and never count against the
//     budget (migration 0084), so the note leads with the tool rules, which do apply,
//     and names any budget for what it covers.
import { formatTokens, formatUsd, when } from "./budget-format.mjs";

const BANDS = [0.25, 0.5, 0.75, 0.9, 1];
const MAX_RULES = 6;
const MAX_PATTERN = 60;
const EFFECT_TEXT = { deny: "is refused", ask_owner: "waits for the owner's approval", ask: "asks in the terminal" };
const PERIOD_WORD = { day: "today", month: "this month" };

const num = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));

/** The limit the note speaks about: the period's, else the overall cost, else tokens. */
function bindingLimit(budget) {
  if (!budget || typeof budget !== "object") return null;
  const p = budget.period;
  if (p && !p.unknown) {
    const used = num(p.used_microcents);
    const limit = num(p.limit_microcents);
    if (used === null || !limit) return null;
    return { kind: "period", period: p.kind, used, limit, left: Math.max(0, limit - used), resetsIn: num(p.resets_in_seconds) };
  }
  if (p?.unknown) return null;
  if (budget.cost) {
    const used = num(budget.cost.used_microcents);
    const limit = num(budget.cost.limit_microcents);
    if (used === null || !limit) return null;
    return { kind: "cost", used, limit, left: Math.max(0, limit - used) };
  }
  if (budget.tokens) {
    const used = num(budget.tokens.used);
    const limit = num(budget.tokens.limit);
    if (used === null || !limit) return null;
    return { kind: "tokens", used, limit, left: Math.max(0, limit - used) };
  }
  return null;
}

function band(limit) {
  const f = limit.used / limit.limit;
  const i = BANDS.findIndex((b) => f < b);
  return i === -1 ? BANDS.length : i;
}

function amounts(limit) {
  if (limit.kind === "tokens") return `${formatTokens(limit.left)} of ${formatTokens(limit.limit)} tokens left`;
  const where = limit.kind === "period" ? PERIOD_WORD[limit.period] ?? "this period" : "in total";
  return `${formatUsd(limit.left)} of ${formatUsd(limit.limit)} left ${where}`;
}

function resetAt(limit, nowMs, timeZone) {
  return limit.kind === "period" && limit.resetsIn ? when(nowMs + limit.resetsIn * 1000, nowMs, timeZone) : null;
}

function apiBudgetText(limit, pace, pause, nowMs, timeZone) {
  const reset = resetAt(limit, nowMs, timeZone);
  if (limit.used >= limit.limit) {
    const what = limit.kind === "period" ? `the budget for ${PERIOD_WORD[limit.period] ?? "this period"}` : "the total budget";
    return `${what} is used up; PassControl refuses model calls until ${reset ? `it resets ${reset}` : "the owner raises it"}.`;
  }
  let text = `${amounts(limit)}${reset ? `; it resets ${reset}` : ""}.`;
  // The soft pause (1.6.0, L4c): while paused every call is refused, so no pace.
  if (pause.state === "paused") {
    return `${text} PassControl has paused this agent at its ${pause.percent}% line and refuses its model calls until the owner lets it go on.`;
  }
  if (pause.state === "lifted") text += ` Its owner let it go on past its ${pause.percent}% pause line until ${pause.until}.`;
  if (pause.state === "switched") {
    text += ` Past its ${pause.percent}% line, PassControl sends its ${pause.provider} calls to ${pause.model} instead of the model it asks for; calls to any other provider are paused.`;
  }
  if (pace && typeof pace === "object") {
    const at = pace.reaches_limit_at ? Date.parse(pace.reaches_limit_at) : null;
    if (at !== null && Number.isFinite(at)) text += ` At this rate it runs out ${when(at, nowMs, timeZone)}.`;
    else if (pace.reaches_limit_at === null) text += limit.kind === "period" ? " At this rate it lasts until the reset." : " At this rate it is not running out.";
  }
  return text;
}

function subscriptionBudgetText(limit, pause) {
  if (limit.used < limit.limit && pause.state === "switched") {
    return `calls made through PassControl (not this Claude plan) to ${pause.provider} go to ${pause.model} past this agent's ${pause.percent}% line.`;
  }
  if (limit.used < limit.limit && pause.state === "paused") {
    return `calls made through PassControl (not this Claude plan) are paused at this agent's ${pause.percent}% line until the owner lets them go on.`;
  }
  if (limit.used >= limit.limit) {
    return `calls made through PassControl (not this Claude plan) have used up their budget${limit.kind === "period" ? ` for ${PERIOD_WORD[limit.period] ?? "this period"}` : ""}.`;
  }
  return `calls made through PassControl (not this Claude plan) have ${amounts(limit)}.`;
}

function ruleList(rules) {
  if (!rules || rules.state !== "ok" || !Array.isArray(rules.document?.rules)) return null;
  const list = rules.document.rules.filter((r) => r && typeof r.tool === "string" && EFFECT_TEXT[r.effect]);
  return list.length ? list : null;
}

function rulesText(list) {
  const shown = list.slice(0, MAX_RULES).map((r) => {
    const raw = [r.command, r.path, r.domain].find((v) => typeof v === "string" && v.length);
    const pattern = raw ? ` \`${raw.length > MAX_PATTERN ? `${raw.slice(0, MAX_PATTERN)}…` : raw}\`` : "";
    return `${r.tool}${pattern} ${EFFECT_TEXT[r.effect]}`;
  });
  const more = list.length - shown.length;
  return `this agent's tool rules are ${shown.join("; ")}${more > 0 ? `; and ${more} more` : ""}. They are set on the agent's page.`;
}

const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** The pause from GET /api/v1/self, as the note needs it: paused, switched (to what), lifted (until when), or neither. */
function pauseOf(self, nowMs, timeZone) {
  const p = self?.pause;
  const percent = Number(p?.percent);
  if (!p || typeof p !== "object" || !Number.isInteger(percent)) return { state: "" };
  if (p.paused === true) return { state: "paused", percent };
  // L7 (0088): on the owner's cheaper model past the line. Printed into the agent's
  // context, so only plain printable names are used.
  const sw = p.switch_to;
  const plain = (v) => typeof v === "string" && /^[\x20-\x7e]{1,200}$/u.test(v);
  if (sw && sw.active === true && plain(sw.provider) && plain(sw.model)) return { state: "switched", percent, provider: sw.provider, model: sw.model };
  const end = p.lifted_until ? Date.parse(p.lifted_until) : NaN;
  if (Number.isFinite(end)) return { state: "lifted", percent, until: when(end, nowMs, timeZone).replace(/^at /, "") };
  return { state: "" };
}

/**
 * The note for one prompt, or null when there is nothing to say.
 * @param {{ self: object | null, rules: object | null, mode: "api" | "subscription", nowMs: number, timeZone?: string }} input
 * @returns {{ text: string, signature: string } | null}
 */
export function agentNote({ self, rules, mode, nowMs, timeZone }) {
  const limit = bindingLimit(self?.budget);
  const pace = self?.pace ?? null;
  const pause = pauseOf(self, nowMs, timeZone);
  const parts = [];
  let rulesSig = "";

  if (mode === "subscription") {
    const list = ruleList(rules);
    if (list) {
      parts.push(rulesText(list));
      rulesSig = JSON.stringify(list.map((r) => [r.tool, r.command, r.path, r.domain, r.effect]));
    }
    if (limit) parts.push(subscriptionBudgetText(limit, pause));
  } else if (limit) {
    parts.push(apiBudgetText(limit, pace, pause, nowMs, timeZone));
  }
  if (parts.length === 0) return null;

  const head = mode === "subscription" ? "PassControl note (sent when it changes): " : "PassControl budget note (sent when it changes): ";
  const text = head + parts.map((p, i) => (i === 0 ? p : capital(p))).join(" ");
  const resetNear = limit?.kind === "period" && limit.resetsIn !== null && limit.resetsIn <= 3600;
  const paceReaches = mode === "api" && pace && typeof pace === "object" ? (pace.reaches_limit_at ? "reaches" : "lasts") : "";
  const signature = [mode, limit ? `${limit.kind}:${limit.period ?? ""}:${band(limit)}` : "-", resetNear ? "reset-near" : "", paceReaches, rulesSig, pause.state].join("|");
  return { text, signature };
}
