// `passcontrol watch` (F6): a full-screen board of the calls a sidecar relays, live.
//
// Claude Code and Codex split work across sub-agents, and until now a person saw what
// that cost only afterwards. The board shows each call as it happens: time, declared
// session, declared sub-agent, model, BOARDED / DENIED / ERROR, and latency, under the
// agent's budget.
//
// What it is not:
//   * not complete: a call that does not go through this sidecar is not on it;
//   * not a control: it reads, it never stops anything (the dashboard does that);
//   * not a record: it writes nothing to disk. The feed is in the sidecar's memory
//     (cli/watch-feed.mjs) and the budget is asked for and held here, in memory,
//     never cached to a file the way the status line's is.
//
// Everything a cell shows came over a socket, so the renderer trusts none of it:
// fields are held to the feed's own patterns on arrival, and every cell is stripped
// of control characters again before it is drawn.
import http from "node:http";
import { formatUsd, limitReached, panelRows } from "./budget-format.mjs";
import { WATCH_PATH } from "./watch-feed.mjs";

const DECLARED = /^[A-Za-z0-9._:-]{1,128}$/;
const MODEL = /^[A-Za-z0-9._:/@-]{1,100}$/;
const CODE = /^[a-z][a-z0-9_]{1,47}$/;
const PROVIDER = /^[a-z0-9-]{1,32}$/;
const OUTCOMES = new Set(["boarded", "denied", "error"]);
const MAX_ROWS = 500;
const MAX_LINE = 64 * 1024;
export const BUDGET_EVERY_MS = 20_000;
const BUDGET_TIMEOUT_MS = 3_000;
const RECONNECT_MS = [500, 1000, 2000, 4000, 5000];
// Something other than a feed answered. Through a sidecar from before `watch`, that
// request went on to the GATEWAY with a visa (it forwards every path) and came back
// as the login page; on Cloud each one costs the gateway a session check. So a
// wrong answer is asked again once a minute, not every few seconds.
const WRONG_ANSWER_MS = 60_000;
const BUSY_MS = 10_000;

/** How long to wait before asking for the feed again, after `error` on try `attempt`. */
export function retryDelay(error, attempt) {
  if (error.kind === "unreachable" || error.kind === "closed") return RECONNECT_MS[Math.min(attempt, RECONNECT_MS.length - 1)];
  if (error.kind === "busy") return BUSY_MS;
  return WRONG_ANSWER_MS;
}
const REDRAW_MS = 60;
const MIN_WIDTH = 40;

// ── The feed, as a client ────────────────────────────────────────────────────

/**
 * Subscribes to a sidecar's feed. `onEvent(event, rawLine)` for every line, the hello
 * included; `onError({ kind, ... })` once, when it ends or never starts. kinds:
 * unreachable, closed, not-feed (an older sidecar, or something else on the port),
 * off (bound off loopback), refused, busy.
 */
export function openFeed({ port, host = "127.0.0.1", onEvent, onError = () => {} }) {
  let done = false;
  let greeted = false;
  let buffer = "";
  let req;
  const fail = (error) => {
    if (done) return;
    done = true;
    req?.destroy();
    onError(error);
  };
  req = http.get({ host, port, path: WATCH_PATH, headers: { accept: "application/x-ndjson" }, agent: false }, (res) => {
    res.setEncoding("utf8");
    const type = String(res.headers["content-type"] ?? "");
    if (res.statusCode !== 200 || !type.startsWith("application/x-ndjson")) {
      let body = "";
      res.on("data", (chunk) => {
        if (body.length < 4096) body += chunk;
      });
      const settle = () => {
        let code = null;
        try {
          code = JSON.parse(body)?.error ?? null;
        } catch {
          // Not ours.
        }
        const kind = { watch_off: "off", watch_refused: "refused", watch_busy: "busy" }[code] ?? "not-feed";
        fail({ kind, status: res.statusCode });
      };
      res.on("end", settle);
      res.on("close", settle);
      return;
    }
    res.on("data", (chunk) => {
      if (done) return;
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          return fail({ kind: "not-feed", status: 200 });
        }
        if (!greeted) {
          if (event?.type !== "hello" || event.feed !== "passcontrol-watch") return fail({ kind: "not-feed", status: 200 });
          greeted = true;
        }
        onEvent(event, line);
        if (done) return;
      }
      if (buffer.length > MAX_LINE) fail({ kind: "not-feed", status: 200 });
    });
    res.on("close", () => fail({ kind: "closed" }));
  });
  req.on("error", (e) => fail({ kind: "unreachable", message: e?.code ?? e?.message }));
  return {
    destroy() {
      done = true;
      req.destroy();
    },
  };
}

