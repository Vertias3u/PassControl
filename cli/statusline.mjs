// `passcontrol statusline`: the agent's budget as one line in Claude Code's status
// line (1.4.0 candidate 2).
//
// Claude Code runs the command after every assistant message, debounced 300ms, and
// cancels a run still going when the next one starts (code.claude.com/docs/en/statusline,
// read 2026-10-08). So:
//   * a good answer is cached for TTL_MS and reused, so a busy session asks the
//     gateway a few times a minute rather than every message;
//   * it asks through the running sidecar, which already holds a warm visa: minting
//     a visa per run would spend the passport's challenge allowance (20 a window),
//     the same allowance the sidecar refreshes from;
//   * it never throws. Every outcome is one line, and the caller exits 0.
// Only a good answer is cached. A failure is shown as the failure, never as an
// older budget that might read as current.
import fs from "node:fs";
import path from "node:path";
import { limitReached, panelRows, paused, statusLine } from "./budget-format.mjs";
import { heldUsageWindow, readUsageWindow, usageWindowText, WINDOW_PATH } from "./usage-window.mjs";

export const STATUSLINE_TTL_MS = 20_000;
const TIMEOUT_MS = 1_500;

function readCache(file, nowMs, ttlMs) {
  try {
    const cached = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof cached?.line === "string" && typeof cached.at === "number" && nowMs - cached.at >= 0 && nowMs - cached.at < ttlMs) {
      return cached.line;
    }
  } catch {
    // No cache, or an unreadable one: ask.
  }
  return null;
}

function writeCache(file, nowMs, line) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ at: nowMs, line }), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  } catch {
    // A cache that cannot be written only costs the next run a request.
  }
}

/** The line to print. Never throws. */
export async function statuslineText({
  port,
  host = "127.0.0.1",
  cacheFile,
  now = () => Date.now(),
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = TIMEOUT_MS,
  ttlMs = STATUSLINE_TTL_MS,
}) {
  const cached = readCache(cacheFile, now(), ttlMs);
  if (cached) return cached;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(`http://${host}:${port}/api/v1/self`, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
    } catch {
      return controller.signal.aborted
        ? "PassControl · no answer from the sidecar"
        : `PassControl · sidecar not running on port ${port}`;
    }
    // The gateway's opaque refusal covers both a suspended agent and a kill switch.
    if (response.status === 403) return "PassControl · agent stopped";
    if (!response.ok) return `PassControl · unavailable (HTTP ${response.status})`;
    let self;
    try {
      self = await response.json();
    } catch {
      return controller.signal.aborted ? "PassControl · no answer from the sidecar" : "PassControl · unreadable answer";
    }
    if (typeof self?.budget !== "object" || self.budget === null) return "PassControl · unreadable answer";
    const line = statusLine(self);
    writeCache(cacheFile, now(), line);
    return line;
  } catch {
    return "PassControl · unavailable";
  } finally {
    clearTimeout(timer);
  }
}

// Claude Code writes one JSON object to the command's stdin. It may not close the
// stream promptly, so the object is taken as soon as it parses, and after this long
// the line is printed without it.
const STDIN_WAIT_MS = 300;
const STDIN_LIMIT = 256 * 1024;

/** Claude Code's status-line input, or null. Never throws, never waits past `waitMs`. */
export function readStatusInput(stream = process.stdin, waitMs = STDIN_WAIT_MS) {
  if (!stream || stream.isTTY) return Promise.resolve(null);
  return new Promise((resolve) => {
    let text = "";
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stream.removeAllListeners?.("data");
      // An open stdin would keep the process alive after the line is printed.
      stream.destroy?.();
      resolve(value);
    };
    const parse = () => {
      try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === "object" ? parsed : null;
      } catch {
        return undefined;
      }
    };
    const timer = setTimeout(() => finish(parse() ?? null), waitMs);
    try {
      stream.setEncoding?.("utf8");
      stream.on("data", (chunk) => {
        text += chunk;
        if (text.length > STDIN_LIMIT) return finish(null);
        const parsed = parse();
        if (parsed !== undefined) finish(parsed);
      });
      stream.on("end", () => finish(parse() ?? null));
      stream.on("error", () => finish(null));
    } catch {
      finish(null);
    }
  });
}

/**
 * Hands the usage window to the sidecar, for `watch` and `/passcontrol`. Best effort:
 * a sidecar that is not running only means the boards do not show it.
 */
