// Break-glass elevation: a time-boxed widening of an agent's scope.
//
// This is a deliberate hole in the capability model. Everything here exists to
// keep it a SMALL one — bounded in time, bounded in what it can widen, and
// impossible to take without leaving a record.
//
// ── The direction of failure is inverted here, and that matters ─────────────
//
// Most fail-closed decisions in this codebase mean "refuse the call". For this
// feature, closed means NO ELEVATION. A grant that cannot be read must mint the
// agent's normal scope and let the call proceed on its own merits — never error
// the challenge (that would make an unreachable grants table an outage for
// every agent), and never assume an elevation (that would make a database blip
// a privilege escalation). readLiveGrant returns null on every failure for
// exactly this reason.
import type { SupabaseClient } from "@supabase/supabase-js";

import type { ScopeEntry } from "./auth/visa";
import { LIMITS } from "./validate";

/**
 * Longest elevation that can be taken in one go, in seconds.
 *
 * An hour is "long enough to work an incident", not "long enough to forget
 * about". The cap is enforced server-side rather than only in the form — see
 * the note on grantBreakGlass — because a form-only limit is not a limit.
 */
export const MAX_BREAK_GLASS_TTL_S = 60 * 60;

/** Shortest elevation worth recording. Below this it is a typo, not a decision. */
export const MIN_BREAK_GLASS_TTL_S = 60;

/** Matches the check constraint in migration 0022. */
export const BREAK_GLASS_REASON_MAX = 500;

export interface BreakGlassGrant {
  id: string;
  scopes: ScopeEntry[];
  reason: string;
  expiresAt: string;
  createdAt: string;
}

type GrantDatabase = Pick<SupabaseClient, "from">;

const GRANT_COLUMNS = "id, scopes, reason, expires_at, created_at";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Coerce stored scopes without throwing.
 *
 * The column is jsonb and is validated on the way IN (grantBreakGlass runs
 * validateScopes), but this reads it back on the credential path, where a
 * malformed row must degrade to "no elevation" rather than to an exception.
 * Entries that do not parse are dropped individually — a single bad entry
 * should not silently discard a legitimate elevation the operator is relying on
 * mid-incident.
 */
export function parseGrantScopes(value: unknown): ScopeEntry[] {
  if (!Array.isArray(value)) return [];
  const out: ScopeEntry[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) continue;
    const provider = typeof candidate.provider === "string" ? candidate.provider.trim() : "";
    if (!provider || provider.length > LIMITS.modelPattern) continue;
    if (!Array.isArray(candidate.models)) continue;
    const models = candidate.models
      .filter((m): m is string => typeof m === "string" && m.length > 0 && m.length <= LIMITS.modelPattern)
      .slice(0, LIMITS.models);
    if (models.length === 0) continue;
    out.push({ provider, models });
    if (out.length >= LIMITS.scopes) break;
  }
  return out;
}

/**
 * The agent's effective scope: what it normally has, plus what a live grant adds.
 *
 * Merged BY PROVIDER rather than concatenated. Two entries for the same provider
 * would both be honoured by scopeAllows, so concatenating is not wrong — but it
 * makes the visa grow without bound across repeated elevations and makes the
 * minted scope hard to read in a decision trace, which is where someone looks
 * when they are trying to understand why a call went through.
 *
 * The BASE is normalized the same way, and that is a fix rather than tidiness.
 * validateScopes permits `[openai:[a], openai:[b]]`, and merging granted models
 * into only the FIRST matching row left the row count flat while one row grew
 * without limit — so "the union has 20 rows" said nothing about how big it was.
 * One row per provider is what lets a count mean something again. It cannot
 * change what the visa PERMITS: scopeAllows honours any matching row, so the
 * merged row allows exactly the union of what the duplicates allowed.
 *
 * A provider keeps the position of its FIRST appearance, so an agent's own
 * capability still reads before anything an elevation added.
 *
 * ── Why it coerces rather than trusts its own type ──────────────────────────
 *
 * The BASE comes from `agents.allowed_scopes`, which is `jsonb not null default
 * '[]'` with no CHECK on its contents, and the service-role client bypasses RLS
 * — so the ScopeEntry[] in the signature is a claim about the normal write path
 * (validateScopes), not a guarantee about the column. Every mint now runs
 * through here, so a single malformed ENTRY reaching `for (const model of
 * entry.models)` would not deny one provider: it would throw, and the challenge
 * route would answer 500 — the agent could not authenticate at all.
 *
 * So a non-object entry is dropped and a non-array `models` becomes empty,
 * matching how the trace simulator already coerces the same column. It does NOT
 * slice or trim the way parseGrantScopes does: those bounds belong on the way
 * IN, and applying them here would silently narrow an over-limit agent's visa
 * or widen a whitespace-padded provider from never-matching to matching.
 */