// ── State ────────────────────────────────────────────────────────────────────

export function createBoardState() {
  return { run: null, rows: [], feed: { state: "connecting" }, budget: null };
}

const held = (pattern, value) => (typeof value === "string" && pattern.test(value) ? value : null);
const count = (value) => (Number.isFinite(value) && value >= 0 ? Math.round(value) : null);

/** A feed event, held to the feed's own patterns. Anything else is dropped. */
export function applyEvent(state, event) {
  if (!event || typeof event !== "object") return state;
  if (event.type === "hello") {
    const run = held(DECLARED, event.run);
    // A new sidecar run numbers its calls from 1 again: the old rows are another run's.
    if (state.run !== run) state.rows = [];
    state.run = run;
    state.feed = { state: "live" };
    return state;
  }
  if (event.type === "call") {
    if (!Number.isInteger(event.seq) || event.seq < 1) return state;
    const row = {
      seq: event.seq,
      at: count(event.at),
      ses: held(DECLARED, event.ses),
      agent: held(DECLARED, event.agent),
      parent: held(DECLARED, event.parent),
      model: held(MODEL, event.model),
      provider: held(PROVIDER, event.provider),
      outcome: OUTCOMES.has(event.outcome) ? event.outcome : "error",
      code: held(CODE, event.code),
      status: Number.isInteger(event.status) ? event.status : null,
      ttfb: count(event.ttfb),
      ms: count(event.ms),
    };
    const existing = state.rows.findIndex((r) => r.seq === row.seq);
    if (existing === -1) state.rows.push(row);
    else state.rows[existing] = { ...row, ms: row.ms ?? state.rows[existing].ms };
    if (state.rows.length > MAX_ROWS) state.rows.splice(0, state.rows.length - MAX_ROWS);
    return state;
  }
  if (event.type === "end") {
    const row = state.rows.find((r) => r.seq === event.seq);
    const ms = count(event.ms);
    if (row && ms !== null) row.ms = ms;
    return state;
  }
  return state;
}

// ── Rendering (pure) ─────────────────────────────────────────────────────────

// C0, DEL, C1, zero-width and bidi controls: nothing that could move the cursor,
// recolour the screen, or reorder what a person reads.
const UNSAFE_RANGES = [[0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff]];
// Built from code points: the characters themselves are invisible in source, and a
// literal one in a regular expression is a parse error waiting for an editor.
const hex4 = (n) => `\\u${n.toString(16).padStart(4, "0")}`;
const UNSAFE = new RegExp(`[${UNSAFE_RANGES.map(([a, b]) => `${hex4(a)}-${hex4(b)}`).join("")}]`, "g");

/** A cell's text, with every control character removed. */
export function clean(value) {
  return String(value ?? "").replace(UNSAFE, "");
}

function fit(text, width) {
  const s = clean(text);
  if (width <= 0) return "";
  return s.length > width ? `${s.slice(0, width - 1)}…` : s.padEnd(width);
}

function fitRight(text, width) {
  const s = clean(text);
  return s.length > width ? `${s.slice(0, width - 1)}…` : s.padStart(width);
}

/** Long ids differ at the end (a0000000000000002 vs …3): keep both ends. */
function middle(text, width) {
  const s = clean(text);
  if (s.length <= width) return s.padEnd(width);
  const head = Math.ceil((width - 1) / 2);
  const tail = Math.floor((width - 1) / 2);
  return `${s.slice(0, head)}…${tail > 0 ? s.slice(-tail) : ""}`;
}

