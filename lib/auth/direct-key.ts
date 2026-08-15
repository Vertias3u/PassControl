// Direct Agent Keys are the lower-assurance, pasteable Cloud on-ramp.
//
// They are deliberately NOT passports and never mint visas. A successful
// lookup proves possession of one high-entropy bearer credential and derives
// the tenant, agent, scopes, and budget from one service-only database RPC.
// The raw credential is never stored or included in observability context.
import { sha256 } from "@noble/hashes/sha256";
import type { SupabaseClient } from "@supabase/supabase-js";

import { parseGrantScopes, unionScopes } from "@/lib/break-glass";
import { bytesToBase64url, utf8ToBytes } from "@/lib/encoding";
import type { ScopeEntry } from "@/lib/auth/visa";

export const DIRECT_AGENT_KEY_PREFIX = "pc_agent_";
export const DIRECT_AGENT_KEY_NAME_MAX = 80;
const DIRECT_AGENT_KEY_SECRET_LENGTH = 43;
const DIRECT_AGENT_KEY_RE = /^pc_agent_[A-Za-z0-9_-]{43}$/;

export type GatewayCredential =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "passport"; token: string }
  | { kind: "direct_key"; token: string };

export interface DirectKeyPrincipal {
  kind: "direct_key";
  keyId: string;
  agentId: string;
  userId: string;
  scopes: ScopeEntry[];
  budgetTokens: number | null;
  budgetCents: number | null;
  spentTokens: number;
  spentMicrocents: number;
}

type DirectKeyDatabase = Pick<SupabaseClient, "rpc">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteInteger(value: unknown, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function nullableInteger(value: unknown): number | null {
  return value === null ? null : finiteInteger(value);
}

export function generateDirectAgentKey(): string {
  const secret = new Uint8Array(32);
  crypto.getRandomValues(secret);
  return `${DIRECT_AGENT_KEY_PREFIX}${bytesToBase64url(secret)}`;
}

export function directAgentKeyHash(key: string): string {
  return bytesToBase64url(sha256(utf8ToBytes(key)));
}

/**
 * A token beginning with the Direct namespace must have the exact key shape.
 * It never falls through to the visa verifier: that would turn a malformed
 * direct key into an expensive symmetric-signature attempt and muddle errors.
 */
export function classifyGatewayCredential(token: string): GatewayCredential {
  const value = String(token ?? "").trim();
  if (!value) return { kind: "missing" };
  if (value.startsWith(DIRECT_AGENT_KEY_PREFIX)) {
    return DIRECT_AGENT_KEY_RE.test(value)
      ? { kind: "direct_key", token: value }
      : { kind: "invalid" };
  }
  return { kind: "passport", token: value };
}

/**
 * One uncached, indexed lookup. Revocation therefore bites on the next call.
 * Database errors throw so the gateway can answer 503; an unknown/revoked/
 * expired key is an ordinary null and answers the same generic 401.
 */
export async function authenticateDirectAgentKey(
  db: DirectKeyDatabase,
  key: string
): Promise<DirectKeyPrincipal | null> {
  const { data, error } = await db.rpc("authenticate_direct_agent_key", {
    p_key_hash: directAgentKeyHash(key),
  });
  if (error) throw new Error("direct_key_lookup_failed");

  const row = Array.isArray(data) ? data[0] : data;
  if (!isRecord(row)) return null;
  const keyId = typeof row.key_id === "string" ? row.key_id : "";
  const agentId = typeof row.agent_id === "string" ? row.agent_id : "";
  const userId = typeof row.user_id === "string" ? row.user_id : "";
  if (!keyId || !agentId || !userId) return null;

  const base = parseGrantScopes(row.allowed_scopes);
  const elevated = parseGrantScopes(row.break_glass_scopes);
  return {
    kind: "direct_key",
    keyId,
    agentId,
    userId,
    scopes: unionScopes(base, elevated),
    budgetTokens: nullableInteger(row.budget_tokens),
    budgetCents: nullableInteger(row.budget_cents),
    spentTokens: finiteInteger(row.spent_tokens),
    spentMicrocents: finiteInteger(row.spent_microcents),
  };
}

export function directAgentKeySuffix(key: string): string {
  if (!DIRECT_AGENT_KEY_RE.test(key)) throw new Error("invalid_direct_agent_key");
  return key.slice(-8);
}

export function isDirectAgentKey(value: string): boolean {
  return DIRECT_AGENT_KEY_RE.test(value) && value.length === DIRECT_AGENT_KEY_PREFIX.length + DIRECT_AGENT_KEY_SECRET_LENGTH;
}

export interface DirectKeyMetadata {
  name: string;
  expiresAt: string | null;
}

/** Optional expiry is deliberate: an unattended agent must not become a
 * scheduled outage merely because nobody opened the dashboard that week. */
export function validateDirectKeyMetadata(input: {
  name?: unknown;
  expiresAt?: unknown;
}): DirectKeyMetadata {
  const name = typeof input?.name === "string" ? input.name.trim() : "";
  if (!name || name.length > DIRECT_AGENT_KEY_NAME_MAX) {
    throw new Error(`Installation name must be 1–${DIRECT_AGENT_KEY_NAME_MAX} characters.`);
  }

  if (input.expiresAt === undefined || input.expiresAt === null || input.expiresAt === "") {
    return { name, expiresAt: null };
  }
  if (typeof input.expiresAt !== "string") throw new Error("Invalid credential expiry.");
  const timestamp = Date.parse(input.expiresAt);
  if (!Number.isFinite(timestamp) || timestamp <= Date.now()) {
    throw new Error("Credential expiry must be in the future.");
  }
  return { name, expiresAt: new Date(timestamp).toISOString() };
}
