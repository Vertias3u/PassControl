// Subscription mode's limit (Phase 1): Anthropic's usage
// window.
//
// A Pro/Max subscription pays a flat fee, so dollars are not what runs out: the
// 5-hour and 7-day allowances are. Claude Code passes how much of each is used to its
// status-line command on stdin, as `rate_limits` (Pro/Max only, and only after the
// session's first response; code.claude.com/docs/en/statusline, read 2026-10-11).
// `passcontrol statusline` reads it from there, shows it, and hands it to the sidecar
// on WINDOW_PATH, so `watch` and `/passcontrol` can show it too.
//
// It is shown, never enforced (the owner's choice on 2026-10-11): Anthropic enforces
// its own window, and the number is the client's report.

export const WINDOW_PATH = "/_passcontrol/window";

// Seconds since the epoch, from 2001 to 2286: anything else is not a reset time.
const isEpochSeconds = (v) => Number.isInteger(v) && v > 1_000_000_000 && v < 10_000_000_000;
// A percentage of an allowance. Over 100 is allowed: a window can be overrun.
const isPct = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1000;

function one(raw, pctKey, resetKey) {
  if (!raw || typeof raw !== "object" || !isPct(raw[pctKey])) return null;
  return { usedPct: raw[pctKey], resetsAt: isEpochSeconds(raw[resetKey]) ? raw[resetKey] : null };
}

function both(fiveHour, sevenDay) {
  return fiveHour || sevenDay ? { fiveHour, sevenDay } : null;
}

/** The window from Claude Code's status-line input, or null. Never throws. */
export function readUsageWindow(input) {
  const limits = input && typeof input === "object" ? input.rate_limits : null;
  if (!limits || typeof limits !== "object") return null;
  return both(one(limits.five_hour, "used_percentage", "resets_at"), one(limits.seven_day, "used_percentage", "resets_at"));
}

/** A window in this module's own shape, held to it again: what the sidecar accepts. */
export function heldUsageWindow(value) {
  if (!value || typeof value !== "object") return null;
  return both(one(value.fiveHour, "usedPct", "resetsAt"), one(value.sevenDay, "usedPct", "resetsAt"));
}

const pad2 = (n) => String(n).padStart(2, "0");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** A reset time as the local clock reads it, with the weekday when it is not today. */
export function resetTime(epochSeconds, now = Date.now()) {
  const at = new Date(epochSeconds * 1000);
  const clock = `${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
  return at.toDateString() === new Date(now).toDateString() ? clock : `${DAYS[at.getDay()]} ${clock}`;
}

/**
 * `5h 24% (resets 21:40) · 7d 41% (resets Tue 09:00)`, or with `short`, `5h 24% · 7d 41%`.
 * Empty for no window.
 */
export function usageWindowText(window, { short = false, formatTime = resetTime } = {}) {
  const held = heldUsageWindow(window);
  if (!held) return "";
  const part = (label, w) => {
    if (!w) return null;
    const resets = !short && w.resetsAt ? ` (resets ${formatTime(w.resetsAt)})` : "";
    return `${label} ${Math.round(w.usedPct)}%${resets}`;
  };
  return [part("5h", held.fiveHour), part("7d", held.sevenDay)].filter(Boolean).join(" · ");
}
