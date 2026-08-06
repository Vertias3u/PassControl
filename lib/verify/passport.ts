// PAVP — public agent verification.
//
// One question, one answer: was this passport issued by us, and is it still
// valid? Everything else about the agent stays private. The readable surface is
// pinned in two places on purpose — db/migrations/0015 fixes what the database
// will return, and PUBLIC_PASSPORT_FIELDS below fixes what the page can render.
// Either alone would be enough to keep a private column off a public URL; both
// means a mistake has to be made twice.
//
// This is the app's first unauthenticated route that reads the agents table, so
// the limiter lives in lookupPublicPassport() rather than at the call site: a
// page cannot forget to throttle a lookup it does not perform itself.
import type { SupabaseClient } from "@supabase/supabase-js";
import { rateLimit } from "@/lib/ratelimit";

/**
 * The complete public field set. tests/public-verification.test.ts asserts the
 * rendered view has exactly these keys, so widening the page means changing
 * this list deliberately and watching a test go red first.
 */
export const PUBLIC_PASSPORT_FIELDS = [
  "passportId",
  "displayId",
  "status",
  "issuedAt",
  "owner",
] as const;

/**
 * The complete public owner field set, pinned the same way. `tier` is the one
 * that matters: it says how much the binding is worth, and it is the ONLY thing
 * the page may key a "verified" label off. `kind` records the method attempted,
 * which is not the same claim.
 */
export const PUBLIC_OWNER_FIELDS = ["kind", "subject", "tier", "verifiedAt"] as const;

/** Anonymous callers get a modest budget; the page is cheap and cacheable-by-eye. */
export const PUBLIC_VERIFY_LIMIT = 30;
export const PUBLIC_VERIFY_WINDOW_SECONDS = 60;

/**
 * Ed25519 public keys are 32 bytes, so a base64url passport id is 43 characters.
 * The bound is generous rather than exact — a future key type should fail on a
 * lookup miss, not on a length check — but it is still short enough that no
 * amount of query string reaches the database.
 */
const PASSPORT_ID_MIN = 16;
const PASSPORT_ID_MAX = 128;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Characters kept at each end when abbreviating a passport id for display. */
const DISPLAY_EDGE = 8;

export type PublicPassportStatus = "active" | "suspended" | "revoked" | "unknown";

/** How the owner was established. Records the method, NOT the proof — see tier. */
export type PublicOwnerKind = "self_attested" | "domain" | "idv";

/**
 * What was actually proven. `unverified` means an operator typed a name and
 * nothing was checked. Anything the page words as "verified" must come from
 * here, never from kind.
 */
export type PublicOwnerTier = "unverified" | "domain" | "idv";

export interface PublicOwnerView {
  kind: PublicOwnerKind;
  subject: string;
  tier: PublicOwnerTier;
  verifiedAt: string | null;
}

export interface PublicPassportView {
  passportId: string;
  displayId: string;
  status: PublicPassportStatus;
  issuedAt: string | null;
  /** null when no owner is bound, or when the owner has not published one. */
  owner: PublicOwnerView | null;
}

export type PublicPassportResult =
  | { ok: true; passport: PublicPassportView }
  | { ok: false; reason: "not_found" | "throttled" | "unavailable" };

type VerifyDatabase = Pick<SupabaseClient, "rpc">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A passport id is a base64url public key. The internal agent uuid is rejected
 * explicitly: it is the identifier in dashboard URLs and the control API, and
 * accepting it here would let anyone turn a leaked dashboard link into a public
 * identity lookup. It cannot match BASE64URL_RE anyway (hyphens aside, the
 * check below is the one that documents the intent).
 */
export function isPassportIdShape(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const candidate = value.trim();
  if (candidate.length < PASSPORT_ID_MIN || candidate.length > PASSPORT_ID_MAX) return false;
  if (UUID_RE.test(candidate)) return false;
  return BASE64URL_RE.test(candidate);
}

