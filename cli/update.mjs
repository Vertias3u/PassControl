// `passcontrol update` — the decisions, kept pure so every one of them is tested
// before it touches someone's install. bin/passcontrol.mjs does the mutating
// half (npm, git, the local stack) and asks this module what to do.
//
// Two things get updated, and they fail differently:
//
//   * The CLI. Only an npm global install is updated in place, pinned to the
//     exact version just read from the registry (not `@latest`, so a release
//     published mid-update cannot slip in). npx, pnpm, yarn, bun, volta and a
//     source checkout each get the right command PRINTED: guessing another
//     package manager's layout is how a tool ends up installed twice.
//   * The self-host app checkout `setup` made — a clone of the PUBLIC repo only.
//     Fast-forward, never merge; refuse on local edits, a diverged branch, or a
//     checkout that is not the public repo (a private or forked checkout is its
//     owner's to update). Migrations only go forward, so the plan names them.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isNewer } from "./update-check.mjs";

/**
 * How this CLI was installed, and how to update it.
 *
 * `command` is non-null only when running it is safe: an npm global install
 * whose prefix can be read off the script's own path. Everything else gets a
 * `manual` line to print.
 */
export function detectInstall({ scriptPath, platform = process.platform, isSourceCheckout = false, version }) {
  const spec = `passcontrol@${version}`;
  const p = String(scriptPath ?? "");
  const has = (fragment) => p.replace(/\\/gu, "/").includes(fragment);
  if (isSourceCheckout) {
    return { method: "source", command: null, manual: "This CLI runs from a source checkout: update it with `git pull` there." };
  }
  if (has("/_npx/")) return { method: "npx", command: null, manual: `npx passcontrol@${version} (npx runs a fresh copy; nothing to install)` };
  if (has("/pnpm/") || has("/.pnpm/")) return { method: "pnpm", command: null, manual: `pnpm add -g ${spec}` };
  if (has("/yarn/global/") || has("/.yarn/")) return { method: "yarn", command: null, manual: `yarn global add ${spec}` };
  if (has("/.bun/")) return { method: "bun", command: null, manual: `bun add -g ${spec}` };
  if (has("/.volta/")) return { method: "volta", command: null, manual: `volta install ${spec}` };

  const windows = platform === "win32";
  const match = windows
    ? /^(.*)\\node_modules\\passcontrol\\bin\\passcontrol\.mjs$/iu.exec(p)
    : /^(.*)\/lib\/node_modules\/passcontrol\/bin\/passcontrol\.mjs$/u.exec(p);
  if (match && match[1]) {
    const prefix = match[1];
    return {
      method: "npm-global",
      prefix,
      command: [windows ? "npm.cmd" : "npm", "install", "-g", "--prefix", prefix, spec],
      manual: `npm install -g --prefix ${prefix} ${spec}`,
    };
  }
  return { method: "unknown", command: null, manual: `npm install -g ${spec}` };
}

/** `github.com/owner/repo`, lowercased, from any of the forms git accepts. */
function normalizeRepoUrl(url) {
  let s = String(url ?? "").trim().toLowerCase();
  s = s.replace(/^git@([^:]+):/u, "$1/");
  s = s.replace(/^[a-z+]+:\/\//u, "");
  s = s.replace(/^[^@/]+@/u, "");
  s = s.replace(/\/+$/u, "").replace(/\.git$/u, "");
  return s;
}

/** Exact host, owner and repo — never a prefix or substring match. */
export function isPublicRepoUrl(url, publicUrl) {
  const a = normalizeRepoUrl(url);
  return a !== "" && a === normalizeRepoUrl(publicUrl);
}

/**
 * Tracked files with local changes that must stop an update.
 *
 * `package-lock.json` is tolerated: `npm install` rewrites it (the 0.9.5 mirror
 * shipped a stale root version, so every setup checkout shows it modified), it
 * is npm's output rather than anyone's work, and the update restores it and
 * then runs `npm ci`. Untracked files are left to the fast-forward, which names
 * any real collision itself.
 */
export function dirtyBlockers(porcelain) {
  const files = [];
  for (const raw of String(porcelain ?? "").split("\n")) {
    const line = raw.replace(/\r$/u, "");
    if (!line.trim()) continue;
    // Two status columns, a space, the path. A caller that trimmed git's output
    // leaves the FIRST line with one column (" M x" → "M x"), so accept that
    // too rather than reading columns by position (which once saw "ackage-lock.json").
    const match = /^([ MADRCUT?!]{2}) (.+)$/u.exec(line) ?? /^([MADRCUT?!]) (.+)$/u.exec(line);
    if (!match) continue;
    const status = match[1].trim();
    if (status === "??" || status === "!!") continue;
    if (match[2] !== "package-lock.json") files.push(match[2]);
  }
  return files;
}

/**
 * The project id and port offset `setup` baked into supabase/config.toml, or
 * null. Read back rather than re-derived, because re-running the stack with a
 * different offset or id brings up a FRESH, EMPTY Supabase project — which
 * looks exactly like data loss.
 */
export function stackFromConfig(configText) {
  const text = String(configText ?? "");
  const projectId = /^project_id\s*=\s*"([^"]+)"\s*$/mu.exec(text)?.[1];
  const api = /^\[api\]\s*\n(?:[^[]*?\n)?port\s*=\s*(\d+)/mu.exec(text)?.[1];
  if (!projectId || !api) return null;
  const offset = Number(api) - 54321;
  if (!Number.isInteger(offset) || offset < 0 || offset > 10000) return null;
  return { projectId, offset };
}