export async function postUsageWindow({ port, host = "127.0.0.1", window, fetch: fetchImpl = globalThis.fetch, timeoutMs = 500 }) {
  if (!window) return;
  try {
    const response = await fetchImpl(`http://${host}:${port}${WINDOW_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(window),
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel().catch(() => {});
  } catch {
    // Nothing to tell anyone: the status line still shows the window.
  }
}

/**
 * The status line with the usage window, when Claude Code sent one: the budget line
 * may come from the cache, the window is always this run's. Never throws.
 */
export async function statuslineWithWindow({ input, port, host = "127.0.0.1", fetch: fetchImpl = globalThis.fetch, budgetLine }) {
  const window = readUsageWindow(input);
  const [line] = await Promise.all([budgetLine(), postUsageWindow({ port, host, window, fetch: fetchImpl })]);
  const text = usageWindowText(window, { short: true });
  return text ? `${line} · ${text}` : line;
}

// The session id Claude Code declares on every call, held to what the gateway
// accepts as declared (lib/client-lineage.ts), so nothing else is ever sent on.
const DECLARED_SESSION = /^[A-Za-z0-9._:-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * Where Claude Code sends its calls, from its own ANTHROPIC_BASE_URL (the plugin's
 * hook inherits Claude Code's environment): `{ port }` for a sidecar on this
 * machine, `{ remote: host }` for anything else, null when it is not set. A
 * dedicated Claude Code agent's sidecar is not on the default port, and asking the
 * default one would report a different agent.
 */
export function sidecarFromBaseUrl(baseUrl) {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) return null;
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  if (!LOOPBACK.has(url.hostname)) return { remote: url.host };
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  return Number.isInteger(port) && port > 0 && port < 65536 ? { port } : null;
}

/** The panel for a session whose calls do not pass through a PassControl sidecar. */
export function notInPathText(remoteHost) {
  return [
    "PassControl · not in the path of this session",
    "",
    `  Claude Code sends its calls to ${remoteHost}, not through a PassControl`,
    "  sidecar, so PassControl neither sees nor limits them. To route them:",
    "  passcontrol configure claude-code --write",
  ].join("\n");
}

const row = ([label, value]) => `  ${label.padEnd(11)} ${value}`;

/** The usage window the sidecar holds, as short text, or "". Never throws. */
async function readSidecarWindow({ host, port, fetch: fetchImpl, signal }) {
  try {
    const response = await fetchImpl(`http://${host}:${port}${WINDOW_PATH}`, { headers: { accept: "application/json" }, signal });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return "";
    }
    return usageWindowText(heldUsageWindow(await response.json()), { short: true });
  } catch {
    return "";
  }
}

/**
 * `passcontrol statusline --panel`: what `/passcontrol` shows in Claude Code (F3).
 * The plugin's hook prints it without calling the model, so it answers while the
 * gateway refuses every call. Always asks: never answered from the status line's
 * cache, where a "fine" from before the stop could still sit. Never throws.
 */
export async function statusPanelText({
  port,
  host = "127.0.0.1",
  gateway,
  session = null,
  subscription = false,
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = TIMEOUT_MS,
}) {
  const dashboard = `${String(gateway ?? "").replace(/\/+$/, "")}/dashboard`;
  const headers = { accept: "application/json" };
  if (typeof session === "string" && DECLARED_SESSION.test(session)) headers["x-claude-code-session-id"] = session;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(`http://${host}:${port}/api/v1/self`, { headers, signal: controller.signal });
    } catch {
      if (controller.signal.aborted) return "PassControl · no answer from the sidecar\n\n  It did not answer in time. Try again in a moment.";
      // On a subscription the calls never pass the sidecar, so they go ahead without
      // it: what stops is PassControl checking the stops and showing the calls.
      const consequence = subscription
        ? [
            "  This session's calls still go ahead, but PassControl does not check",
            "  the agent's stops or show its calls until it runs. Start it with:",
            "  passcontrol sidecar",
          ]
        : ["  If Claude Code is set to send its calls through PassControl, they fail", "  until it runs. Start it with:  passcontrol sidecar"];
      return [`PassControl · sidecar not running on port ${port}`, "", ...consequence].join("\n");
    }
    if (response.status === 403) {
      const body = await response.json().catch(() => ({}));
      if (typeof body?.message === "string" && body.message.includes("stopped this session")) {
        return [
          "PassControl · REFUSING CALLS from this session",
          "",
          "  The agent's owner stopped this session, so nothing you type here",
          "  reaches the model. Other sessions of this agent are not affected,",
          "  and a new session is not stopped. The owner can resume this one",
          "  from the agent's Sessions view.",
          "",
          row(["Dashboard", dashboard]),
        ].join("\n");
      }
      // The gateway's one opaque answer for both: it does not say which fired.
      return [
        "PassControl · REFUSING CALLS",
        "",
        "  The gateway is refusing this agent's calls: its owner suspended it, or",
        "  the kill switch is on. Nothing you type here reaches the model until",
        "  it is lifted.",
        "",
        row(["Dashboard", dashboard]),
      ].join("\n");
    }
    if (response.status === 429) return "PassControl · asked too often\n\n  Try again in a minute.";
    if (!response.ok) return `PassControl · unavailable (HTTP ${response.status})`;
    let self;
    try {
      self = await response.json();
    } catch {
      return "PassControl · unreadable answer";
    }
    if (typeof self?.budget !== "object" || self.budget === null) return "PassControl · unreadable answer";
    const agentId = typeof self.agent_id === "string" && UUID.test(self.agent_id) ? self.agent_id : null;
    const title = `PassControl${agentId ? ` · agent ${agentId.slice(0, 8)}` : ""}${limitReached(self) ? " · LIMIT REACHED" : paused(self) ? " · PAUSED" : ""}`;
    const window = subscription ? await readSidecarWindow({ host, port, fetch: fetchImpl, signal: controller.signal }) : "";
    return [
      title,
      "",
      ...panelRows(self).map(row),
      ...(window ? [row(["Window", window])] : []),
      row(["Calls", subscription ? "reported by Claude Code (subscription), not proxied" : `through the sidecar on :${port}`]),
      "",
      row(["Agent page", agentId ? `${dashboard}/agents/${agentId}` : dashboard]),
    ].join("\n");
  } catch {
    return "PassControl · unavailable";
  } finally {
    clearTimeout(timer);
  }
}