/** `Zm9vYmFy…YmFyc28` — enough to eyeball against a key, too little to retype wrongly. */
function abbreviate(passportId: string): string {
  if (passportId.length <= DISPLAY_EDGE * 2 + 1) return passportId;
  return `${passportId.slice(0, DISPLAY_EDGE)}…${passportId.slice(-DISPLAY_EDGE)}`;
}

/**
 * Only the three states the agents enum defines are named. Anything else is
 * schema drift, and drift resolves to "unknown" — never to "active". A page
 * that guesses "valid" about an identity it does not understand is worse than
 * one that admits it does not know.
 */
function normalizeStatus(value: unknown): PublicPassportStatus {
  switch (value) {
    case "active":
    case "suspended":
    case "revoked":
      return value;
    default:
      return "unknown";
  }
}

function issueDate(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

/**
 * Only the tiers the schema defines are named, and anything else resolves to
 * `unverified` — never upward. An unrecognised tier is schema drift, and drift
 * that renders as "verified" would be a false claim about someone's identity on
 * a public page. Same discipline as normalizeStatus.
 */
function normalizeTier(value: unknown): PublicOwnerTier {
  return value === "domain" || value === "idv" ? value : "unverified";
}

function normalizeKind(value: unknown): PublicOwnerKind {
  return value === "domain" || value === "idv" ? value : "self_attested";
}

/**
 * Build the owner view by naming every field, exactly as the passport view does.
 *
 * Returns null unless the row actually carries an owner: the SQL function
 * LEFT JOINs a published owner, so every column is NULL when there is none, or
 * when the owner has chosen not to publish.
 */
export function buildPublicOwnerView(row: Record<string, unknown>): PublicOwnerView | null {
  const subject = typeof row.owner_subject === "string" ? row.owner_subject.trim() : "";
  if (!subject) return null;

  const tier = normalizeTier(row.owner_tier);
  return {
    kind: normalizeKind(row.owner_kind),
    subject,
    tier,
    // A tier that proves nothing has no verification date to show. Reporting one
    // would dress a self-attested claim as a checked one.
    verifiedAt: tier === "unverified" ? null : issueDate(row.owner_verified_at),
  };
}

/**
 * Build the public view by naming every field, never by spreading the row. A
 * column added to the SQL function later is dropped here silently rather than
 * leaking through.
 */
export function buildPublicPassportView(row: unknown): PublicPassportView | null {
  if (!isRecord(row)) return null;

  const passportId =
    typeof row.passport_pubkey === "string" ? row.passport_pubkey.trim() : "";
  if (!passportId) return null;

  return {
    passportId,
    displayId: abbreviate(passportId),
    status: normalizeStatus(row.status),
    issuedAt: issueDate(row.created_at),
    owner: buildPublicOwnerView(row),
  };
}

function firstRow(data: unknown): unknown {
  if (Array.isArray(data)) return data[0] ?? null;
  return data ?? null;
}

/**
 * Resolve one passport for an anonymous visitor.
 *
 * Order is deliberate: shape check, then limiter, then database. A malformed id
 * costs nothing, and a throttled caller never reaches Redis-backed state beyond
 * the counter that throttled them.
 *
 * A database failure reports `unavailable`, never `not_found`. Rendering "no
 * such passport" during an outage would be a false statement about someone's
 * identity, and this page exists to be quotable.
 */
export async function lookupPublicPassport(
  db: VerifyDatabase,
  passportId: unknown,
  clientIp: string
): Promise<PublicPassportResult> {
  if (!isPassportIdShape(passportId)) return { ok: false, reason: "not_found" };
  const id = (passportId as string).trim();

  const limit = await rateLimit(
    `verify:${clientIp}`,
    PUBLIC_VERIFY_LIMIT,
    PUBLIC_VERIFY_WINDOW_SECONDS
  );
  if (!limit.success) return { ok: false, reason: "throttled" };

  const { data, error } = await db.rpc("verify_passport", { p_passport_id: id });
  if (error) return { ok: false, reason: "unavailable" };

  const view = buildPublicPassportView(firstRow(data));
  if (!view) return { ok: false, reason: "not_found" };
  return { ok: true, passport: view };
}