/** The id scripts/dev-stack.sh will compute for this directory and offset. */
export function expectedProjectId(dirName, offset) {
  return offset === 0 ? dirName : `${dirName}-${offset}`;
}

/**
 * What an update would do. `app.status` is one of:
 *   none    — no self-host checkout on this machine (a Cloud user)
 *   current — at the public repo's tip
 *   behind  — fast-forwardable; `behind`, `from`, `to`, `migrations`
 *   refuse  — `reason` says why this checkout is left alone
 * `app.resume` is set when an earlier update stopped part way.
 */
export function planUpdate({ current, latest, install, app }) {
  const cli = {
    reachable: typeof latest === "string",
    needed: typeof latest === "string" && isNewer(latest, current),
    from: current,
    to: latest ?? null,
    command: install?.command ?? null,
    manual: install?.manual ?? "",
    method: install?.method ?? "unknown",
  };
  const appWork = app?.status === "behind" || Boolean(app?.resume);
  return { cli, app: app ?? { status: "none" }, nothingToDo: !cli.needed && !appWork };
}

/** The plan as lines for a terminal. */
export function formatPlan(plan) {
  const lines = [];
  const { cli, app } = plan;
  if (!cli.reachable) {
    lines.push("CLI: could not reach the npm registry, so it is not known whether a newer version exists.");
  } else if (cli.needed) {
    lines.push(`CLI: ${cli.from} → ${cli.to}`);
    lines.push(cli.command ? `  runs: ${cli.command.join(" ")}` : `  run it yourself: ${cli.manual}`);
  } else {
    lines.push(`CLI: ${cli.from}, nothing newer on npm (latest published: ${cli.to}).`);
  }
  switch (app.status) {
    case "none":
      lines.push("App: no self-host checkout on this machine.");
      break;
    case "refuse":
      lines.push(`App: left alone — ${app.reason}`);
      break;
    case "current":
      lines.push(app.resume ? "App: at the latest commit, but an earlier update was interrupted; it will finish install, migrations and restart." : "App: up to date.");
      break;
    case "behind": {
      lines.push(`App: ${app.behind} new commit(s), ${app.from} → ${app.to}`);
      if (app.resume?.from) {
        lines.push(`  an earlier update (from ${String(app.resume.from).slice(0, 7)}) did not finish; this one completes it`);
      }
      const migrations = app.migrations ?? [];
      lines.push(
        migrations.length
          ? `  database migrations to apply (they only go forward): ${migrations.map((m) => path.basename(m)).join(", ")}`
          : "  no new database migrations"
      );
      lines.push("  steps: stop the dashboard, fast-forward, npm ci, apply migrations, start the dashboard again if it was running");
      break;
    }
    default:
      break;
  }
  return lines;
}

/**
 * Where to count new migrations from. After an interrupted update the checkout
 * is already at (or past) that update's target while its migrations never ran,
 * so counting from HEAD names too few (found 2026-10-06: three named, eight
 * applied). Count from where the interrupted update started, if this checkout
 * still contains that commit.
 */
export function migrationBase({ head, resumeFrom, isAncestor }) {
  if (resumeFrom && isAncestor(resumeFrom)) return resumeFrom;
  return head;
}

/**
 * The closing lines of a finished app update, as [kind, text] pairs ("ok" or
 * "step"). `rollbackTo` is the commit this run fast-forwarded from, or null when
 * it only finished an earlier update and did not move the code.
 */
export function finishLines({ target, root, restarted, rollbackTo, startCommand }) {
  const lines = [["ok", `App updated to ${String(target).slice(0, 7)}.`]];
  if (!restarted) lines.push(["step", `The dashboard is not running. Start it with \`${startCommand}\`.`]);
  if (rollbackTo) {
    lines.push(["step", `To roll back the code: git -C ${root} checkout ${rollbackTo}. Database migrations only go forward.`]);
  }
  return lines;
}

// ── Resume marker ─────────────────────────────────────────────────────────────
//
// Written before the first change to the checkout and cleared on success. After
// a fast-forward HEAD already equals the target, so without it a failed
// `npm ci` or migration would read as "up to date" on the next run.

export function markerPath(env = process.env) {
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "passcontrol", "update-in-progress.json");
}

export function readMarker(env = process.env) {
  try {
    const value = JSON.parse(fs.readFileSync(markerPath(env), "utf8"));
    return value && typeof value.appRoot === "string" ? value : null;
  } catch {
    return null;
  }
}

export function writeMarker(marker, env = process.env) {
  const file = markerPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
}

export function clearMarker(env = process.env) {
  try {
    fs.rmSync(markerPath(env), { force: true });
  } catch {
    // Nothing to clear.
  }
}
