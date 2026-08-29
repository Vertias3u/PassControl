// `passcontrol login` — browser-approved credentials for this machine.
//
// The problem it removes: getting a passport onto a machine used to mean opening
// the dashboard, issuing an agent, copying two 43-character base64url strings,
// and pasting both into an interactive prompt with the secret echoed to the
// terminal. That is the friction that loses the "$5 vs. do it myself" user, and
// it produced this repo's one real incident — a passport secret pasted into a
// provider `api_key` field, rejected 401 with no audit row to explain it.
//
// ── The shape, and why it is this shape ──────────────────────────────────────
//
// RFC 8628 device flow. The CLI opens a login, prints an 8-character code,
// copies it to the clipboard, opens the browser, and polls. The operator pastes
// the code and approves once.
//
// The code travels TERMINAL → BROWSER and never the reverse, and never in a URL.
// The human moving it across IS the channel binding — it is the only evidence
// that the person at the browser is the person at the terminal. A pre-filled
// approval link removes exactly that: the attacker starts the flow on their own
// machine, keeps the device_code, sends the victim the link, and the signed-in
// victim's click hands over a write-scoped control-plane key on their own tenant.
// tests/cli-login-shape.test.ts pins the URL against that design returning.
//
// The clipboard copy is not the same thing and does not reopen it: an attacker
// cannot write to your clipboard from a link. The code reaches the browser from
// a process the operator launched on their own machine.
//
// ── Why this file exists at all, instead of living in bin/ ───────────────────
//
// It must not be able to reach the self-host clone. `openDashboard` in bin/ is
// not a URL opener — for a localhost gateway it routes through `startDashboard`,
// which is `ensureAppRoot({ clone: true })`. Putting login beside it invites the
// obvious reuse, which would make a `git clone` the second thing a Cloud user's
// first command does. This module opens URLs through `openUrl` only, and the
// test suite asserts it names neither of the cloning helpers.
import { spawn } from "node:child_process";
import os from "node:os";
import { ed25519 } from "@noble/curves/ed25519";
import fs from "node:fs";
import {
  CLOUD_GATEWAY,
  configInjectedKeys,
  configSources,
  fail,
  findProjectConfig,
  globalConfigPath,
  heading,
  mergeConfigFile,
  ok,
  requireControlGateway,
  step,
  warn,
} from "./config.mjs";
import { proveItWorks } from "./selftest.mjs";

export { CLOUD_GATEWAY };

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");

