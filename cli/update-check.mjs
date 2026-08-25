// "There is a newer PassControl" — the one outbound call this CLI makes on its
// own initiative, and the constraints that come with that.
//
// This is a credential tool. A registry lookup nobody asked for is the kind of
// thing a security reviewer finds and writes up, so every guard below exists to
// make the behaviour predictable rather than clever:
//
//   * It never blocks. The check is fire-and-forget with a short timeout; a
//     registry outage must not add a second to `passcontrol call`.
//   * TTY only. If stdout is not a terminal there is no human to read a notice,
//     which means an agent run, a CI job or a piped command never phones npm.
//   * Never under --json. A notice on stdout would corrupt the document.
//   * Opt-out honoured: PASSCONTROL_NO_UPDATE_CHECK, and NO_UPDATE_NOTIFIER
//     because that is the variable people already set for this class of tool.
//   * Cached for a day in the config directory, so the frequency is bounded by
//     wall-clock time rather than by how often the CLI is run.
//
// It reports only that a newer version exists. It never downloads, installs or
// runs anything — upgrading stays a thing the operator types.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const REGISTRY_URL = "https://registry.npmjs.org/passcontrol/latest";
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Beside the existing config and app.json, and created with the same 0700. */
export function updateCachePath(env = process.env) {
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "passcontrol", "update-check.json");
}

/**
 * Compare two versions numerically, segment by segment.
 *
 * A string compare gets this wrong the moment a segment reaches double digits
 * ("0.10.0" < "0.9.0"), which is precisely when an update notice starts to
 * matter. Anything with a prerelease suffix is treated as NOT newer: someone
 * running 0.7.0-rc.1 asked for it and should not be nagged back to 0.6.1.
 */
export function isNewer(candidate, current) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(String(value ?? "").trim());
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  };
  const a = parse(candidate);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

// Two gates, and keeping them apart is load-bearing.
//
// They answer different questions — "may anything be printed?" and "may the
// network be touched?" — and a single predicate collapsing both got this
// wrong: a fresh cache made the combined check return false for the SAME
// reason a pipe did, so the cached-notice fallback happily printed a notice
// into a --json document and into piped output. Caught by running it, not by
// the unit test that asserted the non-TTY case against an empty cache.

/** May a notice be shown at all? Nothing here is about time or the network. */
export function mayAnnounce({ isTty, json = false, env = process.env } = {}) {
  if (!isTty) return false;
  if (json) return false;
  if (env.PASSCONTROL_NO_UPDATE_CHECK || env.NO_UPDATE_NOTIFIER) return false;
  if (env.CI) return false;
  return true;
}

/** May we ask the registry again, or is the cached answer still fresh? */
export function shouldFetch({ now = Date.now(), cache = null, ttlMs = CACHE_TTL_MS } = {}) {
  if (cache && typeof cache.checkedAt === "number" && now - cache.checkedAt < ttlMs) return false;
  return true;
}

/** Both gates together: check the registry now? */
export function shouldCheck({
  isTty,
  json = false,
  env = process.env,
  now = Date.now(),
  cache = null,
  ttlMs = CACHE_TTL_MS,
} = {}) {
  return mayAnnounce({ isTty, json, env }) && shouldFetch({ now, cache, ttlMs });
}

export function readCache(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    // A missing or corrupt cache means "check again", never a crash.
    return null;
  }
}

export function writeCache(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${JSON.stringify(data)}\n`, { mode: 0o600 });
  } catch {
    // An unwritable config dir costs a repeat check, nothing more.
  }
}

/** The notice itself, or null when there is nothing worth saying. */
export function updateNotice(current, latest) {
  if (!isNewer(latest, current)) return null;
  return `Update available ${current} → ${latest}   npm install -g passcontrol@latest`;
}

/**
 * Look up the latest published version. Resolves to null on ANY failure —
 * offline, DNS, a 500, a slow registry, malformed JSON. There is no error path
 * a user should ever see from a background nicety.
 */
export async function fetchLatest(url = REGISTRY_URL, timeoutMs = 1500, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: "application/vnd.npm.install-v1+json" },
    });
    if (!res.ok) return null;
    const body = await res.json();
    const version = body?.version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run the check and return the notice to print, or null.
 *
 * The caller decides WHEN to print it — after the command's own output, so a
 * nicety never pushes the thing the operator ran off the top of the screen.
 */
export async function checkForUpdate({
  current,
  isTty = Boolean(process.stdout.isTTY),
  json = false,
  env = process.env,
  now = Date.now(),
  file = updateCachePath(env),
  fetchLatestImpl = fetchLatest,
} = {}) {
  // Display gate FIRST, and it short-circuits everything: no cache read, no
  // network, no notice. Under --json or a pipe this function does nothing at all.
  if (!mayAnnounce({ isTty, json, env })) return null;

  const cache = readCache(file);
  if (!shouldFetch({ now, cache })) {
    // Inside the daily window a cached answer is still worth showing — the TTL
    // bounds the network call, not the notice, or an update discovered a minute
    // ago would go unmentioned for the rest of the day.
    return typeof cache?.latest === "string" ? updateNotice(current, cache.latest) : null;
  }
  const latest = await fetchLatestImpl();
  writeCache(file, { checkedAt: now, latest: latest ?? cache?.latest ?? null });
  return latest ? updateNotice(current, latest) : null;
}
