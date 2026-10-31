// Recording what the injection guard found (plans/injection-guard.md §4–§5; migration 0089).
//
// Only a block not seen before becomes a row. A coding agent re-sends the whole
// conversation on every call, so the same tool result arrives at every later turn: a
// row per arrival would fill the table with copies, and in Phase 2 would undo the owner's
// "clear" on the very next call. Redis remembers each (agent, detector, HMAC) for a day;
// the table's unique index is the backstop when Redis forgets or is down, so a Redis
// fault costs a redundant write, never a missed one. A write that fails gives its claims
// back, so a database fault does not hide the block for the rest of the day either.
//
// "New" means the table inserted the row, not that Redis had forgotten it. The hold
// (Phase 2, lib/state/taint.ts) taints only on a new block, so a re-sent one, or one
// the owner already cleared, must never count again once its day-long Redis key has
// expired: the row is what remembers it.
//
// Best-effort, like writeLog: called from waitUntil, never throws, and a failure changes
// nothing about the call. The service-role client bypasses RLS, so every row carries the
// tenant and agent the gateway authenticated, never ones read from the body.
import { INJECTION_DETECTOR, INJECTION_FAMILIES, INJECTION_NORMALIZATION, type InjectionFamily } from "@/cli/injection-scan.mjs";
import { sidecarContentHmac, type InjectionFinding } from "./injection-guard";
import { redis } from "./state/redis";

export const INJECTION_FINDINGS_TABLE = "injection_findings";
const SEEN_TTL_S = 24 * 60 * 60;
const RETENTION_SWEEP_EVERY_S = 24 * 60 * 60;
const MODEL_SHAPE = /^[A-Za-z0-9._:/@-]{1,100}$/;
const PROVIDER_SHAPE = /^[a-z0-9_-]{1,32}$/;
// 0089's and 0090's shapes, held here first so one event that does not fit is dropped
// alone rather than failing the batch's write.
const PATH_SHAPE = /^[A-Za-z0-9_.[\]?-]{1,512}$/;
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
// What the sidecar scans: tool output, and nothing else (plans/injection-guard.md §2b).
const SIDECAR_SOURCES = new Set(["tool_result"]);

/** SET NX EX: true when this call is the first to claim `key`. Both may throw. */
export interface SeenStore {
  claim(key: string, ttlSeconds: number): Promise<boolean>;
  /** Gives a claim back (DEL), after the write it was for failed. */
  release(key: string): Promise<void>;
}

/** The live store: Redis SET NX EX. */
export function redisSeenStore(): SeenStore {
  return {
    async claim(key, ttlSeconds) {
      return (await redis().set(key, 1, { nx: true, ex: ttlSeconds })) === "OK";
    },
    async release(key) {
      await redis().del(key);
    },
  };
}

export interface FindingsDb {
  from(table: string): {
    upsert(
      rows: unknown[],
      options: { onConflict: string; ignoreDuplicates: boolean }
    ): {
      // With ignoreDuplicates, PostgREST returns only the rows it inserted.
      select(columns: string): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
    };
  };
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ error: unknown }>;
}

export type RecordOutcome =
  | { state: "recorded"; recorded: InjectionFinding[] }
  | { state: "nothing_new" }
  // The findings this call would have written, so a hold still taints on a real block
  // while the table cannot be written (lib/state/taint.ts).
  | { state: "unavailable"; unrecorded: InjectionFinding[] }
  | { state: "failed"; unrecorded: InjectionFinding[] };

export const seenKey = (agentId: string, contentHmac: string) =>
  `injection_seen:${agentId}:${INJECTION_DETECTOR}:${contentHmac}`;

/** True for the error a database before 0089 gives (no table), or before 0090 for a sidecar row. */
export function isMissingFindingsTable(error: { code?: unknown; message?: unknown } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  // A database at 0089 has the table but not 0090's `tool_name`.
  if (error.code === "PGRST204" || error.code === "42703") return true;
  return typeof error.message === "string" && error.message.includes(INJECTION_FINDINGS_TABLE) && /does not exist|schema cache/.test(error.message);
}

/**
 * A finding the sidecar uploaded (`kind: "injection_finding"`), or null when any field
 * does not fit. The client's word: the server cannot check the detector fired, so a lying
 * client can only add false findings about itself. The block's text never arrives, only
 * its SHA-256, and that is not stored either (`sidecarContentHmac`).
 */
