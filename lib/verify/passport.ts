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
import { effectivePassportStatus, type PassportValidity } from "@/lib/passport-validity";

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
  // The deadlines, published rather than only applied. `status` answers "is
  // this good NOW"; a counterparty holding a receipt needs "was it good THEN",
  // and only the dates let them work that out for themselves.
  "expiresAt",
  "retired",
  "owner",
] as const;

/**
 * The complete public owner field set, pinned the same way. `tier` is the one
 * that matters: it says how much the binding is worth, and it is the ONLY thing
 * the page may key a "verified" label off. `kind` records the method attempted,
 * which is not the same claim.
 */
export const PUBLIC_OWNER_FIELDS = ["kind", "subject", "tier", "verifiedAt", "company"] as const;

/**
 * The complete public company field set. Pinned like the two above, and kept a
 * SEPARATE OBJECT rather than flattened onto the owner on purpose: a template
 * that renders `owner.subject` and `owner.tier` together cannot accidentally
 * pick up a company name as though it were part of the proof.
 *
 * There is no address here and there never should be. The registers return one;
 * lib/owner/company.ts does not read it and db/migrations/0048 has no column for
 * it, so a postal address of a real place cannot reach a public URL by anyone
 * forgetting a rule.
 */
export const PUBLIC_COMPANY_FIELDS = ["id", "source", "name", "active", "checkedAt"] as const;

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

/**
 * Re-exported from the one place the rule lives, so this surface and the
 * operator-profile listing cannot drift into two different vocabularies again.
 * `expired` is DERIVED from a deadline and is never a stored value.
 */
export type PublicPassportStatus = PassportValidity;

/** How the owner was established. Records the method, NOT the proof — see tier. */
export type PublicOwnerKind = "self_attested" | "domain" | "github" | "idv";

/** Which free register the identifier was looked up in. */
export type PublicCompanySource = "vat" | "lei";

/**
 * What was actually proven. `unverified` means an operator typed a name and
 * nothing was checked. Anything the page words as "verified" must come from
 * here, never from kind.
 */
export type PublicOwnerTier = "unverified" | "domain" | "github" | "idv";

/**
 * A register entry the owner ASSERTS. Not a tier, not evidence about this
 * tenant, and never allowed to become either.
 *
 * What it says is narrow and true: this identifier exists in a public register,
 * resolves to this legal name, and was in this state when we last asked. What it
 * does not say — and what every surface rendering it must make plain — is that
 * the tenant is that company. A register is a public record anyone can quote,
 * with nowhere to publish a token, which is exactly why nothing free can prove
 * it. See db/migrations/0048.
 */
export interface PublicCompanyView {
  id: string;
  source: PublicCompanySource;
  name: string | null;
  active: boolean;
  checkedAt: string | null;
}

export interface PublicOwnerView {
  kind: PublicOwnerKind;
  subject: string;
  tier: PublicOwnerTier;
  verifiedAt: string | null;
  /** null when nothing was asserted. Independent of tier in both directions. */
  company: PublicCompanyView | null;
}

/** Present only when the id asked about is a key retired by rotation. */
export interface PublicRetiredKeyView {
  /** When it stops authenticating. Null means the deadline is unreadable. */
  notValidAfter: string | null;
}

export interface PublicPassportView {
  passportId: string;
  displayId: string;
  status: PublicPassportStatus;
  issuedAt: string | null;
  /** null = never expires, which is every passport issued before 0021. */
  expiresAt: string | null;
  /** null when the CURRENT key was presented — the common case. */
  retired: PublicRetiredKeyView | null;
  /** null when no owner is bound, or when the owner has not published one. */
  owner: PublicOwnerView | null;
}

export type PublicPassportResult =
  | { ok: true; passport: PublicPassportView }
  | { ok: false; reason: "not_found" | "throttled" | "unavailable" | "ambiguous" };

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

// normalizeStatus is gone: the enum value alone was never the answer. An
// `active` row whose expires_at has passed is refused by the gateway, and this
// page vouched for it — so the status is now derived from the row's deadlines
// by lib/passport-validity.ts, which the operator-profile listing also calls.

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
  return value === "domain" || value === "github" || value === "idv" ? value : "unverified";
}

function normalizeKind(value: unknown): PublicOwnerKind {
  return value === "domain" || value === "github" || value === "idv" ? value : "self_attested";
}

