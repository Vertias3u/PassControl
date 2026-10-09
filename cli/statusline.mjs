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
import { statusLine } from "./budget-format.mjs";

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
