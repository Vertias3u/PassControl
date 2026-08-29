// `passcontrol logout` — undo a login, on both sides.
//
// Until now there was no way to undo `passcontrol login`, and no CLI path to
// revoke a control key at all: `revokeApiKey` is a dashboard action. The manual
// equivalent was two halves nobody remembers as a pair — revoke the key in
// Settings AND delete the config — and doing one without the other leaves either
// a live write-scoped key on the tenant (create/suspend/revoke agents, rotate
// passports, arm the kill switch) or a passport private key sitting on disk.
//
// ── The ordering here is policy ─────────────────────────────────────────────
//
// resolve → look up the agent → decide about the agent → revoke the agent →
// revoke the control key → blank the file.
//
// The control key is revoked LAST because it is the credential doing all of the
// work above; revoking it first turns every remaining step into a 401. The file
// is blanked last of all, and — this is the part worth stating — it is blanked
// EVEN IF the server steps failed. The operator asked to log out. Deciding on
// their behalf that a live key elsewhere is a reason to leave a private key on
// their disk gets the trade backwards; the honest response is to clear the
// machine and say plainly that the key is still live.
import fs from "node:fs";
import path from "node:path";
import {
  CONFIG_FILE,
  config,
  configSources,
  globalConfigPath,
  mergeConfigFile,
  ok,
  requireControlGateway,
  step,
  warn,
} from "./config.mjs";

/**
 * The file that ACTUALLY holds the passport, not the one login would have
 * written today.
 *
 * Mirroring login's `--project ? cwd : global` choice would be the obvious
 * implementation and the wrong one: a user who logged in with `--project` and
 * then runs a bare `logout` would be told their machine was cleared while the
 * project `.passcontrol` still authenticates. That is `warnIfShadowed`'s failure
 * in reverse — right result, wrong file — and it is worse here, because the
 * whole point of the command is that nothing is left behind.
 *
 * `configSources` is pushed global-then-project and merged in that order, so the
 * LAST source defining the key is the one that wins at resolution time.
 */
export function credentialFile(opts = {}, { sources = configSources, cwd = process.cwd() } = {}) {
  if (opts.project) return path.join(cwd, CONFIG_FILE);
  if (opts.global) return globalConfigPath();
  const holder = [...sources]
    .reverse()
    .find((source) => String(source?.values?.PASSPORT_SECRET ?? "").trim());
  return holder?.path ?? null;
}

async function control(origin, apiKey, method, route, fetchImpl) {
  const res = await fetchImpl(`${origin}/api/control/v1${route}`, {
    method,
    headers: { authorization: `Bearer ${apiKey}` },
  });
  const parsed = await res.json().catch(() => null);
  if (!res.ok) {
    const error = new Error(`${method} ${route} answered ${res.status}`);
    error.status = res.status;
    error.code = parsed?.error ?? null;
    throw error;
  }
  // `{ data: ... }` — see lib/control/respond.ts and the note in cli/login.mjs.
  // Reading the envelope instead of the payload is why the first real run of
  // this command could not name the agent it was logging out of.
  return parsed && typeof parsed === "object" && "data" in parsed ? parsed.data : parsed;
}

