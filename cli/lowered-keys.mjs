// The stored control key, lowered to read-only once per install (owner 2026-11-15,
// review C-01 follow-up). bin/passcontrol.mjs calls lowerStoredKeyOnce before the first
// control call of a command; `passcontrol login` calls rememberReadKey for the key it
// has just saved read-only, so a fresh login never asks the gateway again.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// ── Keys saved by a login from before this release (owner 2026-11-15) ────────────
//
// Those still have write scope. Before such a key is used for anything, it is lowered
// to read, once per install: the lowered key's hash (never the key) is kept in
// `lowered-keys.json` beside the CLI's other caches. A key passed in the shell
// (PASSCONTROL_API_KEY=… passcontrol …) is never lowered: that is how an owner makes
// one change without the browser, on purpose.

/** Beside the CLI's other caches, in the global config's folder. */
export function loweredKeysFile(globalConfig) {
  return path.join(path.dirname(globalConfig), "lowered-keys.json");
}

const digestOf = (key) => createHash("sha256").update(String(key)).digest("hex").slice(0, 32);

function readLowered(stateFile) {
  try {
    const list = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return Array.isArray(list) ? list.filter((d) => typeof d === "string") : [];
  } catch {
    return [];
  }
}

/** Note that `key` is known to be read-only (login saved it that way, or it was just lowered). */
export function rememberReadKey(key, stateFile) {
  if (!key) return;
  const list = readLowered(stateFile);
  const digest = digestOf(key);
  if (list.includes(digest)) return;
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(stateFile, `${JSON.stringify([...list, digest].slice(-50))}\n`, { mode: 0o600 });
  } catch {
    // Best effort: without the note the next command asks the gateway again.
  }
}

/**
 * Lower the stored key to read unless this install already knows it is. Returns
 * `{ lowered: true }` only when the gateway confirmed it. Anything else (an older
 * gateway without the route, a revoked key, no network) changes nothing here and is
 * tried again next time; the command then runs as it would have.
 */
export async function lowerStoredKeyOnce({ origin, key, stateFile, fetchImpl = fetch }) {
  if (!key || readLowered(stateFile).includes(digestOf(key))) return { lowered: false };
  try {
    const res = await fetchImpl(`${origin}/api/control/v1/keys/self/downgrade`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
    });
    await res.text().catch(() => "");
    if (!res.ok) return { lowered: false };
  } catch {
    return { lowered: false };
  }
  rememberReadKey(key, stateFile);
  return { lowered: true };
}
