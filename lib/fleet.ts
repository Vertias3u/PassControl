// Canonical fleet mutations — the SINGLE implementation of the security/money-
// touching agent operations, used by BOTH the dashboard server actions and the
// public control-plane API so behavior is identical across surfaces.
//
// Every function takes a Supabase client + the acting userId and scopes every
// write by `user_id` (with the user client RLS also enforces it; with the
// service-role client this `.eq("user_id", …)` IS the tenant boundary). Returns a
// discriminated result — no throwing for expected outcomes — so each caller maps
// it to its own response (HTTP status / dashboard error).
import type { SupabaseClient } from "@supabase/supabase-js";
import { armTenantKill } from "@/lib/state/killswitch";
import { suspendAgent, unsuspendAgent, purgeAgentCaches } from "@/lib/state/redis";
// The scope bounds an elevation is checked against now live with the union that
// is checked (lib/break-glass.ts), so LIMITS is no longer read directly here.
import { validateAgentInput, validateAgentProfileInput, validateAgentUpdate, validateScopes } from "@/lib/validate";
import { PROVIDERS } from "@/lib/providers";
import { passportIdToPublicKey } from "@/lib/crypto/ed25519";
import { MAX_ROTATION_GRACE_S } from "@/lib/passport-limits";
import {
  MAX_BREAK_GLASS_TTL_S,
  MIN_BREAK_GLASS_TTL_S,
  BREAK_GLASS_REASON_MAX,
  unionScopes,
  scopeUnionExceedsBounds,
} from "@/lib/break-glass";
import type { ScopeEntry } from "@/lib/auth/visa";
import {
  directAgentKeyHash,
  directAgentKeySuffix,
  generateDirectAgentKey,
  validateDirectKeyMetadata,
} from "@/lib/auth/direct-key";

const cachePurgeProviders = () => [...PROVIDERS];

/** The 0035 namespace trigger raises this stable internal token for a
 * current-versus-retired collision; old databases surface 23505 instead. */
function passportKeyInUse(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const row = error as { code?: unknown; message?: unknown };
  return row.code === "23505" || (typeof row.message === "string" && row.message.includes("passport_key_in_use"));
}

export type FleetResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: string; message?: string };

/** Create an agent for a tenant (validates input; passport_pubkey must be unique). */
export async function createAgent(
  db: SupabaseClient,
  userId: string,
  input: unknown
): Promise<FleetResult<{ id: string; name: string; createdAt: string }>> {
  let clean;
  try {
    clean = validateAgentInput(input as any);
  } catch (e) {
    return { ok: false, status: 422, code: "invalid_request", message: (e as Error).message };
  }
  const { data, error } = await db
    .from("agents")
    .insert({
      user_id: userId,
      name: clean.name,
      passport_pubkey: clean.passportPubkey,
      allowed_scopes: clean.scopes,
      budget_tokens: clean.budget_tokens,
      budget_cents: clean.budget_cents,
    })
    // created_at comes back so onboarding can prove the new passport against calls
    // stored AFTER it existed. It has to be the database's clock — the same one that
    // stamps agent_logs.created_at — not the browser's.
    .select("id, created_at")
    .single();
  if (error) {
    // 23505 = unique_violation (passport already registered).
    if (passportKeyInUse(error)) {
      return { ok: false, status: 409, code: "agent_exists", message: "That passport is already registered." };
    }
    return { ok: false, status: 500, code: "query_failed" };
  }
  // `agents.created_at` is `not null default now()`, so a missing value here means
  // the select shape is wrong, not that the row lacks a timestamp. Refuse rather
  // than coerce: onboarding uses this as the floor that decides which stored calls
  // count as proof, and a stringified `undefined` would be a floor that compares
  // against nothing. A caller seeing query_failed retries; a caller handed a bogus
  // floor shows a false proof.
  const createdAt = data.created_at;
  if (typeof createdAt !== "string" || createdAt.length === 0) {
    return { ok: false, status: 500, code: "query_failed" };
  }
  return { ok: true, value: { id: data.id as string, name: clean.name, createdAt } };
}