/**
 * Build the company line, or nothing.
 *
 * Two rules, both downward like every other normaliser in this file. A register
 * this build does not recognise is dropped entirely rather than rendered under a
 * label nothing can check. And `active` is missing-means-false: a null column was
 * never written, and turning that into "not active" is safe where turning it into
 * "active" would publish a claim about somebody's company that no register made.
 */
export function buildPublicCompanyView(row: Record<string, unknown>): PublicCompanyView | null {
  const id = typeof row.owner_company_id === "string" ? row.owner_company_id.trim() : "";
  if (!id) return null;

  const source = row.owner_company_source;
  if (source !== "vat" && source !== "lei") return null;

  const name =
    typeof row.owner_company_name === "string" && row.owner_company_name.trim()
      ? row.owner_company_name.trim()
      : null;

  return {
    id,
    source,
    name,
    active: row.owner_company_active === true,
    checkedAt: issueDate(row.owner_company_at),
  };
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
    // Deliberately NOT gated on tier. A company line beside `unverified` is a
    // legitimate state — somebody named a real registered company and proved
    // control of nothing — and hiding a checkable fact is as wrong as promoting
    // an unchecked one. It renders, and the tier beside it still says nothing
    // was proven.
    company: buildPublicCompanyView(row),
  };
}

/**
 * Build the public view by naming every field, never by spreading the row. A
 * column added to the SQL function later is dropped here silently rather than
 * leaking through.
 */
export function buildPublicPassportView(
  row: unknown,
  presentedId?: string
): PublicPassportView | null {
  if (!isRecord(row)) return null;

  // The answer is about the key that was ASKED about. When a retired key is
  // matched, the row carries the agent's CURRENT key — so building from the row
  // alone answered about a different key than the caller named, and disclosed
  // the successor to anyone who asked about its predecessor. Neither is
  // something this page should do: a counterparty holding a receipt signed by
  // the retired key would have been handed a document about a key that did not
  // sign it. The row's own key stays the fallback so a caller that does not
  // thread the id through still describes a real passport.
  const passportId = (typeof presentedId === "string" ? presentedId.trim() : "") ||
    (typeof row.passport_pubkey === "string" ? row.passport_pubkey.trim() : "");
  if (!passportId) return null;

  // `matched_current === false` is the only thing that makes this a retired
  // key. Missing or true both mean the current one — an older function that
  // does not return the flag must not turn every passport into a retired one.
  const usedRetiredKey = row.matched_current === false;
  const previousValidUntil = issueDate(row.previous_valid_until);

  return {
    passportId,
    displayId: abbreviate(passportId),
    status: effectivePassportStatus({
      status: row.status,
      expiresAt: issueDate(row.expires_at),
      usedRetiredKey,
      retiredValidUntil: previousValidUntil,
    }),
    issuedAt: issueDate(row.created_at),
    expiresAt: issueDate(row.expires_at),
    retired: usedRetiredKey ? { notValidAfter: previousValidUntil } : null,
    owner: buildPublicOwnerView(row),
  };
}

/**
 * Does more than one identity answer to this key?
 *
 * `passport_pubkey` and `previous_passport_pubkey` are unique only within their
 * own column, so one id can be tenant A's current key and tenant V's retired
 * one. findAuthenticatablePassport refuses that rather than guess an identity —
 * "a valid signature attributed to the wrong tenant" is what boundary #1 exists
 * to prevent — and publishing a guess here would state on a page anyone can
 * read exactly the thing the gateway declines to decide.
 *
 * The RPC returns a COUNT, never the colliding identities: this surface needs
 * to know that a collision exists and has no business knowing whose. A missing
 * or unreadable count is treated as no collision, which is the pre-0052
 * behaviour and keeps an older function working rather than refusing every
 * passport on an instance that has not migrated yet.
 */
function isAmbiguous(row: Record<string, unknown>): boolean {
  const matched = Number(row.matched_rows);
  return Number.isFinite(matched) && matched > 1;
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

  const row = Array.isArray(data) ? data[0] ?? null : data ?? null;
  if (!isRecord(row)) return { ok: false, reason: "not_found" };
  if (isAmbiguous(row)) return { ok: false, reason: "ambiguous" };

  const view = buildPublicPassportView(row, id);
  if (!view) return { ok: false, reason: "not_found" };
  return { ok: true, passport: view };
}
