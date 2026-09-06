// The public, signed revocation list.
//
// ── The question it answers ─────────────────────────────────────────────────
//
// A stranger holding a signed receipt can already check the signature against
// /.well-known/jwks.json, entirely offline. What they cannot check is whether
// the passport that signed it was still good at that moment. /verify answers
// that for one id you already know, live, by asking us. This answers it for
// every dead key at once, offline, cached, without asking the tenant — which is
// the missing half of public verification (COMPETITIVE_GAPS.md M4,
// research/passport-key-protection.md §7 item 6).
//
// ── MONOTONICITY decides the contents, not taste ────────────────────────────
//
// A revocation list may gain entries and must never lose one. A verifier caches
// it; an entry that disappears silently converts "this key was dead" back into
// "this key was fine", and the verifier has no way to notice. So only
// PERMANENT deaths are eligible:
//
//   revoked   `agents.status` goes to 'revoked' and never comes back — the
//             revoke path is terminal by construction (lib/fleet.ts).
//   rotated   a retired key stops working when its grace window closes and is
//             never reinstated; the column is cleared afterwards, not reused.
//
// SUSPENSION IS EXCLUDED because it is reversible: suspend on Monday, resume on
// Tuesday, and the entry would have to be withdrawn. That argument settles it on
// correctness alone, before any question of disclosure — which is why it leads.
// The disclosure argument points the same way and is worth stating too: a
// pollable public feed of every suspension across every tenant is an incident
// timeline, and §5 of the brief forbids publishing kill-switch state for the
// same reason. KILL STATE HAS NO REPRESENTATION HERE AT ALL. It lives in Redis,
// is read per request, and is reversible at two levels.
//
// EXPIRY IS ALSO EXCLUDED, and for a different reason: it is not a revocation.
// Every live passport has an expiry, so enumerating them would make the list
// unbounded and would mix "retired on schedule" with "killed". The verifier
// still needs it — `covers.excludes` says so in the signed payload, and the
// place to get it is GET /api/verify/<passportId>, which publishes `expiresAt`
// and, for a key retired by rotation, its `retired.notValidAfter`. That is the
// live half of the same question; this document is the historical half.
//
// ── Where the timestamps come from ──────────────────────────────────────────
//
// public.admin_audit, not a new column. `agent.revoke` is written on the only
// path that revokes anything, and it records WHEN THE OPERATOR ACTED — a
// `revoked_at` column would only record when the row was last written. The
// audit table is append-only, which is the property a monotonic list wants.
import type { SupabaseClient } from "@supabase/supabase-js";

import { rateLimit } from "@/lib/ratelimit";

export const REVOCATION_LIST_FORMAT = "passcontrol.revocations";
export const REVOCATION_LIST_VERSION = 1;
/** JWS `typ`, so a revocation list can never be verified as a receipt. */
export const REVOCATION_LIST_TYP = "passcontrol-crl+jws";

/**
 * The only audit actions that may put an entry in this document.
 *
 * Exported so a test can pin it against AUDIT_ACTIONS: `covers.excludes` is a
 * hand-written array, and without that pin a future reversible agent state
 * could be added to the trail while this list kept advertising the same three
 * exclusions — silently publishing it, or silently not. The action decides,
 * never the metadata shape.
 */
export const REVOCATION_SOURCE_ACTIONS = ["agent.revoke", "agent.update"] as const;

/**
 * Unauthenticated, and on a self-hosted instance there is no CDN in front of it
 * to absorb repeats — so the limiter lives INSIDE the loader, exactly as
 * lookupPublicPassport does it, and a caller cannot forget to throttle a read
 * it does not perform itself. Generous: the document is cacheable for 300s, so
 * a well-behaved verifier needs one fetch per window, not thirty.
 */
export const REVOCATION_LIST_LIMIT = 30;
export const REVOCATION_LIST_WINDOW_SECONDS = 60;

/** One passport public key that stopped being valid, and when. */
export interface RevocationEntry {
  id: string;
  /** ISO instant. The key is valid up to and including this moment, never after. */
  notValidAfter: string;
}

/**
 * What the list enumerates, and — the load-bearing half — what it does not.
 *
 * A verifier that reads "absent from the list" as "was valid" has drawn a
 * conclusion this document cannot support: an expired passport is absent and was
 * not valid. Saying so inside the SIGNED payload rather than in documentation
 * means a verifier cannot receive the list without also receiving its limits.
 */
export interface RevocationListCoverage {
  includes: ["revoked", "rotated"];
  excludes: string[];
}

export interface RevocationListClaims {
  // Indexed so the claims satisfy signCompactJws's Record<string, unknown>
  // without a cast at the call site. Every member is still named below — the
  // index signature widens the type, it does not open the document.
  [claim: string]: unknown;
  iss: string;
  /** Seconds. Signed, so an old list cannot be replayed to hide a later entry. */
  iat: number;
  fmt: typeof REVOCATION_LIST_FORMAT;
  v: typeof REVOCATION_LIST_VERSION;
  covers: RevocationListCoverage;
  entries: RevocationEntry[];
}

/** The audit shape this module reads. Deliberately narrow. */
export interface RevocationAuditRow {
  action: string;
  target_id: string | null;
  created_at: string;
  metadata: Record<string, unknown> | null;
}

export interface RevocationAgentRow {
  id: string;
  passport_pubkey: string | null;
}

export type RevocationLoadResult =
  | { ok: true; entries: RevocationEntry[] }
  | { ok: false; reason: "throttled" | "unavailable" };