type DirectKeyDatabase = Pick<SupabaseClient, "rpc">;

function firstRpcRow(data: unknown): Record<string, unknown> | null {
  const row = Array.isArray(data) ? data[0] : data;
  return typeof row === "object" && row !== null && !Array.isArray(row)
    ? (row as Record<string, unknown>)
    : null;
}

function rpcErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const row = error as { code?: unknown; message?: unknown };
  const message = typeof row.message === "string" ? row.message : "";
  if (message.includes("active_key_limit")) return "active_key_limit";
  if (message.includes("passport_key_in_use")) return "passport_key_in_use";
  return typeof row.code === "string" ? row.code : "";
}

/** Create an agent whose first authenticator is a reveal-once Direct Agent Key.
 * Agent + key are one transaction in the service-only RPC. */
export async function createDirectAgent(
  db: DirectKeyDatabase,
  userId: string,
  input: unknown
): Promise<FleetResult<{
  agentId: string;
  keyId: string;
  key: string;
  name: string;
  keyName: string;
  expiresAt: string | null;
}>> {
  let profile;
  let keyMetadata;
  try {
    const candidate = input as Record<string, unknown>;
    profile = validateAgentProfileInput(candidate);
    keyMetadata = validateDirectKeyMetadata({
      name: candidate.keyName,
      expiresAt: candidate.expiresAt,
    });
  } catch (error) {
    return { ok: false, status: 422, code: "invalid_request", message: (error as Error).message };
  }

  const key = generateDirectAgentKey();
  const { data, error } = await db.rpc("create_direct_agent", {
    p_user_id: userId,
    p_name: profile.name,
    p_scopes: profile.scopes,
    p_budget_tokens: profile.budget_tokens,
    p_budget_cents: profile.budget_cents,
    p_key_name: keyMetadata.name,
    p_key_hash: directAgentKeyHash(key),
    p_key_suffix: directAgentKeySuffix(key),
    p_expires_at: keyMetadata.expiresAt,
  });
  if (error) {
    if (rpcErrorCode(error) === "active_key_limit") {
      return { ok: false, status: 409, code: "active_key_limit", message: "This workspace has reached its active credential limit." };
    }
    return { ok: false, status: 500, code: "query_failed" };
  }
  const row = firstRpcRow(data);
  const agentId = typeof row?.agent_id === "string" ? row.agent_id : "";
  const keyId = typeof row?.key_id === "string" ? row.key_id : "";
  if (!agentId || !keyId) return { ok: false, status: 500, code: "query_failed" };
  return {
    ok: true,
    value: {
      agentId,
      keyId,
      key,
      name: profile.name,
      keyName: keyMetadata.name,
      expiresAt: keyMetadata.expiresAt,
    },
  };
}

/** Add an independently named installation credential. There is deliberately
 * no per-agent cap; the SQL enforces only the workspace abuse ceiling. */
export async function createAgentAccessKey(
  db: DirectKeyDatabase,
  userId: string,
  agentId: string,
  input: unknown
): Promise<FleetResult<{ keyId: string; key: string; name: string; expiresAt: string | null }>> {
  let metadata;
  try {
    metadata = validateDirectKeyMetadata(input as Record<string, unknown>);
  } catch (error) {
    return { ok: false, status: 422, code: "invalid_request", message: (error as Error).message };
  }
  const key = generateDirectAgentKey();
  const { data, error } = await db.rpc("create_agent_access_key", {
    p_user_id: userId,
    p_agent_id: agentId,
    p_name: metadata.name,
    p_key_hash: directAgentKeyHash(key),
    p_key_suffix: directAgentKeySuffix(key),
    p_expires_at: metadata.expiresAt,
  });
  if (error) {
    if (rpcErrorCode(error) === "active_key_limit") {
      return { ok: false, status: 409, code: "active_key_limit", message: "This workspace has reached its active credential limit." };
    }
    return { ok: false, status: 500, code: "query_failed" };
  }
  const row = firstRpcRow(data);
  const keyId = typeof row?.key_id === "string" ? row.key_id : "";
  if (!keyId) return { ok: false, status: 404, code: "not_found" };
  return { ok: true, value: { keyId, key, name: metadata.name, expiresAt: metadata.expiresAt } };
}

