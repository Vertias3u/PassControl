// Resolving a presented passport id to an agent, and deciding whether that
// passport may authenticate at all.
//
// This is trust boundary #1, and it now has TWO doors: /api/auth/challenge
// mints the work-visa this gateway accepts, and /api/auth/agent-token mints an
// EdDSA token asserting the agent's identity to a third party. They had
// independent copies of the same lookup-and-gate logic. Adding expiry and
// rotation to one copy and not the other would mean a passport its owner
// retired could still mint an identity assertion that outlives this gateway's
// involvement entirely — so this is the single implementation, in the spirit of
// lib/fleet.ts.
//
// ── What this function does NOT do ──────────────────────────────────────────
//
// It does not verify the signature, and it cannot: LOOKUP_COLUMNS deliberately
// omits `passport_pubkey`, so there is no key on the returned row to verify
// against. That is structural, not stylistic. The signature must be checked
// against the key the CALLER PRESENTED — which is the key this lookup matched
// on — and the two ways of getting that wrong are the two failure modes that
// make rotation worse than no rotation:
//
//   deriving from `passport_pubkey` unconditionally → the retired key is
//     accepted only until someone notices the signature check passes for the
//     wrong reason, and the NEW key is rejected during the grace window;
//   deriving from the row at all → a future column rename or a widened select
//     silently changes which key authenticates.
//
// A helper that cannot return the key cannot be misused this way by accident.
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Columns every caller needs, plus the three this module gates on.
 *
 * `passport_pubkey` is absent ON PURPOSE — see the note above. Do not add it.
 * Callers that genuinely need the stored key (the dashboard, the control API)
 * read it through their own queries, off the authentication path.
 */
const LOOKUP_COLUMNS = "expires_at, previous_valid_until";

export type PassportRow = Record<string, unknown> & {
  id: string;
  status: string;
  expires_at?: string | null;
  previous_valid_until?: string | null;
};

export type PassportLookup =
  | { ok: true; agent: PassportRow; usedRetiredKey: boolean }
  | { ok: false; status: number; code: string; agentId?: string };

type LookupDatabase = Pick<SupabaseClient, "from">;

function isPast(value: unknown, now: number): boolean {
  if (typeof value !== "string" || !value) return true; // see fail-closed note below
  const at = Date.parse(value);
  return !Number.isFinite(at) || at <= now;
}

/**
 * Are these two lookups the same agent?
 *
 * An id that is missing or not a string answers "no", so a caller whose
 * `extraColumns` omitted `id` gets the refusal rather than a comparison of two
 * undefineds — which would read as "same row" and silently reinstate the
 * impersonation this check exists to stop. Both current callers select it.
 */
function isSameRow(a: PassportRow, b: PassportRow): boolean {
  return typeof a.id === "string" && a.id.length > 0 && a.id === b.id;
}

async function findBy(
  db: LookupDatabase,
  column: string,
  presentedId: string,
  columns: string
): Promise<{ row: PassportRow | null; failed: boolean }> {
  const { data, error } = await db
    .from("agents")
    .select(columns)
    .eq(column, presentedId)
    .maybeSingle();
  if (error) return { row: null, failed: true };
  return { row: (data as PassportRow | null) ?? null, failed: false };
}