export function unionScopes(
  base: readonly ScopeEntry[],
  granted: readonly ScopeEntry[]
): ScopeEntry[] {
  const byProvider = new Map<string, { models: string[]; seen: Set<string> }>();
  for (const entry of [...base, ...granted] as readonly unknown[]) {
    if (!isRecord(entry) || typeof entry.provider !== "string") continue;
    const models: readonly unknown[] = Array.isArray(entry.models) ? entry.models : [];
    let row = byProvider.get(entry.provider);
    if (!row) {
      row = { models: [], seen: new Set<string>() };
      byProvider.set(entry.provider, row);
    }
    for (const model of models) {
      if (typeof model !== "string" || row.seen.has(model)) continue;
      row.seen.add(model);
      row.models.push(model);
    }
  }
  return [...byProvider].map(([provider, row]) => ({ provider, models: row.models }));
}

/**
 * Largest serialized scope claim an elevation may mint, in bytes.
 *
 * Half the 8 KB body cap both minting doors already apply to a request
 * (MAX_BODY_BYTES in challenge/route.ts and agent-token/route.ts), because this
 * JSON does not travel as a body: it is base64url'd into the visa, which costs
 * a third again (4 KB → ~5.5 KB), and that token then rides in an Authorization
 * header on every proxied call. 4 KB leaves the visa comfortably inside the 8 KB
 * header budget the smallest proxy in the path is likely to allow.
 *
 * For scale: a realistic scope — a handful of providers with a wildcard or ten
 * models each — is a couple of hundred bytes. This is a ceiling on the absurd,
 * not a working limit.
 */
export const MAX_SCOPE_CLAIM_BYTES = 4 * 1024;

/**
 * Every model an elevated visa may name, across all providers.
 *
 * Derived, not chosen: it is exactly what LIMITS already allows one scope
 * document to hold — LIMITS.scopes entries of LIMITS.models each.
 */
export const MAX_UNION_MODELS = LIMITS.scopes * LIMITS.models;

export interface ScopeBoundFailure {
  /** Names the axis, for a message an operator can act on. */
  bound: string;
  limit: number;
  actual: number;
}

/**
 * Is this union too big to mint? Returns the first bound it breaks, or null.
 *
 * ── Why a row count was never enough ────────────────────────────────────────
 *
 * validateScopes bounds ONE document: LIMITS.scopes entries, LIMITS.models
 * patterns each. An elevation merges TWO documents, and either may name the
 * same provider on every row — so both can pass validation and the union can
 * still carry LIMITS.scopes × LIMITS.models × 2 patterns inside a handful of
 * rows. Counting rows measures none of that.
 *
 * So the axes here are the ones that decide whether the minted token can be
 * used at all: rows, models for any one provider, models in total, and the
 * serialized size of the claim itself. The last is measured in BYTES with a
 * TextEncoder — LIMITS.modelPattern bounds a pattern's LENGTH, not its charset,
 * so a multi-byte pattern is 200 characters and up to 800 bytes.
 *
 * Call it on the union that will actually be minted, after unionScopes has
 * normalized it. Calling it on the pre-merge documents measures a shape that
 * never reaches a visa.
 */
export function scopeUnionExceedsBounds(
  union: readonly ScopeEntry[]
): ScopeBoundFailure | null {
  if (union.length > LIMITS.scopes) {
    return { bound: "providers", limit: LIMITS.scopes, actual: union.length };
  }

  let total = 0;
  for (const entry of union) {
    if (entry.models.length > LIMITS.models) {
      return {
        bound: `models for one provider (${entry.provider})`,
        limit: LIMITS.models,
        actual: entry.models.length,
      };
    }
    total += entry.models.length;
  }
  if (total > MAX_UNION_MODELS) {
    return { bound: "models in total", limit: MAX_UNION_MODELS, actual: total };
  }

  const bytes = new TextEncoder().encode(JSON.stringify(union)).length;
  if (bytes > MAX_SCOPE_CLAIM_BYTES) {
    return { bound: "bytes of scope", limit: MAX_SCOPE_CLAIM_BYTES, actual: bytes };
  }

  return null;
}

/**
 * The live grant for this agent, or null.
 *
 * "Live" is decided HERE, in code — `revoked_at is null` AND `expires_at` in the
 * future — not by the unique index, whose predicate can only be `revoked_at is
 * null` because Postgres refuses a STABLE function like now() in an index
 * predicate. So a lapsed-but-unswept grant still occupies the index slot and is
 * correctly treated as dead by this read. A cron that has not run can therefore
 * block the NEXT elevation until it does, but can never extend this one.
 *
 * Returns null on any failure. See the note at the top of this file: for this
 * feature, closed means no elevation.
 */
export async function readLiveGrant(
  db: GrantDatabase,
  userId: string,
  agentId: string,
  now: Date = new Date()
): Promise<BreakGlassGrant | null> {
  try {
    const { data, error } = await db
      .from("break_glass_grants")
      .select(GRANT_COLUMNS)
      .eq("user_id", userId) // tenant boundary
      .eq("agent_id", agentId)
      .is("revoked_at", null)
      .gt("expires_at", now.toISOString())
      .order("expires_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !isRecord(data)) return null;

    const scopes = parseGrantScopes(data.scopes);
    if (scopes.length === 0) return null;

    return {
      id: String(data.id ?? ""),
      scopes,
      reason: typeof data.reason === "string" ? data.reason : "",
      expiresAt: String(data.expires_at ?? ""),
      createdAt: String(data.created_at ?? ""),
    };
  } catch {
    return null;
  }
}