/** Soft-revoke one owned installation key. The raw secret cannot be recovered. */
export async function revokeAgentAccessKey(
  db: DirectKeyDatabase,
  userId: string,
  agentId: string,
  keyId: string
): Promise<FleetResult<{ keyId: string; suffix: string; name: string }>> {
  const { data, error } = await db.rpc("revoke_agent_access_key", {
    p_user_id: userId,
    p_agent_id: agentId,
    p_key_id: keyId,
  });
  if (error) return { ok: false, status: 500, code: "query_failed" };
  const row = firstRpcRow(data);
  if (!row) return { ok: false, status: 404, code: "not_found" };
  return {
    ok: true,
    value: {
      keyId: typeof row.key_id === "string" ? row.key_id : keyId,
      suffix: typeof row.key_suffix === "string" ? row.key_suffix : "",
      name: typeof row.key_name === "string" ? row.key_name : "",
    },
  };
}

/** Add passport signing to a direct-first agent without replacing any identity,
 * capability, spend, or history row. Existing Direct Agent Keys stay live. */
export async function attachAgentPassport(
  db: DirectKeyDatabase,
  userId: string,
  agentId: string,
  passportPubkeyInput: unknown
): Promise<FleetResult<{ id: string; passportPubkey: string }>> {
  const passportPubkey = typeof passportPubkeyInput === "string" ? passportPubkeyInput.trim() : "";
  if (!passportPubkey || !passportIdToPublicKey(passportPubkey)) {
    return { ok: false, status: 422, code: "invalid_request", message: "Invalid passport public key." };
  }
  const { data, error } = await db.rpc("attach_agent_passport", {
    p_user_id: userId,
    p_agent_id: agentId,
    p_passport_pubkey: passportPubkey,
  });
  if (error) {
    const code = rpcErrorCode(error);
    if (code === "passport_key_in_use" || code === "23505") {
      return { ok: false, status: 409, code: "passport_key_in_use", message: "That passport key is already registered." };
    }
    return { ok: false, status: 500, code: "query_failed" };
  }
  const row = firstRpcRow(data);
  if (typeof row?.agent_id !== "string") return { ok: false, status: 404, code: "not_found" };
  return { ok: true, value: { id: row.agent_id, passportPubkey } };
}

/** Update an agent's name / scopes / budgets (partial; tenant-scoped). */
export async function updateAgent(
  db: SupabaseClient,
  userId: string,
  agentId: string,
  patch: unknown
): Promise<FleetResult<{ id: string }>> {
  let clean;
  try {
    clean = validateAgentUpdate(patch as any);
  } catch (e) {
    return { ok: false, status: 422, code: "invalid_request", message: (e as Error).message };
  }
  if (Object.keys(clean).length === 0) {
    return { ok: false, status: 400, code: "empty_update", message: "No updatable fields provided." };
  }
  const { data, error } = await db
    .from("agents")
    .update(clean)
    .eq("user_id", userId)
    .eq("id", agentId)
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, status: 500, code: "query_failed" };
  if (!data) return { ok: false, status: 404, code: "not_found" };
  return { ok: true, value: { id: agentId } };
}

/** Suspend or resume an agent. Only active agents can be suspended, and only
 * suspended agents can resume: a revoked agent is terminal and can never be
 * reactivated through this path. */