/** Display form, `FKDR-8T2W`. Presentation only — the wire form has no hyphen. */
function formatCode(code) {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

/**
 * Copy text to the OS clipboard. Resolves true on success, false on ANY failure.
 *
 * Never throws and never rejects: a clipboard is a convenience, and a login that
 * dies because a Linux box has no `wl-copy` would be a worse product than one
 * that just prints the code. The caller prints the code unconditionally and uses
 * this only to decide whether to add "(copied to your clipboard)".
 *
 * Both failure modes are handled, and they are easy to conflate:
 *   - `error`  the binary is absent. On Linux this is the COMMON case — none of
 *              wl-copy / xclip / xsel is guaranteed installed.
 *   - `close`  the binary exists and exited non-zero (no display, no Wayland
 *              socket, a wedged X server). `error` does not fire for this.
 */
export function copyToClipboard(text, { platform = process.platform } = {}) {
  const candidates =
    platform === "darwin"
      ? [["pbcopy", []]]
      : platform === "win32"
        ? [["clip", []]]
        : [
            ["wl-copy", []],
            ["xclip", ["-selection", "clipboard"]],
            ["xsel", ["--clipboard", "--input"]],
          ];

  const tryOne = (index) =>
    new Promise((resolve) => {
      const candidate = candidates[index];
      if (!candidate) return resolve(false);
      const [command, args] = candidate;
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      let child;
      try {
        child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
      } catch {
        return done(false);
      }
      child.on("error", () => done(false));
      child.on("close", (code) => done(code === 0));
      try {
        child.stdin.on("error", () => done(false));
        child.stdin.write(text);
        // pbcopy does not exit until stdin closes. A forgotten end() here hangs
        // the login on the one step that was supposed to make it effortless.
        child.stdin.end();
      } catch {
        done(false);
      }
    });

  return (async () => {
    for (let i = 0; i < candidates.length; i++) {
      if (await tryOne(i)) return true;
    }
    return false;
  })();
}

/** The approval route. Fixed here, not taken on trust from the response. */
export const APPROVAL_PATH = "/dashboard/cli";

/**
 * Decide where the browser is sent — locally, from the origin the operator
 * configured, and never from the response body alone.
 *
 * The server does send a `verification_uri`, and honouring it blindly would make
 * "where does my browser go" a value supplied over the network. Two things fall
 * out of that, both bad: a gateway that is wrong or compromised could point the
 * operator anywhere, and a future server could reintroduce the rejected
 * pre-filled `#code=` design without a single line changing in the CLI.
 *
 * So the response is accepted only if it agrees with what we would have built:
 * same origin, same path, and NO fragment or query. Anything else falls back to
 * the local construction rather than failing the login — the code still has to
 * be entered by hand either way, so a mismatch is a reason to distrust the URL,
 * not a reason to strand the operator.
 */
export function approvalUrl(origin, offered, { onMismatch = () => {} } = {}) {
  const expected = `${origin}${APPROVAL_PATH}`;
  if (offered && offered !== expected) {
    // Always the locally-built URL — the report exists so a disagreement is
    // visible rather than silently obeyed. A gateway offering a different origin,
    // a different path, or a `#code=` fragment is either misconfigured or
    // hostile, and both are worth saying out loud.
    onMismatch(String(offered));
  }
  return expected;
}

/** POST JSON with no credential attached. `login` has no key yet by definition. */
async function postJson(url, body, { timeoutMs = 15_000, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
        signal: controller.signal,
      });
    } catch (error) {
      const origin = new URL(url).origin;
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not reach the gateway at ${origin} (${detail}).`, { cause: error });
    }
    let parsed = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll until the operator approves, denies, or the login expires.
 *
 * Honours the server's `interval` and backs off on `slow_down`, so the poll rate
 * is the server's decision and can be widened without shipping a new CLI.
 */
async function pollForGrant(
  origin,
  deviceCode,
  // `now` and `wait` are a matched pair, and injecting only one is worse than
  // injecting neither: a fake clock with a real sleep still burns wall time,
  // and a real clock with a fake sleep spins the loop against a deadline that
  // never moves. TRANSPORT_GRACE_MS below is ninety REAL seconds, so a test
  // that drives the give-up path without both of these sleeps through all
  // ninety of them — which is exactly what this file used to do.
  { interval, expiresIn, fetchImpl, now = Date.now, wait = sleep }
) {
  const deadline = now() + expiresIn * 1000;
  let waitMs = Math.max(500, interval * 1000);
  // A transport failure is NOT fatal here, and this is the one place in the flow
  // where that distinction matters. By the time we are polling, the operator is
  // already looking at a code and waiting; ending the login on a single dropped
  // request costs them the whole flow and a fresh code because a packet went
  // missing or an edge function was cold. Only the deadline ends this loop.
  //
  // The `start` call above is the opposite case and stays fatal: nothing has been
  // shown to anyone yet, and an unreachable gateway there is a configuration
  // problem the operator needs told about immediately, not retried over.
  // Bounded, because "survive a blip" and "hang for ten minutes" are not the same
  // promise. A gateway that is genuinely down would otherwise leave the operator
  // watching "Still waiting…" until the 600s code expiry, which reads as a frozen
  // command. Ninety seconds of continuous failure is long enough to ride out a
  // cold start or a reconnecting VPN and short enough to still feel like an answer.
  const TRANSPORT_GRACE_MS = 90_000;
  let transportFailures = 0;
  let failingSince = 0;
  while (now() < deadline) {
    await wait(waitMs);
    let res;
    try {
      res = await postJson(`${origin}/api/auth/device/token`, { device_code: deviceCode }, { fetchImpl });
    } catch {
      // Back off like a slow_down, and say so once rather than every second — a
      // wall of identical warnings buries the code the operator still needs.
      transportFailures += 1;
      if (transportFailures === 1) {
        failingSince = now();
        warn("Lost contact with the gateway. Still waiting…");
      }
      if (now() - failingSince > TRANSPORT_GRACE_MS) {
        throw new Error(
          `Lost contact with ${origin} and could not get it back. ` +
            "Check the gateway is up, then run `passcontrol login` again."
        );
      }
      waitMs = Math.min(waitMs * 2, 10_000);
      continue;
    }
    if (transportFailures > 0) {
      ok("reconnected");
      transportFailures = 0;
      failingSince = 0;
      waitMs = Math.max(500, interval * 1000);
    }
    if (res.status === 200 && res.body?.api_key) return res.body;
    const error = res.body?.error;
    if (error === "access_denied") {
      throw new Error("Login was denied in the browser. Nothing was created.");
    }
    if (error === "expired_token") {
      throw new Error("That login expired before it was approved. Run `passcontrol login` again.");
    }
    // slow_down is the server asking for room; anything else unexpected gets the
    // same treatment rather than a tight retry loop against an unhealthy host.
    if (error === "slow_down" || res.status >= 500) waitMs = Math.min(waitMs * 2, 10_000);
  }
  throw new Error("Timed out waiting for approval. Run `passcontrol login` again.");
}

/** Authenticated control-plane call, using the key this flow just collected. */
async function control(origin, apiKey, method, path, body, fetchImpl = fetch) {
  const res = await fetchImpl(`${origin}/api/control/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const parsed = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Control plane refused ${method} ${path} (${res.status}).`);
  }
  // Every control route answers `{ data: ... }` (lib/control/respond.ts), and
  // bin/passcontrol.mjs's own `api()` has always unwrapped it. This helper did
  // not, and the callers below then reached for `.agents` and `.id` one level
  // too high — so the agent list was permanently empty and a created agent's id
  // was permanently undefined. Unwrapped HERE rather than at each call site, so
  // the next route this file consumes cannot reintroduce it.
  return parsed && typeof parsed === "object" && "data" in parsed ? parsed.data : parsed;
}

/**
 * Warn when the file we are about to write will NOT be the one that wins.
 *
 * `cli/config.mjs` resolves env → nearest project `.passcontrol` → global. A
 * user with a project config in cwd would otherwise see "✓ Wrote
 * ~/.config/passcontrol/config" and then watch `passcontrol call` keep using the
 * old passport — right result, wrong file wins, and nothing visibly broken.
 */
function warnIfShadowed(target, { cwd = process.cwd() } = {}) {
  if (target !== globalConfigPath()) return false;
  const project = findProjectConfig(cwd);
  if (!project) return false;
  warn(`A project config at ${project} takes priority over the file just written.`);
  step("Commands run from this directory will keep using it. Use --project to write there instead.");
  return true;
}

/**
 * Refuse to destroy a working passport without being told to.
 *
 * `mergeConfigFile` preserves PROVIDER and MODEL, but it necessarily REPLACES
 * PASSPORT_ID and PASSPORT_SECRET — and PassControl has never held a copy of
 * that private key, so overwriting it is unrecoverable. `init` has always asked
 * before clobbering a config; a command designed to be run casually must ask at
 * least as loudly.
 *
 * Defaults to NO. The safe answer is the one you get by pressing enter, because
 * the cost of a stray yes here is an agent that silently stops authenticating on
 * every other machine that shared the passport.
 */
async function confirmReplacingPassport(target, confirm) {
  let existing = "";
  try {
    existing = fs.readFileSync(target, "utf8");
  } catch {
    return true; // Nothing there. Nothing to lose.
  }
  const current = /^PASSPORT_SECRET=(.+)$/mu.exec(existing)?.[1]?.trim();
  if (!current) return true;

  warn(`${target} already holds a passport secret.`);
  step("Continuing replaces it, and PassControl has no copy — anything still using that");
  step("passport keeps working only until you revoke or rotate the agent behind it.");
  return confirm("Replace it? [y/N] ", { default: false });
}

/**
 * Resolve login's destination without inheriting the ordinary localhost fallback.
 *
 * An explicit flag wins, then an environment/config value, then Cloud. Other
 * commands keep DEFAULT_GATEWAY because they may intentionally operate a local
 * stack; login is the exception because it is designed to run before any config
 * exists. requireControlGateway keeps the existing bare-origin and HTTPS rules.
 */
export function resolveLoginGateway(opts = {}, env = process.env) {
  const fromFlag = typeof opts.gateway === "string" ? opts.gateway.trim() : "";
  const fromConfig = typeof env.PASSCONTROL_GATEWAY === "string"
    ? env.PASSCONTROL_GATEWAY.trim()
    : "";
  return requireControlGateway({ gateway: fromFlag || fromConfig || CLOUD_GATEWAY });
}

/**
 * WHERE the destination came from — so a failure can name something editable.
 *
 * This exists because the honest answer is not "the environment". cli/config.mjs
 * injects config-file values into `process.env` at import, so by the time
 * resolveLoginGateway reads PASSCONTROL_GATEWAY the shell and a file on disk are
 * indistinguishable — and an error telling someone to "unset PASSCONTROL_GATEWAY"
 * when their value lives in `~/.config/passcontrol/config` is instructing them to
 * change something that is not set. They run it, nothing moves, and the CLI looks
 * broken rather than merely configured. Reported from a real machine on 0.7.1.
 *
 * `configInjectedKeys` is the same set cli/config.mjs keeps so that "a file said
 * so" and "the operator said so" stay separable for credentials. This is that
 * distinction applied to advice.
 *
 * The file search takes the LAST match, not the first. applyConfigSourcesToEnv
 * pushes global then project and Object.assign()es in order, so a project
 * `.passcontrol` overwrites the global config — and `.find()` would confidently
 * name a file whose value never reached the environment.
 */
export function gatewaySource(
  opts = {},
  env = process.env,
  { sources = configSources, injected = configInjectedKeys } = {}
) {
  if (typeof opts.gateway === "string" && opts.gateway.trim()) return { from: "flag" };
  if (typeof env.PASSCONTROL_GATEWAY === "string" && env.PASSCONTROL_GATEWAY.trim()) {
    if (!injected.has("PASSCONTROL_GATEWAY")) return { from: "env" };
    const file = [...sources]
      .reverse()
      .find((source) => "PASSCONTROL_GATEWAY" in (source?.values ?? {}));
    return file ? { from: "file", path: file.path } : { from: "env" };
  }
  return { from: "default" };
}

export async function loginCommand(opts = {}, deps = {}) {
  const fetchImpl = deps.fetch ?? fetch;
  const openUrl = deps.openUrl ?? (() => {});
  const confirm = deps.confirmYes ?? (async (_q, o = {}) => o.default !== false);
  const promptLine = deps.promptLine ?? (async (_q, fallback) => fallback);
  // Only the poll loop reads these, and only a test passes them. Kept on `deps`
  // beside `fetch` rather than on `opts`, because they are seams for the caller,
  // not options for the operator — there is no flag that makes login lie about
  // the time.
  const now = deps.now ?? Date.now;
  const wait = deps.sleep ?? sleep;

  // Validate the destination BEFORE anything is requested — the ordering mintVisa
  // uses. A rejected gateway must cost zero sockets.
  const origin = resolveLoginGateway(opts);

  const clientName = String(opts.name || os.hostname() || "this machine");
  let started;
  try {
    started = await postJson(
      `${origin}/api/auth/device/start`,
      { client_name: clientName },
      { fetchImpl }
    );
  } catch (error) {
    // postJson has already named the host and kept the underlying failure on
    // `cause`. This adds the part a first-run operator actually needs: what to do
    // about it. Read `cause`, not `error.name` — the error reaching here is
    // postJson's plain wrapper, so testing `error.name` for "AbortError" would
    // never be true and the timeout wording would be dead code.
    const underlying = error?.cause ?? error;
    const reason = underlying?.name === "AbortError" ? "timed out" : "could not be reached";
    // Name the place BEFORE offering the remedy — that is the whole job of
    // gatewaySource above. The default origin is nobody's mistake, and blaming a
    // config file that never mentions a gateway sends the operator to edit a line
    // that is not there.
    const source = gatewaySource(opts);
    const lines = [`${origin} ${reason} (${underlying?.message ?? "unknown"}).`];
    if (source.from === "file") {
      lines.push(`  That origin comes from ${source.path}, not from your shell.`);
      lines.push(`  Edit or delete its PASSCONTROL_GATEWAY line to change it.`);
    } else if (source.from === "env") {
      lines.push(`  That origin comes from PASSCONTROL_GATEWAY in your shell.`);
    }
    if (source.from === "default") {
      lines.push(`  • Self-hosting? Start your stack, then pass --gateway <origin>.`);
      lines.push(`  • Otherwise check your connection and run the command again.`);
    } else {
      lines.push(`  • Self-hosting? Start your stack, or pass --gateway <origin>.`);
      lines.push(`  • Meant to use Cloud? passcontrol login --gateway ${CLOUD_GATEWAY}`);
    }
    throw new Error(lines.join("\n"), { cause: error });
  }
  if (started.status !== 200 || !started.body?.user_code) {
    throw new Error(
      `${origin} answered ${started.status} to the login request. ` +
        `If that origin is a PassControl instance, it may be older than this CLI.`
    );
  }
  const { device_code: deviceCode, user_code: userCode } = started.body;
  const verificationUri = approvalUrl(origin, started.body.verification_uri, {
    onMismatch: () => warn("The gateway offered a different approval URL. Using the configured origin."),
  });

  // Print FIRST and unconditionally. Only the suffix depends on the clipboard —
  // a headless box that says "copied to your clipboard" with nothing to paste is
  // worse than one that never mentioned a clipboard at all.
  const copied = await copyToClipboard(userCode);
  console.log("");
  console.log(heading("Approve this machine"));
  console.log(`  Code: ${formatCode(userCode)}${copied ? "   (copied to your clipboard)" : ""}`);
  console.log(`  Open: ${verificationUri}`);
  console.log("");
  step("Paste the code there and press Approve. Waiting…");
  openUrl(verificationUri);

  const grant = await pollForGrant(origin, deviceCode, {
    interval: Number(started.body.interval ?? 1),
    expiresIn: Number(started.body.expires_in ?? 600),
    fetchImpl,
    now,
    wait,
  });
  ok("approved");

  // ── Provision a passport for this machine ─────────────────────────────────
  //
  // The keypair is generated HERE and only the PUBLIC half is sent. The gateway
  // has never held a passport private key; this command must not be the first
  // thing to change that.
  const agents = (await control(origin, grant.api_key, "GET", "/agents", null, fetchImpl)) ?? [];
  let agentId = null;
  if (agents.length > 0 && !opts.new) {
    step(`This workspace has ${agents.length} agent(s).`);
    const existing = await promptLine("Agent id to reuse, or blank to create a new one: ", "");
    if (existing) {
      // Reusing means ROTATING, and rotation is not free — say so before doing it.
      warn(`PassControl has never held that agent's private key, so this machine cannot be given`);
      step(`the existing one. Continuing rotates it: any other machine using that passport stops`);
      step(`working once the grace window lapses.`);
      if (await confirm("Create a NEW agent for this machine instead? [Y/n] ")) agentId = null;
      else agentId = existing;
    }
  }

  const priv = ed25519.utils.randomPrivateKey();
  const passportId = b64url(ed25519.getPublicKey(priv));
  const passportSecret = b64url(priv);

  if (agentId) {
    await control(origin, grant.api_key, "POST", `/agents/${encodeURIComponent(agentId)}/rotate`, {
      passportPubkey: passportId,
    }, fetchImpl);
    ok(`rotated passport for agent ${agentId}`);
  } else {
    const created = await control(origin, grant.api_key, "POST", "/agents", {
      name: clientName,
      passportPubkey: passportId,
      // The demo scope is what makes `proveItWorks` below possible, and it is
      // here rather than added-then-removed for one reason: a brand-new tenant
      // has NO provider key in Vault, so the keyless demo provider is the only
      // call this agent can legally make on its first day. It reaches a
      // synthesized response, never `get_provider_key`, and never forwards
      // anywhere — so it grants no spend and no upstream reach. It also leaves
      // every agent able to self-test forever, which `doctor` can lean on.
      scopes: [
        { provider: "demo", models: ["*"] },
        { provider: "anthropic", models: ["claude-*"] },
      ],
    }, fetchImpl);
    agentId = created?.id ?? null;
    ok(`created agent ${created?.name ?? clientName}`);
  }

  // MERGE, never a full write. writeConfigFile emits every CONFIG_KEY, so a
  // three-key write would blank PROVIDER, MODEL and PASSCONTROL_GATEWAY — right
  // result, wrong side effect, invisible until the next call hit the wrong
  // provider.
  const target = opts.project ? `${process.cwd()}/.passcontrol` : globalConfigPath();
  if (!(await confirmReplacingPassport(target, confirm))) {
    // The agent and its key were already created server-side, so say what exists
    // rather than pretending nothing happened. Leaving the operator with an
    // orphaned agent AND no explanation would be the worse failure.
    warn("Left the existing config unchanged.");
    step(`The new passport was NOT saved. Agent ${agentId ?? "(unknown)"} and the key`);
    step(`"CLI on ${clientName}" now exist unused — revoke them in Settings.`);
    return { agentId, passportId, target: null };
  }
  mergeConfigFile(target, {
    PASSCONTROL_GATEWAY: origin,
    PASSPORT_ID: passportId,
    PASSPORT_SECRET: passportSecret,
    PASSCONTROL_API_KEY: grant.api_key,
  });
  ok(`wrote ${target}`);
  warnIfShadowed(target);

  step("");
  const proof = await proveItWorks({
    origin,
    passportId,
    passportSecret,
    apiKey: grant.api_key,
    fetchImpl,
  });

  step("");
  step(`The key is listed in Settings as "CLI on ${clientName}" and can be revoked there.`);
  return { agentId, passportId, target, proof };
}
