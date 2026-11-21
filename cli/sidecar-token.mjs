// The sidecar's own key (review C-03, 2026-11-15).
//
// The sidecar holds the agent's passport and attaches a visa to what it forwards. It
// refuses web pages, but until this release it asked a local program for nothing, and
// a loopback port is shared by every user account on the machine. So a second user,
// or a process deliberately denied the passport file, could spend inside the agent's
// scope and budget through it.
//
// Now every forwarded call must present this key, in any header an API client puts
// its key in (Authorization Bearer, x-api-key, api-key, x-goog-api-key, or the
// password of a proxy URL). It is derived from the passport secret, so:
//   - nothing new is stored: whoever can read the passport can compute it, which is
//     exactly who may use the sidecar already;
//   - the sidecar and `passcontrol env` / `configure` compute the same value;
//   - rotating the passport changes it (re-run `passcontrol env` or `configure`).
// It is NOT a provider key and grants nothing at the gateway: the sidecar strips it
// before forwarding, like every credential header.
//
// The old public placeholder ("passcontrol-sidecar", "passcontrol") is refused: it is
// printed in the docs, so accepting it would leave the gap open.
import { createHmac, timingSafeEqual } from "node:crypto";

export const SIDECAR_KEY_PREFIX = "pcs_";
const LABEL = "passcontrol-sidecar-local-v1";

/** The key callers must present to a sidecar running with this passport secret. */
export function sidecarKey(passportSecret) {
  const secret = String(passportSecret ?? "");
  if (!secret) return null;
  return `${SIDECAR_KEY_PREFIX}${createHmac("sha256", Buffer.from(secret, "utf8")).update(LABEL).digest("base64url")}`;
}

/** Looks like a sidecar key this CLI wrote (for finding and undoing its own settings). */
export function isSidecarKey(value) {
  return typeof value === "string" && value.startsWith(SIDECAR_KEY_PREFIX);
}

const CREDENTIAL_HEADER = /(^|[-_])(api[-_]?key|authorization|auth|token|secret|credentials?)$/i;

/** Every value a caller could have meant as its key, from any credential-shaped header. */
export function presentedKeys(headers = {}) {
  const out = [];
  for (const [name, raw] of Object.entries(headers)) {
    if (!CREDENTIAL_HEADER.test(name)) continue;
    for (const value of Array.isArray(raw) ? raw : [raw]) {
      if (typeof value !== "string") continue;
      const v = value.trim();
      const space = v.indexOf(" ");
      const scheme = space > 0 ? v.slice(0, space).toLowerCase() : "";
      const rest = space > 0 ? v.slice(space + 1).trim() : v;
      if (scheme === "basic") {
        // A proxy URL's credentials (HTTP_PROXY=http://user:<key>@127.0.0.1:8788).
        let decoded = "";
        try {
          decoded = Buffer.from(rest, "base64").toString("utf8");
        } catch {
          decoded = "";
        }
        const colon = decoded.indexOf(":");
        if (colon >= 0) out.push(decoded.slice(0, colon), decoded.slice(colon + 1));
        else if (decoded) out.push(decoded);
      } else {
        // The whole value (x-api-key: <key>), and after any scheme word too:
        // "Bearer <key>", Octokit's "token <key>", discord.js's "Bot <key>".
        out.push(v);
        if (scheme) out.push(rest);
      }
    }
  }
  return out;
}

/** True when some header carries `expected`. Compared in constant time per candidate. */
export function presentsSidecarKey(headers, expected) {
  if (!expected) return false;
  const want = Buffer.from(expected, "utf8");
  let found = false;
  for (const candidate of presentedKeys(headers)) {
    const got = Buffer.from(candidate, "utf8");
    if (got.length === want.length && timingSafeEqual(got, want)) found = true;
  }
  return found;
}