export async function setAgentSuspended(
  db: SupabaseClient,
  userId: string,
  agentId: string,
  suspended: boolean
): Promise<FleetResult<{ id: string }>> {
  const { data: agent, error: lookupError } = await db
    .from("agents")
    .select("id, status")
    .eq("user_id", userId)
    .eq("id", agentId)
    .maybeSingle();
  if (lookupError) return { ok: false, status: 500, code: "query_failed" };
  if (!agent || agent.status === "revoked") {
    return { ok: false, status: 404, code: "not_found" };
  }

  if (suspended) {
    // Install the hot-path block before persisting the status. A Redis failure
    // therefore leaves Postgres unchanged and is surfaced to the caller; a retry
    // can safely repair an already-suspended row by re-applying this block.
    await suspendAgent(agentId);
    await purgeAgentCaches(agentId, cachePurgeProviders());
    if (agent.status !== "suspended") {
      const { data, error } = await db
        .from("agents")
        .update({ status: "suspended" })
        .eq("user_id", userId)
        .eq("id", agentId)
        .eq("status", "active")
        .select("id")
        .maybeSingle();
      if (error) return { ok: false, status: 500, code: "query_failed" };
      if (!data) return { ok: false, status: 404, code: "not_found" };
    }
  } else {
    // Persist active first. If DEL fails, the error reaches the caller; a retry
    // sees the already-active row and retries only the stale Redis cleanup.
    if (agent.status === "suspended") {
      const { data, error } = await db
        .from("agents")
        .update({ status: "active" })
        .eq("user_id", userId)
        .eq("id", agentId)
        .eq("status", "suspended")
        .select("id")
        .maybeSingle();
      if (error) return { ok: false, status: 500, code: "query_failed" };
      if (!data) return { ok: false, status: 404, code: "not_found" };
    }
    await unsuspendAgent(agentId);
  }
  return { ok: true, value: { id: agentId } };
}

/** Revoke an agent (terminal): status=revoked + suspend + purge. Keeps history. */
export async function revokeAgent(
  db: SupabaseClient,
  userId: string,
  agentId: string
): Promise<FleetResult<{ id: string }>> {
  const { data: agent, error: lookupError } = await db
    .from("agents")
    .select("id, status")
    .eq("user_id", userId)
    .eq("id", agentId)
    .maybeSingle();
  if (lookupError) return { ok: false, status: 500, code: "query_failed" };
  if (!agent) return { ok: false, status: 404, code: "not_found" };

  // Revoke is fail-closed: an owned agent is blocked and its cached keys are
  // purged before the terminal Postgres transition. Repeating revoke repairs a
  // missing Redis marker even when the durable row is already revoked.
  await suspendAgent(agentId);
  await purgeAgentCaches(agentId, cachePurgeProviders());
  if (agent.status !== "revoked") {
    const { data, error } = await db
      .from("agents")
      .update({ status: "revoked" })
      .eq("user_id", userId)
      .eq("id", agentId)
      .eq("status", agent.status)
      .select("id")
      .maybeSingle();
    if (error) return { ok: false, status: 500, code: "query_failed" };
    if (!data) return { ok: false, status: 404, code: "not_found" };
  }
  return { ok: true, value: { id: agentId } };
}

// Longest grace window a rotation may open. A window is a period in which a key
// the operator has decided to retire still works, so it is a liability measured
// in "long enough to redeploy", not in weeks. Defined in a leaf module and
// re-exported here so the rotation UI can read the same number without pulling
// this module — and Redis with it — into the browser bundle.
export { MAX_ROTATION_GRACE_S } from "@/lib/passport-limits";

/**
 * Retire this agent's passport key and install a new one, keeping the agent.
 *
 * The agent row is continuous throughout: id, budgets, agent_logs, receipts and
 * the decision trace all keep pointing at one identity. That continuity is the
 * entire reason to rotate rather than revoke-and-reissue.
 *
 * ── What this refuses, and why each one is a real mistake ───────────────────
 *
 *  - A new key equal to the current one. Not a rotation; it would retire a key
 *    and immediately reinstate it, leaving the operator believing the old key is
 *    dying when nothing changed.
 *  - A rotation while a grace window is still open. There are two key columns,
 *    so a second rotation would silently drop the FIRST retired key's remaining
 *    window — the agent still using it is locked out early, which is the failure
 *    the window exists to prevent. Refused with a distinct code so the caller
 *    can say "wait, or close the window deliberately".
 *  - A grace beyond MAX_ROTATION_GRACE_S, or a negative one.
 *  - A non-active agent. A suspended or revoked passport has nothing to rotate.
 *
 * The uniqueness of the new key is enforced by the database, not by a read
 * here: a check-then-write would race two rotations onto the same key.
 *
 * Returns the key it actually STORED, not the string it was handed. The two can
 * differ — a submitted id is trimmed before it is written — and a caller that
 * echoes its own request value into the response or the audit row asserts a key
 * that is not on the row and cannot authenticate. Every caller must report
 * `value.passportPubkey`.
 */
