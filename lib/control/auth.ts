// Control-plane authentication: resolve a developer API key from the request to
// its owner + scope. The key arrives as `Authorization: Bearer pc_…`; we hash it
// and look the row up by hash (service role — the key table is not client-readable
// by hash). A missing/malformed/unknown/revoked key is rejected with a single
// generic 401 (no enumeration). On success we record last-used best-effort.
import { serviceClient } from "@/lib/supabase";
import { hashApiKey, isApiKeyFormat } from "@/lib/apikeys";

export type Scope = "read" | "write";

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
    .select("id, user_id, scope, revoked_at")
    .eq("key_hash", hash)
    .maybeSingle();
  if (error) return { ok: false, status: 500, code: "auth_lookup_failed" };
  // Not found and revoked are indistinguishable to the caller (no enumeration).
  if (!data || data.revoked_at) return { ok: false, status: 401, code: "invalid_api_key" };

  // Best-effort last-used stamp; never blocks or throws into the request path.
  void db
    .from("api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", data.id)
    .then(
      () => {},
      () => {}
    );

  return { ok: true, userId: data.user_id, scope: data.scope as Scope, keyId: data.id };
}