/**
 * Resolve a presented passport id and decide whether it may authenticate.
 *
 * The two columns are matched with TWO SEPARATE `.eq()` LOOKUPS, never one
 * combined `.or()`, and BOTH ALWAYS RUN:
 *
 *  1. `.or()` takes a raw PostgREST filter string, and `presentedId` is
 *     attacker-controlled on an unauthenticated endpoint — commas and dots are
 *     filter syntax there. The only thing that rejects a non-base64url passport
 *     id is passportIdToPublicKey, which runs in the CALLER, after this. Making
 *     an earlier step depend on a later check for its safety is precisely the
 *     ordering this codebase refuses everywhere else.
 *  2. A current-key match is no longer sufficient on its own — see the
 *     ambiguity refusal below — so the retired-key lookup has to happen on
 *     every path anyway. Issuing both concurrently therefore costs exactly the
 *     queries the old short-circuit cost an unknown passport, at one round trip
 *     rather than two. What it does change: a failure on EITHER lookup now
 *     refuses, where a failing retired-column read used to be invisible behind
 *     a successful current-column read. That is deliberate — a lookup that
 *     cannot rule out a collision has not ruled one out.
 *
 * ── The ambiguity refusal, and what it is standing in for ───────────────────
 *
 * `passport_pubkey` and `previous_passport_pubkey` are unique only WITHIN their
 * own column. A passport id is a public key — /verify prints them and receipts
 * carry them — so nothing stops tenant A registering, as A's own CURRENT key,
 * the key tenant V has just retired. Preferring the current match would then
 * resolve V's signature to A's row and mint A's uid, agid, scope and budget
 * from a signature only V could produce: a valid signature attributed to the
 * wrong tenant, which is the one thing boundary #1 exists to prevent.
 *
 * So when the presented key matches one row's current key AND a different row's
 * retired key, this refuses both of them. One row, or the same row twice,
 * proceeds. The cost is that a tenant who copies a published key can deny its
 * owner a mint until the collision is cleaned up; that is strictly better than
 * choosing an identity we have no basis to choose.
 *
 * THIS IS A READ-SIDE REFUSAL AND A SECOND LINE OF DEFENCE. Migration 0035
 * makes the two columns reserve one transactional global namespace through an
 * `agents` trigger, so creation, attach, rotation and cleanup cannot create a
 * new cross-row collision. This check remains deliberately: a deployment that
 * already held a collision cannot apply 0035 until an operator resolves it,
 * and an authentication boundary must fail closed rather than assume every
 * historical database completed that repair.
 *
 * Order of gates is policy, not preference: status, then expiry, then the
 * retired-key deadline. `status` stays first so a revoked agent reads as
 * revoked even if it also aged out — an operator debugging a fleet must be able
 * to tell "someone revoked this" from "this aged out", and these codes are what
 * captureSecurityEvent records.
 *
 * All of it runs BEFORE the caller verifies the signature, which is a
 * deliberate continuation of how this route already worked — `agent_not_active`
 * has always fired before verification. It means an unauthenticated caller who
 * guesses a passport id can distinguish revoked from expired without proving
 * they hold the key. That is kept because a passport id is a public key, not a
 * secret (the /verify page publishes status against one), and because the two
 * codes have to be separable in the security log. If that trade is ever
 * revisited, move ALL of these checks after verification together — splitting
 * them would be the worst of both.
 */
export async function findAuthenticatablePassport(
  db: LookupDatabase,
  presentedId: string,
  extraColumns: string,
  now: number = Date.now()
): Promise<PassportLookup> {
  const columns = `${extraColumns}, ${LOOKUP_COLUMNS}`;

  const [current, retired] = await Promise.all([
    findBy(db, "passport_pubkey", presentedId, columns),
    findBy(db, "previous_passport_pubkey", presentedId, columns),
  ]);
  if (current.failed || retired.failed) {
    return { ok: false, status: 500, code: "lookup_failed" };
  }

  // Two rows answer to this key. No agentId is reported: naming one of them
  // would be the same guess this refuses to make.
  if (current.row && retired.row && !isSameRow(current.row, retired.row)) {
    return { ok: false, status: 403, code: "passport_ambiguous" };
  }

  const agent = current.row ?? retired.row;
  const usedRetiredKey = !current.row && retired.row !== null;

  if (!agent) return { ok: false, status: 401, code: "unknown_passport" };
  if (agent.status !== "active") {
    return { ok: false, status: 403, code: "agent_not_active", agentId: agent.id };
  }

  // null = never expires. Every row holds null the moment 0021 applies, so this
  // is what keeps expiry opt-in and leaves existing passports untouched.
  if (agent.expires_at != null && isPast(agent.expires_at, now)) {
    return { ok: false, status: 403, code: "passport_expired", agentId: agent.id };
  }

  // A retired key with NO deadline is refused rather than admitted. Rotation
  // always stamps one, so this is unreachable through the product — which is
  // exactly why it must fail closed here instead of being left to whoever next
  // writes to this column by hand. isPast() returns true for a null or
  // unparseable value for the same reason.
  if (usedRetiredKey && isPast(agent.previous_valid_until, now)) {
    return { ok: false, status: 403, code: "passport_expired", agentId: agent.id };
  }

  return { ok: true, agent, usedRetiredKey };
}
