// Write authority for one command at a time (review C-01, 2026-11-15).
//
// `passcontrol login` keeps a READ-only control key, because the file it lives in also
// holds the agent's passport and the governed agent can read that file. A key there
// with write scope would let the agent act as its owner. So when a command needs to
// change something (kill off, resume, create an agent, import) and the gateway answers
// `insufficient_scope`, the CLI asks for a key for that one command: the same browser
// approval as login, which needs the owner signed in with their second factor. The
// key is held in this process's memory only, never written to disk, and revoked when
// the command ends (`releaseWriteKey`, called from bin/passcontrol.mjs on success and
// on failure).
//
// What this does NOT do: it does not stop an agent from STARTING such a command. It
// stops the command from finishing without a person approving it in the browser, and
// the approval screen names the command.
import os from "node:os";

import { approveInBrowser } from "./login.mjs";
import { step, warn } from "./config.mjs";

/** The one-command key this process holds, if any. */
let held = null;

/**
 * Ctrl-C (or a kill) while the key is held: revoke it, then exit as the signal would
 * have. Without this the key would stay live in Settings with nobody holding it.
 */
function onSignal(signal) {
  const code = signal === "SIGTERM" ? 143 : 130;
  releaseWriteKey().finally(() => process.exit(code));
}
const SIGNALS = ["SIGINT", "SIGTERM"];

/** A short label for the approval screen and the key's name: the command words only, never arguments. */
export function commandLabel(rest = []) {
  return rest.slice(0, 2).map(String).join(" ").replace(/[^A-Za-z0-9 ._-]/gu, "").trim() || "a command";
}

/** The key already approved for this origin in this process, or null. */
export function heldWriteKey(origin) {
  return held && held.origin === origin ? held.key : null;
}

/**
 * Ask the operator to approve this command in the browser, and return a write key for
 * it. Refuses at once without a terminal: nobody would see the code, so the wait could
 * only end at its ten-minute expiry.
 */
export async function obtainWriteKey(origin, {
  command = "a command",
  interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  openUrl = () => {},
  fetchImpl = fetch,
  approve = approveInBrowser,
  hostname = os.hostname(),
} = {}) {
  const existing = heldWriteKey(origin);
  if (existing) return existing;
  if (!interactive) {
    throw new Error(
      `\`passcontrol ${command}\` changes something, and this machine's control key is read-only.\n` +
        "  Run it in a terminal: it asks you to approve it in the browser.\n" +
        "  Or pass a write key from Settings for this one command: PASSCONTROL_API_KEY=<key> passcontrol …"
    );
  }
  warn(`\`passcontrol ${command}\` changes something. This machine's key is read-only, so approve it once.`);
  const grant = await approve(origin, {
    // The command first: the server keeps 60 characters, and a long hostname must not
    // cut off the part the owner is approving.
    clientName: `one command - ${command} - ${hostname}`,
    title: "Approve this command",
    // The gateway gives the key a fixed 15-minute life, so a CLI killed before it
    // revokes the key does not leave a write key behind.
    oneCommand: true,
    openUrl,
    fetchImpl,
  });
  if (!grant?.api_key) throw new Error("The approval returned no key. Nothing was changed.");
  held = { origin, key: grant.api_key, fetchImpl };
  for (const signal of SIGNALS) process.once(signal, onSignal);
  return held.key;
}

/** Revoke the one-command key, if one is held. Safe to call more than once. */
export async function releaseWriteKey() {
  if (!held) return { released: false };
  const { origin, key, fetchImpl } = held;
  held = null;
  for (const signal of SIGNALS) process.removeListener(signal, onSignal);
  try {
    const res = await fetchImpl(`${origin}/api/control/v1/keys/self/revoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
    });
    // 404 and 409 both mean it can no longer be used (see the route).
    if (res.ok || res.status === 404 || res.status === 409) return { released: true };
  } catch {
    // Reported below.
  }
  warn("Could not revoke the one-command key. It was never saved to disk;");
  step("revoke the newest \"one command\" key in Settings → API keys to be sure.");
  return { released: false };
}