export function formatMs(ms) {
  if (ms === null || ms === undefined) return "";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(2)}s`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

const localTime = (at) => new Date(at).toTimeString().slice(0, 8);

function statusText(row) {
  if (row.outcome === "boarded") return "BOARDED";
  if (row.outcome === "denied") return row.code ? `DENIED ${row.code}` : "DENIED";
  return `ERROR ${row.code ?? row.status ?? ""}`.trimEnd();
}

function latencyText(row, now) {
  if (row.ms !== null) return formatMs(row.ms);
  // Still streaming: how long so far, marked as not final.
  return row.at !== null ? `${formatMs(Math.max(0, now - row.at))}…` : "…";
}

function sessionText(row, run) {
  if (!row.ses) return "—";
  return row.ses === run ? "(run)" : row.ses.slice(0, 8);
}

function agentText(row, width) {
  if (!row.agent) return "main".padEnd(width);
  return row.parent ? `↳${middle(row.agent, width - 1)}` : middle(row.agent, width);
}

/** Column widths for a terminal `width` wide; the session column goes first when narrow. */
function columns(width) {
  // Below 80 columns the model and the refusal's reason need the room more.
  const withSession = width >= 80;
  const fixed = 8 + (withSession ? 8 : 0) + 12 + 7;
  const gaps = (withSession ? 5 : 4) * 2;
  const rest = Math.max(10, width - fixed - gaps);
  const model = Math.ceil(rest / 2);
  return { withSession, time: 8, session: 8, agent: 12, model, status: rest - model, latency: 7 };
}

const SGR = { bold: "\x1b[1m", dim: "\x1b[2m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", reverse: "\x1b[7m", reset: "\x1b[0m" };
const paint = (color, style, text) => (color ? `${SGR[style]}${text}${SGR.reset}` : text);

const BAR_STYLE = { boarded: "green", denied: "red", error: "yellow" };

/** One board row, `width` wide at most. */
function rowLine(row, cols, { run, now, formatTime, color }) {
  const cells = [fit(row.at !== null ? formatTime(row.at) : "", cols.time)];
  if (cols.withSession) cells.push(fit(sessionText(row, run), cols.session));
  cells.push(agentText(row, cols.agent));
  cells.push(fit(row.model ?? "—", cols.model));
  cells.push(paint(color, BAR_STYLE[row.outcome], fit(statusText(row), cols.status)));
  cells.push(fitRight(latencyText(row, now), cols.latency));
  return cells.join("  ");
}

function budgetFraction(self) {
  const b = self?.budget ?? {};
  const ratio = (used, limit) => {
    const u = Number(used);
    const l = Number(limit);
    return Number.isFinite(u) && Number.isFinite(l) && l > 0 ? Math.min(1, Math.max(0, u / l)) : null;
  };
  if (b.period && !b.period.unknown) return ratio(b.period.used_microcents, b.period.limit_microcents);
  if (b.cost) return ratio(b.cost.used_microcents, b.cost.limit_microcents);
  if (b.tokens) return ratio(b.tokens.used, b.tokens.limit);
  return null;
}

function budgetLine(budget, width, { color, formatTime }) {
  if (!budget) return "Budget    checking…";
  if (budget.kind === "stopped") {
    return paint(color, "red", "REFUSING CALLS · its owner suspended this agent, or the kill switch is on");
  }
  if (budget.kind === "unavailable") return `Budget    unavailable (${clean(budget.reason)})`;
  const [label, value] = panelRows(budget.self)[0];
  const fraction = budgetFraction(budget.self);
  const barWidth = width >= 100 ? 24 : width >= 72 ? 16 : 8;
  let bar = "";
  if (fraction !== null) {
    const filled = Math.round(fraction * barWidth);
    const style = fraction >= 1 ? "red" : fraction >= 0.8 ? "yellow" : "green";
    bar = `[${paint(color, style, "█".repeat(filled))}${"░".repeat(barWidth - filled)}] `;
  }
  const reached = limitReached(budget.self) ? ` · ${paint(color, "red", "LIMIT REACHED")}` : "";
  const line = `${clean(label).padEnd(9)} ${bar}${clean(value)}${reached}`;
  // When it was asked is the first thing to go when the line is too long.
  const checked = budget.checkedAt ? ` · checked ${formatTime(budget.checkedAt)}` : "";
  return visibleLength(line + checked) <= width ? line + checked : line;
}

function feedText(feed, port) {
  switch (feed?.state) {
    case "live":
      return "live";
    case "connecting":
      return "connecting…";
    case "down":
      return "not connected";
    default:
      return "";
  }
}

/** The visible length of a line: what is left once our own SGR codes are removed. */
export function visibleLength(line) {
  return line.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** Cuts a line to `width` visible columns, keeping our colour codes balanced. */
function clip(line, width) {
  if (visibleLength(line) <= width) return line;
  let out = "";
  let shown = 0;
  for (let i = 0; i < line.length && shown < width; ) {
    const sgr = /^\x1b\[[0-9;]*m/.exec(line.slice(i));
    if (sgr) {
      out += sgr[0];
      i += sgr[0].length;
      continue;
    }
    out += line[i];
    shown += 1;
    i += 1;
  }
  return out.includes("\x1b[") ? `${out}${SGR.reset}` : out;
}

/**
 * The whole board as `height` lines, none wider than `width`. Pure: the same state,
 * size and clock give the same lines.
 */
export function renderBoard(state, { width, height, port, now = Date.now(), formatTime = localTime, color = false }) {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  if (w < MIN_WIDTH || h < 6) {
    const lines = [`Window too small (min ${MIN_WIDTH}×6)`];
    while (lines.length < h) lines.push("");
    return lines.slice(0, h).map((l) => clip(l, w));
  }
  const cols = columns(w);
  const rows = state.rows;
  const tally = { boarded: 0, denied: 0, error: 0 };
  for (const r of rows) tally[r.outcome] += 1;
  const counts = rows.length
    ? `${rows.length} call${rows.length === 1 ? "" : "s"}: ${tally.boarded} boarded, ${tally.denied} denied${tally.error ? `, ${tally.error} error` : ""}`
    : "no calls yet";
  const lines = [
    `${paint(color, "bold", "PassControl watch")} · sidecar :${port} · ${feedText(state.feed, port)} · ${counts}`,
    budgetLine(state.budget, w, { color, formatTime }),
    // Why the board is not live, on a line of its own so it is never cut off the end
    // of the header. Older rows stay below it: they happened.
    state.feed?.state === "down" ? paint(color, "yellow", clean(state.feed.message ?? `waiting for the sidecar on :${port}`)) : "",
  ];
  const header = ["TIME".padEnd(cols.time)];
  if (cols.withSession) header.push("SESSION".padEnd(cols.session));
  header.push("SUB-AGENT".padEnd(cols.agent), "MODEL".padEnd(cols.model), "STATUS".padEnd(cols.status), "LATENCY".padStart(cols.latency));
  lines.push(paint(color, "dim", header.join("  ")));

  const space = h - lines.length - 1;
  if (rows.length === 0) {
    lines.push(`  Point an agent at http://127.0.0.1:${port}/api/v1/anthropic (or /openai); its calls appear here.`);
  } else {
    // Newest first: what just happened is what a person is looking for.
    for (const row of rows.slice(-space).reverse()) {
      lines.push(rowLine(row, cols, { run: state.run, now, formatTime, color }));
    }
  }
  while (lines.length < h - 1) lines.push("");
  lines.push(paint(color, "dim", "q quit · newest first · read-only · calls that skip this sidecar are not shown"));
  return lines.slice(0, h).map((line) => clip(line, w).trimEnd());
}