export async function rotatePassport(
  db: SupabaseClient,
  userId: string,
  agentId: string,
  newPassportPubkey: string,
  graceSeconds: number
): Promise<FleetResult<{ id: string; passportPubkey: string; previousValidUntil: string }>> {
  if (!passportIdToPublicKey(String(newPassportPubkey ?? "").trim())) {
    return {
      ok: false,
      status: 422,
      code: "invalid_request",
      message: "Invalid passport public key.",
    };
  }
  const newKey = String(newPassportPubkey).trim();

  if (
    typeof graceSeconds !== "number" ||
    !Number.isFinite(graceSeconds) ||
    graceSeconds < 0 ||
    graceSeconds > MAX_ROTATION_GRACE_S
  ) {
    return {
      ok: false,
      status: 422,
      code: "invalid_request",
      message: `Grace period must be between 0 and ${MAX_ROTATION_GRACE_S} seconds.`,
    };
  }

  const { data: agent, error: lookupError } = await db
    .from("agents")
    .select("id, status, passport_pubkey, previous_passport_pubkey, previous_valid_until")
    .eq("user_id", userId)
    .eq("id", agentId)
    .maybeSingle();
  if (lookupError) return { ok: false, status: 500, code: "query_failed" };
  if (!agent) return { ok: false, status: 404, code: "not_found" };
  if (agent.status !== "active") {
    return {
      ok: false,
      status: 409,
      code: "agent_not_active",
      message: "Only an active passport can be rotated.",
    };
  }
  if (agent.passport_pubkey === newKey) {
    return {
      ok: false,
      status: 409,
      code: "same_key",
      message: "That is already this agent's passport. Generate a new keypair.",
    };
  }
  if (
    agent.previous_passport_pubkey &&
    agent.previous_valid_until &&
    Date.parse(agent.previous_valid_until) > Date.now()
  ) {
    return {
      ok: false,
      status: 409,
      code: "rotation_in_progress",
      message:
        "A previous key is still inside its grace window. Wait for it to close, or end it first.",
    };
  }

  const previousValidUntil = new Date(Date.now() + graceSeconds * 1000).toISOString();
  const { data, error } = await db
    .from("agents")
    // One write: there is never a moment where the new key is live and the old
    // one has no deadline, or where the old key is retired and the new one is
    // not yet installed.
    .update({
      passport_pubkey: newKey,
      previous_passport_pubkey: agent.passport_pubkey,
      previous_valid_until: previousValidUntil,
    })
    .eq("user_id", userId)
    .eq("id", agentId)
    // Only rotate the row we actually read. A concurrent rotation that landed
    // first changes passport_pubkey, and this then matches nothing rather than
    // overwriting a key it never saw.
    .eq("passport_pubkey", agent.passport_pubkey)
    .select("id")
    .maybeSingle();
  if (error) {
    // 23505 = unique_violation: the new key is already registered somewhere,
    // as a current key or as somebody's retired one.
    if (passportKeyInUse(error)) {
      return {
        ok: false,
        status: 409,
        code: "agent_exists",
        message: "That passport is already registered.",
      };
    }
    return { ok: false, status: 500, code: "query_failed" };
  }
  if (!data) return { ok: false, status: 409, code: "rotation_conflict" };

  return { ok: true, value: { id: agentId, passportPubkey: newKey, previousValidUntil } };
}

/**
 * Set or clear a passport's expiry. `null` means never expires, which is what
 * every row holds until someone chooses otherwise.
 *
 * An expiry already in the past is refused rather than accepted: it would lock
 * the agent out on the next challenge, and an operator who meant that has
 * suspend and revoke, both of which are reversible or explicit about being
 * terminal. This is the one control here that can take a fleet offline by
 * typo.
 */
