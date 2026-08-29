// Control-plane authentication: resolve a developer API key from the request to
// its owner + scope. The key arrives as `Authorization: Bearer pc_…`; we hash it
// and look the row up by hash (service role — the key table is not client-readable
// by hash). A missing/malformed/unknown/revoked key is rejected with a single
// generic 401 (no enumeration). On success we record last-used best-effort.
import { serviceClient } from "@/lib/supabase";
import { hashApiKey, isApiKeyFormat } from "@/lib/apikeys";

export type Scope = "read" | "write";

/**
 * How long a control key survives without being used.
 *
 * Rolling, not absolute. A key in daily use never expires, because a key someone
 * is actively using is a key someone would notice losing; an absolute cap would
 * break working CI on a schedule and buy nothing for it. What this retires is the
 * decommissioned laptop — which is the threat `passcontrol login` created by
 * minting a write-scoped key per machine.
 */
export const IDLE_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

export type AuthResult =
  | { ok: true; userId: string; scope: Scope; keyId: string }
  | { ok: false; status: number; code: string };

export async function authenticateApiKey(req: Request): Promise<AuthResult> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!token) return { ok: false, status: 401, code: "missing_api_key" };
  // Cheap shape filter before the hash + DB lookup.
  if (!isApiKeyFormat(token)) return { ok: false, status: 401, code: "invalid_api_key" };

  const hash = await hashApiKey(token);
  const db = serviceClient();
  const { data, error } = await db
    .from("api_keys")
    .select("id, user_id, scope, revoked_at, expires_at")
    .eq("key_hash", hash)
    .maybeSingle();
  if (error) return { ok: false, status: 500, code: "auth_lookup_failed" };
  // Not found, revoked and expired are all indistinguishable to the caller.
  //
  // A distinct `expired_api_key` would confirm to an unauthenticated caller that
  // a guessed key had once existed — the same enumeration oracle the revoked
  // branch has always refused to be. The operator learns which it is from the
  // dashboard, where they are already authenticated.
  if (!data || data.revoked_at) return { ok: false, status: 401, code: "invalid_api_key" };
  const expiresAt = data.expires_at ? Date.parse(data.expires_at) : null;
  // `null` means never expires, and every key predating migration 0041 is null —
  // adding the column must not retire anything anyone is already using. An
  // UNPARSEABLE value is treated as expired rather than as absent: a column this
  // one reads for an authentication decision must fail closed on nonsense.
  if (data.expires_at != null && (!Number.isFinite(expiresAt) || (expiresAt as number) <= Date.now())) {
    return { ok: false, status: 401, code: "invalid_api_key" };
  }

  // Best-effort last-used stamp; never blocks or throws into the request path.
  //
  // The expiry rides along with it, and only for a key that already HAS one. Two
  // things follow, both deliberate:
  //
  //   a key with no expiry is never given one by being used — the window is a
  //     property of how the key was minted, not something authentication decides;
  //   the push happens only past the refusals above, so a probe against a dead
  //     key cannot keep it alive for another window, which would make the expiry
  //     unreachable in exactly the abandoned-machine case it exists for.
  void db
    .from("api_keys")
    .update({
      last_used_at: new Date().toISOString(),
      ...(data.expires_at ? { expires_at: new Date(Date.now() + IDLE_WINDOW_MS).toISOString() } : {}),
    })
    .eq("id", data.id)
    .then(
      () => {},
      () => {}
    );

  return { ok: true, userId: data.user_id, scope: data.scope as Scope, keyId: data.id };
}