export function sidecarFinding(event: unknown, userId: string): InjectionFinding | null {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const e = event as Record<string, unknown>;
  if (typeof e.source !== "string" || !SIDECAR_SOURCES.has(e.source)) return null;
  if (typeof e.path !== "string" || !PATH_SHAPE.test(e.path)) return null;
  if (e.tool !== undefined && e.tool !== null && (typeof e.tool !== "string" || !TOOL_NAME.test(e.tool))) return null;
  if (!Array.isArray(e.families) || e.families.length === 0 || e.families.length > INJECTION_FAMILIES.length) return null;
  const families = new Set(e.families);
  if (families.size !== e.families.length || ![...families].every((f) => INJECTION_FAMILIES.includes(f as InjectionFamily))) return null;
  if (e.severity !== "high" && e.severity !== "low") return null;
  // Only the detector this gateway runs; a new detector is added here when it ships.
  if (e.detector !== INJECTION_DETECTOR || e.normalization_version !== INJECTION_NORMALIZATION) return null;
  if (typeof e.block_sha256 !== "string" || !SHA256_HEX.test(e.block_sha256)) return null;
  return {
    path: e.path,
    source: e.source,
    families: INJECTION_FAMILIES.filter((f) => families.has(f)),
    severity: e.severity,
    contentHmac: sidecarContentHmac(userId, e.block_sha256),
    toolName: typeof e.tool === "string" ? e.tool : null,
  };
}

export async function recordInjectionFindings(input: {
  db: FindingsDb;
  seen: SeenStore;
  userId: string;
  agentId: string;
  provider: string;
  model: string;
  findings: readonly InjectionFinding[];
  /** Where the block was seen. `sidecar` rows need 0090 (and carry the tool's name). */
  surface?: "proxy" | "sidecar";
}): Promise<RecordOutcome> {
  const { db, seen, userId, agentId } = input;
  if (input.findings.length === 0) return { state: "nothing_new" };

  let fresh: InjectionFinding[];
  let claimed = false;
  try {
    const claims = await Promise.all(input.findings.map((f) => seen.claim(seenKey(agentId, f.contentHmac), SEEN_TTL_S)));
    fresh = input.findings.filter((_, i) => claims[i]);
    claimed = true;
  } catch {
    // Redis down: write them all and let the unique index keep one of each.
    fresh = [...input.findings];
  }
  if (fresh.length === 0) return { state: "nothing_new" };

  const surface = input.surface ?? "proxy";
  const rows = fresh.map((f) => ({
    user_id: userId,
    agent_id: agentId,
    surface,
    source: f.source,
    path: f.path,
    families: f.families,
    severity: f.severity,
    detector: INJECTION_DETECTOR,
    normalization_version: INJECTION_NORMALIZATION,
    content_hmac: f.contentHmac,
    // Both come from the request; one the table would refuse must not cost the row.
    provider: PROVIDER_SHAPE.test(input.provider) ? input.provider : null,
    model: MODEL_SHAPE.test(input.model) ? input.model : null,
    // Only a sidecar row names the column, so the proxy's writes still fit a database at 0089.
    ...(surface === "sidecar" ? { tool_name: f.toolName ?? null } : {}),
  }));
  let inserted: InjectionFinding[];
  try {
    const { data, error } = await db
      .from(INJECTION_FINDINGS_TABLE)
      .upsert(rows, { onConflict: "user_id,agent_id,content_hmac,detector", ignoreDuplicates: true })
      .select("content_hmac");
    if (error) {
      if (claimed) await giveBack(seen, agentId, fresh);
      return isMissingFindingsTable(error) ? { state: "unavailable", unrecorded: fresh } : { state: "failed", unrecorded: fresh };
    }
    // An answer without rows is read as all of them inserted: a hold errs toward holding.
    const insertedHmacs = Array.isArray(data)
      ? new Set(data.map((r) => (r && typeof r === "object" ? (r as { content_hmac?: unknown }).content_hmac : null)))
      : null;
    inserted = insertedHmacs ? fresh.filter((f) => insertedHmacs.has(f.contentHmac)) : fresh;
  } catch {
    if (claimed) await giveBack(seen, agentId, fresh);
    return { state: "failed", unrecorded: fresh };
  }

  // Best-effort: a failed sweep never fails the write, and tomorrow's claim retries it.
  try {
    if (await seen.claim(`retention:injection_findings:${agentId}`, RETENTION_SWEEP_EVERY_S)) {
      await db.rpc("prune_injection_findings", { p_agent_id: agentId, p_user_id: userId });
    }
  } catch {
    // Redis or the database unreachable: the findings are already written.
  }
  return inserted.length > 0 ? { state: "recorded", recorded: inserted } : { state: "nothing_new" };
}

// Best-effort: a claim that cannot be given back expires with its TTL, as before.
async function giveBack(seen: SeenStore, agentId: string, findings: readonly InjectionFinding[]): Promise<void> {
  await Promise.all(
    findings.map(async (f) => {
      try {
        await seen.release(seenKey(agentId, f.contentHmac));
      } catch {
        // Redis unreachable: the TTL is the fallback.
      }
    })
  );
}