export async function setPassportExpiry(
  db: SupabaseClient,
  userId: string,
  agentId: string,
  expiresAt: string | null
): Promise<FleetResult<{ id: string; expiresAt: string | null }>> {
  let value: string | null = null;
  if (expiresAt !== null && expiresAt !== undefined) {
    const at = Date.parse(String(expiresAt));
    if (!Number.isFinite(at)) {
      return { ok: false, status: 422, code: "invalid_request", message: "Invalid expiry date." };
    }
    if (at <= Date.now()) {
      return {
        ok: false,
        status: 422,
        code: "invalid_request",
        message: "An expiry in the past would lock this agent out immediately. Use suspend instead.",
      };
    }
    value = new Date(at).toISOString();
  }

  const { data, error } = await db
    .from("agents")
    .update({ expires_at: value })
    .eq("user_id", userId)
    .eq("id", agentId)
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, status: 500, code: "query_failed" };
  if (!data) return { ok: false, status: 404, code: "not_found" };
  return { ok: true, value: { id: agentId, expiresAt: value } };
}

/**
 * Take a break-glass elevation on one agent.
 *
 * ── Every bound is enforced here, not in the form ───────────────────────────
 *
 * The TTL cap, the scope validation, the mandatory reason and the one-live-grant
 * rule all live server-side. A form-only limit is not a limit: migration 0022
 * gives `authenticated` no insert path precisely so this is the only way in, and
 * that is only worth anything if this is where the rules are.
 *
 * `scopes` goes through validateScopes — the same validator agent creation uses
 * — because these entries are minted straight into a visa with no further
 * checking. The union with the agent's stored scope is bounded here too: an
 * unbounded union is a bearer token that grows with it.
 *
 * Returns the scope document it actually STORED, for the same reason
 * rotatePassport returns the key it stored: validation trims providers and
 * patterns and drops anything it was not asked for, so a caller that records its
 * own request value instead would describe an elevation that was never granted.
 * Every caller must audit `value.scopes`.
 */