/** A finished call as one plain line, for a board whose output is not a terminal. */
export function plainLine(row, { run, formatTime = localTime }) {
  const cols = columns(100);
  return rowLine(row, cols, { run, now: Date.now(), formatTime, color: false }).trimEnd();
}

// ── The budget, held in memory ───────────────────────────────────────────────

/** GET /api/v1/self through the sidecar, which holds a warm visa. Never throws, never writes. */
export async function fetchBudget({ port, host = "127.0.0.1", fetch: fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = BUDGET_TIMEOUT_MS }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(`http://${host}:${port}/api/v1/self`, { headers: { accept: "application/json" }, signal: controller.signal });
    } catch {
      return { kind: "unavailable", reason: controller.signal.aborted ? "no answer from the sidecar" : "sidecar not running" };
    }
    // The gateway's one opaque refusal for a suspended agent and a kill switch.
    if (response.status === 403) return { kind: "stopped" };
    if (response.status === 429) return { kind: "unavailable", reason: "asked too often; trying again shortly" };
    if (!response.ok) return { kind: "unavailable", reason: `HTTP ${response.status}` };
    const self = await response.json().catch(() => null);
    if (typeof self?.budget !== "object" || self.budget === null) return { kind: "unavailable", reason: "unreadable answer" };
    return { kind: "ok", self, checkedAt: now() };
  } catch {
    return { kind: "unavailable", reason: "unavailable" };
  } finally {
    clearTimeout(timer);
  }
}

// ── The terminal ─────────────────────────────────────────────────────────────

const ENTER = "\x1b[?1049h\x1b[?25l";
export const LEAVE = "\x1b[?25h\x1b[?1049l";

function downMessage(error, port) {
  switch (error.kind) {
    case "unreachable":
      return `no sidecar on :${port} yet · start one with: passcontrol sidecar --port ${port}`;
    case "closed":
      return `the sidecar on :${port} stopped · waiting for it`;
    case "off":
      return "this sidecar is bound off loopback, so it serves no watch feed";
    case "refused":
      return "the sidecar refused the feed request";
    case "busy":
      return "too many boards are already watching this sidecar";
    default:
      return `whatever answers on :${port} serves no watch feed · a sidecar started before \`watch\` existed needs a restart`;
  }
}

/**
 * Runs the board until q, Ctrl-C or a signal. Resolves the exit code. Full-screen
 * on a terminal; one line per finished call otherwise.
 */