function instant(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

/**
 * Fold the audit trail into a list of dead keys.
 *
 * Every rejection below is a DROP, never a guess. An incomplete list is a state
 * `covers` already tells the verifier to expect; an invented entry is a false
 * statement about somebody's identity, and this document is signed.
 */
export function buildRevocationEntries(
  rows: RevocationAuditRow[],
  agents: RevocationAgentRow[]
): RevocationEntry[] {
  const passportOf = new Map(agents.map((agent) => [agent.id, agent.passport_pubkey]));
  // Earliest death wins. A key rotated out with a grace window that was then
  // cut short by revoking the agent really stopped at the revocation; taking the
  // later timestamp would vouch for a window the gateway was already refusing.
  const deaths = new Map<string, string>();

  const record = (id: string | null | undefined, at: string | null) => {
    if (!id || !at) return;
    const known = deaths.get(id);
    if (!known || at < known) deaths.set(id, at);
  };

  for (const row of rows) {
    // The ACTION decides, never the metadata shape — a rotation-shaped payload
    // written under some other action must not produce an entry.
    if (!(REVOCATION_SOURCE_ACTIONS as readonly string[]).includes(row.action)) continue;
    if (row.action === "agent.revoke") {
      // Revocation is immediate and fail-closed: lib/fleet.ts suspends and
      // purges before the terminal row write, so the key is dead from the
      // moment the operator acted, not from some later reconciliation.
      record(passportOf.get(row.target_id ?? "") ?? null, instant(row.created_at));
      continue;
    }
    if (row.action === "agent.update" && row.metadata?.rotated === true) {
      // `from` is the retired key. A rotation recorded before that field
      // existed is skipped: the reconcile sweep clears the column once the
      // grace window closes, so nothing anywhere still holds the id.
      const from = typeof row.metadata.from === "string" ? row.metadata.from : null;
      record(from, instant(row.metadata.previous_valid_until));
    }
  }

  // Sorted so the same state serialises to the same bytes on every fetch — a
  // document whose signature changes for no reason defeats caching and looks
  // like tampering to anyone diffing it.
  return [...deaths.entries()]
    .map(([id, notValidAfter]) => ({ id, notValidAfter }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

export function buildRevocationListClaims(input: {
  issuer: string;
  entries: RevocationEntry[];
  generatedAt?: number;
}): RevocationListClaims {
  return {
    iss: input.issuer,
    iat: Math.floor((input.generatedAt ?? Date.now()) / 1000),
    fmt: REVOCATION_LIST_FORMAT,
    v: REVOCATION_LIST_VERSION,
    covers: {
      includes: ["revoked", "rotated"],
      // Named individually rather than as prose. `expired` is the one a verifier
      // most needs: expiry is not a revocation, so an expired passport is absent
      // from this list and was not valid — check it on /verify.
      excludes: ["expired", "suspended", "kill_switch"],
    },
    entries: input.entries,
  };
}

/**
 * Read every dead key on this instance.
 *
 * Cross-tenant by construction — a public list is not scoped to anyone — so it
 * takes the service-role client and selects only the two columns it publishes.
 * Nothing here reads a name, a budget, a scope, or a user id.
 *
 * ── Every filter below is a cost control, not a tidy-up ──────────────────────
 *
 * This endpoint is unauthenticated and, on a self-hosted instance, uncached. An
 * unbounded scan per request would be a free amplification primitive against
 * the tenant database of an identity product. So:
 *
 *   · revocations and rotations are two narrow queries, not one broad one.
 *     `agent.update` is written on every budget, scope, expiry and mode change,
 *     so that table grows with ordinary use — filtering `metadata->>rotated`
 *     server-side keeps the handful of rows that can produce an entry instead
 *     of fetching all of them to discard almost all of them.
 *   · only REVOKED agents can contribute a passport id, because revocation is
 *     terminal, so the fleet read is bounded to them rather than to everyone.
 */
export async function loadRevocationEntries(
  db: Pick<SupabaseClient, "from">,
  clientIp: string
): Promise<RevocationLoadResult> {
  const limit = await rateLimit(
    `revocations:${clientIp}`,
    REVOCATION_LIST_LIMIT,
    REVOCATION_LIST_WINDOW_SECONDS
  );
  if (!limit.success) return { ok: false, reason: "throttled" };

  const columns = "action, target_id, created_at, metadata";
  const [revocations, rotations, agents] = await Promise.all([
    db
      .from("admin_audit")
      .select(columns)
      .eq("action", "agent.revoke")
      .eq("target_type", "agent")
      .order("created_at", { ascending: true }),
    db
      .from("admin_audit")
      .select(columns)
      .eq("action", "agent.update")
      // The retired key is carried in the metadata, so this is the only shape
      // that can yield an entry. A rotation predating that field is filtered
      // out here rather than fetched and dropped later.
      .eq("metadata->>rotated", "true")
      .order("created_at", { ascending: true }),
    db
      .from("agents")
      .select("id, passport_pubkey")
      .eq("status", "revoked")
      .not("passport_pubkey", "is", null),
  ]);

  // A partial list is worse than no list: a verifier cannot tell a short answer
  // from a complete one, and would read a missing entry as "still valid".
  if (revocations.error || rotations.error || agents.error) {
    return { ok: false, reason: "unavailable" };
  }

  return {
    ok: true,
    entries: buildRevocationEntries(
      [
        ...((revocations.data ?? []) as RevocationAuditRow[]),
        ...((rotations.data ?? []) as RevocationAuditRow[]),
      ],
      (agents.data ?? []) as RevocationAgentRow[]
    ),
  };
}