export async function grantBreakGlass(
  db: SupabaseClient,
  userId: string,
  agentId: string,
  input: { scopes: unknown; reason: unknown; ttlSeconds: unknown }
): Promise<FleetResult<{ id: string; expiresAt: string; scopes: ScopeEntry[] }>> {
  let scopes;
  try {
    scopes = validateScopes(input.scopes);
  } catch (e) {
    return { ok: false, status: 422, code: "invalid_request", message: (e as Error).message };
  }
  if (scopes.length === 0) {
    return {
      ok: false,
      status: 422,
      code: "invalid_request",
      message: "An elevation that grants nothing is not an elevation.",
    };
  }

  // Mandatory, and mandatory at the schema level too. An elevation with no
  // stated reason is an elevation nobody can review, which is the failure this
  // whole feature is built around avoiding.
  const reason = String(input.reason ?? "").trim();
  if (reason.length < 1 || reason.length > BREAK_GLASS_REASON_MAX) {
    return {
      ok: false,
      status: 422,
      code: "invalid_request",
      message: `Give a reason for this elevation (1–${BREAK_GLASS_REASON_MAX} characters).`,
    };
  }

  const ttl = Number(input.ttlSeconds);
  if (
    !Number.isFinite(ttl) ||
    !Number.isInteger(ttl) ||
    ttl < MIN_BREAK_GLASS_TTL_S ||
    ttl > MAX_BREAK_GLASS_TTL_S
  ) {
    return {
      ok: false,
      status: 422,
      code: "invalid_request",
      message: `An elevation must last between ${MIN_BREAK_GLASS_TTL_S} and ${MAX_BREAK_GLASS_TTL_S} seconds.`,
    };
  }

  const { data: agent, error: lookupError } = await db
    .from("agents")
    .select("id, status, allowed_scopes")
    .eq("user_id", userId)
    .eq("id", agentId)
    .maybeSingle();
  if (lookupError) return { ok: false, status: 500, code: "query_failed" };
  if (!agent) return { ok: false, status: 404, code: "not_found" };
  if (agent.status !== "active") {
    return {
      ok: false,
      status: 409,
      code: "agent_not_active",
      message: "Only an active agent can be elevated.",
    };
  }

  // The union is what ends up in the visa, so it is what must be bounded — not
  // the grant alone, and not by row count alone. Both documents can name one
  // provider on every row, so both can pass validateScopes while the union
  // carries thousands of patterns in a handful of rows: a bearer token too large
  // to put in an Authorization header. scopeUnionExceedsBounds checks the axes
  // that decide whether the visa can be sent.
  //
  // Checked here rather than truncated at mint, because silently dropping a
  // scope an operator is relying on mid-incident is worse than refusing the
  // grant while they can still see why.
  const stored = Array.isArray(agent.allowed_scopes) ? (agent.allowed_scopes as ScopeEntry[]) : [];
  const union = unionScopes(stored, scopes);
  const over = scopeUnionExceedsBounds(union);
  if (over) {
    // WHICH document is too big. "Narrow it" is unactionable advice mid-incident
    // when the grant was never the problem — the agent's own scope was already
    // past the bound and no elevation of any size could have been minted.
    const storedAlone = scopeUnionExceedsBounds(unionScopes(stored, []));
    return {
      ok: false,
      status: 422,
      code: "invalid_request",
      message: storedAlone
        ? `This agent's own scope is already past the limit of ${storedAlone.limit} ${storedAlone.bound} (it has ${storedAlone.actual}), so no elevation can be minted on top of it. Narrow the agent's scope first.`
        : `This elevation would take the agent past ${over.limit} ${over.bound} (it would have ${over.actual}). Narrow it.`,
    };
  }

  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
  const { data, error } = await db
    .from("break_glass_grants")
    .insert({ user_id: userId, agent_id: agentId, scopes, reason, expires_at: expiresAt })
    .select("id")
    .single();
  if (error) {
    // 23505 = the one-live-grant-per-agent index. It fires for a grant that has
    // LAPSED but not yet been swept, as well as for a genuinely live one — the
    // index predicate can only be `revoked_at is null` (Postgres refuses a
    // STABLE function there). Telling the operator to end the existing one is
    // the right instruction in both cases, and revoking an already-lapsed grant
    // is harmless.
    if ((error as { code?: string }).code === "23505") {
      return {
        ok: false,
        status: 409,
        code: "grant_exists",
        message: "This agent already has an elevation. End it before taking another.",
      };
    }
    return { ok: false, status: 500, code: "query_failed" };
  }
  return { ok: true, value: { id: data.id as string, expiresAt, scopes } };
}

/**
 * End an elevation now.
 *
 * "Now" means no NEW visa carries it. A visa already minted keeps the elevated
 * scope until it expires, because the proxy gates on the snapshot in the token
 * and never re-reads this table — which is the property that keeps break-glass
 * off the hot path entirely. Every caller of this function has to say so.
 */
export async function revokeBreakGlass(
  db: SupabaseClient,
  userId: string,
  agentId: string
): Promise<FleetResult<{ revoked: number }>> {
  const { data, error } = await db
    .from("break_glass_grants")
    .update({ revoked_at: new Date().toISOString() })
    .eq("user_id", userId) // tenant boundary
    .eq("agent_id", agentId)
    .is("revoked_at", null)
    .select("id");
  if (error) return { ok: false, status: 500, code: "query_failed" };
  return { ok: true, value: { revoked: Array.isArray(data) ? data.length : 0 } };
}

/** Arm/disarm the per-tenant master kill. It is deliberately independent of
 * per-agent suspension: disarming a tenant must never reactivate an agent that
 * was separately suspended or revoked. */
export async function setTenantKill(
  db: SupabaseClient,
  userId: string,
  on: boolean
): Promise<FleetResult<{ affected: number }>> {
  await armTenantKill(userId, on);
  const { data: agents } = await db.from("agents").select("id").eq("user_id", userId);
  return { ok: true, value: { affected: (agents ?? []).length } };
}