export function runWatch({
  port,
  host = "127.0.0.1",
  out = process.stdout,
  input = process.stdin,
  signals = process,
  fetch: fetchImpl = globalThis.fetch,
  budgetEveryMs = BUDGET_EVERY_MS,
  color = !process.env.NO_COLOR,
}) {
  const tty = Boolean(out.isTTY);
  const state = createBoardState();
  const timers = new Set();
  let feed = null;
  let attempt = 0;
  let finished = false;
  let drawTimer = null;
  let resolveExit;
  const exited = new Promise((resolve) => (resolveExit = resolve));
  const printed = new Set();
  let lastBudgetText = null;
  let lastFeedText = null;

  const later = (fn, ms) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
    return t;
  };

  function draw() {
    drawTimer = null;
    if (finished) return;
    if (tty) {
      const lines = renderBoard(state, { width: out.columns || 80, height: out.rows || 24, port, color });
      out.write(`\x1b[H${lines.map((l) => `${l}\x1b[K`).join("\r\n")}\x1b[J`);
      return;
    }
    const feedLine = state.feed?.state === "down" ? clean(state.feed.message ?? "") : state.feed?.state === "live" ? "connected" : null;
    if (feedLine && feedLine !== lastFeedText) {
      lastFeedText = feedLine;
      out.write(`${feedLine}\n`);
    }
    const budget = budgetLine(state.budget, 100, { color: false, formatTime: localTime });
    if (state.budget && budget !== lastBudgetText) {
      lastBudgetText = budget;
      out.write(`${budget}\n`);
    }
    for (const row of state.rows) {
      const key = `${state.run}:${row.seq}`;
      if (row.ms === null || printed.has(key)) continue;
      printed.add(key);
      out.write(`${plainLine(row, { run: state.run })}\n`);
    }
  }

  // A sub-agent fan-out arrives as a burst: one redraw per burst, not per event.
  const schedule = () => {
    if (!drawTimer && !finished) drawTimer = later(draw, REDRAW_MS);
  };

  function connect() {
    if (finished) return;
    feed = openFeed({
      port,
      host,
      onEvent: (event) => {
        if (event.type === "hello") attempt = 0;
        applyEvent(state, event);
        schedule();
      },
      onError: (error) => {
        if (finished) return;
        state.feed = { state: "down", message: downMessage(error, port) };
        schedule();
        later(connect, retryDelay(error, attempt++));
      },
    });
  }

  async function pollBudget() {
    if (finished) return;
    state.budget = await fetchBudget({ port, host, fetch: fetchImpl });
    schedule();
    if (!finished) later(pollBudget, budgetEveryMs);
  }

  const onResize = () => schedule();
  const onKey = (data) => {
    const text = String(data);
    if (text.includes("\x03") || text.includes("q") || text.includes("Q")) finish(0);
  };
  const onSignal = () => finish(0);
  const onExit = () => restore();
  const onCrash = (error) => {
    restore();
    process.stderr.write(`passcontrol watch: ${error?.stack ?? error}\n`);
    process.exit(1);
  };

  let restored = false;
  function restore() {
    if (restored || !tty) return;
    restored = true;
    try {
      input.setRawMode?.(false);
    } catch {
      // Not a terminal any more.
    }
    out.write(LEAVE);
  }

  function finish(code) {
    if (finished) return;
    finished = true;
    for (const t of timers) clearTimeout(t);
    timers.clear();
    clearInterval(tick);
    feed?.destroy();
    restore();
    out.off?.("resize", onResize);
    input.off?.("data", onKey);
    input.pause?.();
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) signals.off?.(signal, onSignal);
    signals.off?.("exit", onExit);
    signals.off?.("uncaughtException", onCrash);
    resolveExit(code);
  }

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) signals.on?.(signal, onSignal);
  signals.on?.("exit", onExit);
  signals.on?.("uncaughtException", onCrash);
  if (tty) {
    out.write(ENTER);
    try {
      input.setRawMode?.(true);
    } catch {
      // Input is not a terminal: q will not reach us, Ctrl-C still does as a signal.
    }
    input.resume?.();
    input.on?.("data", onKey);
    // Windows has no SIGWINCH; the stream's own event works everywhere.
    out.on?.("resize", onResize);
  } else {
    out.write(`PassControl watch · sidecar :${port} · one line per finished call\n`);
  }
  // Streaming rows show their time so far, and "checked" ages: redraw each second.
  const tick = setInterval(() => {
    if (tty && state.rows.some((r) => r.ms === null)) schedule();
  }, 1000);
  draw();
  connect();
  pollBudget();
  return exited;
}