export async function logoutCommand(opts = {}, deps = {}) {
  const fetchImpl = deps.fetch ?? fetch;
  const confirm = deps.confirmYes ?? (async (_q, o = {}) => o.default !== false);
  const warnings = [];

  const target = credentialFile(opts);
  if (!target || !fs.existsSync(target)) {
    step("No passport is configured on this machine, so there is nothing to clear.");
    return { target: null, keyRevoked: false, agentRevoked: false, agent: null, warnings };
  }

  // ── Ask before destroying the passport, BEFORE touching anything ─────────
  //
  // `login` and `logout` differ by ONE CHARACTER, and only one of them asks.
  // That asymmetry is not theoretical: this guard exists because a `logout` run
  // as a smoke test, against the real config rather than an isolated one,
  // blanked a working Cloud passport in the time it took to press enter.
  // PassControl has never held that private key, so nothing could give it back.
  //
  // It sits here — ahead of every server call — rather than beside the write it
  // guards. Confirming later would mean a declined logout that had already
  // revoked the control key and possibly the agent: a half state the operator
  // never asked for and cannot easily read. Answering "no" to a destructive
  // prompt should mean nothing happened, so nothing has yet.
  if (!opts.yes) {
    const holdsPassport = /^PASSPORT_SECRET=(.+)$/mu.exec(fs.readFileSync(target, "utf8"))?.[1]?.trim();
    if (holdsPassport) {
      warn(`${target} holds a passport secret, and PassControl has no copy of it.`);
      step("Clearing it is permanent — anything still using that passport keeps working, but");
      step("this machine can never authenticate as it again.");
      if (!(await confirm("Log out of this machine? [y/N] ", { default: false }))) {
        step("Left everything as it was.");
        return { target: null, keyRevoked: false, agentRevoked: false, agent: null, warnings, cancelled: true };
      }
    }
  }

  // Validated before any socket opens, the ordering every other command uses. A
  // logout aimed at a rejected origin must cost zero requests.
  const origin = config.apiKey ? requireControlGateway(config) : null;
  const apiKey = config.apiKey;

  // ── Which agent is this passport? ─────────────────────────────────────────
  // The config holds a PUBLIC key, not an agent id, so the name has to be looked
  // up — and it has to happen while the control key still works. Best effort: a
  // failure here costs the operator a name, not their logout.
  let agent = null;
  if (origin && apiKey && config.passportId) {
    try {
      const listed = (await control(origin, apiKey, "GET", "/agents", fetchImpl)) ?? [];
      agent = listed.find((row) => row?.passport_pubkey === config.passportId) ?? null;
    } catch {
      warnings.push("Could not list agents, so this could not name the agent behind the passport.");
    }
  }

  // ── The agent itself ──────────────────────────────────────────────────────
  // Default NO, and not out of timidity: clearing this file destroys the only
  // copy of that agent's private key, but a copy may well exist in a project
  // `.passcontrol`, a password manager, or a CI secret. Revoking on a hunch
  // stops something the operator did not ask to stop.
  let agentRevoked = false;
  if (agent && !opts.keepAgent) {
    const wanted =
      opts.revokeAgent === true ||
      (await confirm(
        `Also revoke agent "${agent.name}"? It can never authenticate again. [y/N] `,
        { default: false }
      ));
    if (wanted) {
      try {
        await control(origin, apiKey, "POST", `/agents/${encodeURIComponent(agent.id)}/revoke`, fetchImpl);
        agentRevoked = true;
        ok(`revoked agent ${agent.name}`);
      } catch {
        warnings.push(`Could not revoke agent "${agent.name}" — do it in the Control Tower.`);
      }
    }
  }

  // ── The control key ───────────────────────────────────────────────────────
  // Self-revoke: the route takes no id and revokes whatever key authenticated,
  // so this cannot reach another key even by accident.
  let keyRevoked = false;
  if (origin && apiKey) {
    try {
      await control(origin, apiKey, "POST", "/keys/self/revoke", fetchImpl);
      keyRevoked = true;
      ok("revoked this machine's control key");
    } catch (error) {
      // 409 `already_revoked` and 404 `not_found` both mean the key cannot be
      // used again — the route conflates missing and revoked on purpose so that
      // another tenant's id stays indistinguishable from absence. Reporting
      // "STILL LIVE" for either would send the operator to Settings to revoke a
      // key that is not there, and teach them to distrust the message on the one
      // occasion it is true.
      if (error?.status === 409 || error?.status === 404) {
        keyRevoked = true;
        ok("this machine's control key was already revoked");
      } else {
        warnings.push(
          "Could not revoke the control key — it is STILL LIVE. Revoke it in Settings → API keys."
        );
      }
    }
  }

  // ── The machine ───────────────────────────────────────────────────────────
  // Blank, never delete, and never a full write: PROVIDER, MODEL and the gateway
  // are not credentials and the operator did not ask to lose them. `mergeConfigFile`
  // spreads over what is already there, and writeConfigFile emits `?? ""` for every
  // key, so an empty string is the supported way to clear one.
  mergeConfigFile(target, { PASSPORT_ID: "", PASSPORT_SECRET: "", PASSCONTROL_API_KEY: "" });
  ok(`cleared the credentials in ${target}`);

  for (const line of warnings) warn(line);
  if (agent && !agentRevoked) {
    step(`Agent "${agent.name}" is still listed, and this machine no longer holds its passport.`);
  }
  step("Log back in any time with `passcontrol login`.");

  return { target, keyRevoked, agentRevoked, agent, warnings };
}
