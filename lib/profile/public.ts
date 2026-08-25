// The public operator profile — what a stranger at /@handle is allowed to see.
//
// Modelled on lib/verify/passport.ts, and pinned the same way: 0033 fixes what
// the database will return, and the field lists below fix what the page can
// render. Either alone would keep a private column off a public URL; both means
// a mistake has to be made twice.
//
// The limiter lives INSIDE lookupPublicProfile() for the reason PAVP states: a
// page cannot forget to throttle a lookup it does not perform itself. One
// limiter call covers both RPCs, because one page view is one request no matter
// how many round trips it takes.
//
// NOT reused from lib/verify/passport.ts, deliberately: buildPublicOwnerView().
// public_operator_profile omits `owner_kind` entirely (0033 argues that a field
// which cannot be read cannot be misread), so that builder would find
// `undefined` and normalise it to "self_attested" — printing "self-attested"
// beside a domain-verified tier. The owner view here names only what 0033
// actually returns.
//
// NO React cache() wrapper here either, and that is not an oversight. `cache` is
// exported by the React that Next bundles for server components, not by the
// react 18.3.1 that vitest resolves — importing it here would make this module
// untestable in node. The page wraps this function instead, which is where the
// per-request dedup between generateMetadata() and the body is needed.
import type { SupabaseClient } from "@supabase/supabase-js";

import { rateLimit } from "@/lib/ratelimit";
import { HANDLE_PATTERN, normalizeHandle } from "./handle";

/**
 * The complete public profile field set. Widening the page means editing this
 * list deliberately and watching a test go red first.
 *
 * Absent on purpose, and each for its own reason: the tenant uuid (0015 — never
 * name the tenant on a public surface), email and plan (obvious), `timezone` (a
 * coarse location signal that exists so the operator's OWN dashboard can format
 * times), and `avatar_path` (the private storage key; `avatarKey` is the
 * unguessable capability token that stands in for it).
 */
export const PUBLIC_PROFILE_FIELDS = [
  "handle",
  "displayName",
  "bio",
  "websiteUrl",
  "company",
  "avatarKey",
  "memberSince",
  "verified",
  "owner",
  "publishedAgentCount",
] as const;

/**
 * `tier` is the field that matters and the ONLY one a "verified" label may key
 * off — 0017's rule, restated because it is the one that is easy to lose.
 * `kind` records the method attempted, which is a different claim, and 0033
 * does not return it at all.
 */
export const PUBLIC_PROFILE_OWNER_FIELDS = ["subject", "tier", "verifiedAt"] as const;

export const PUBLIC_PROFILE_AGENT_FIELDS = [
  "passportId",
  "displayId",
  "label",
  "status",
  "issuedAt",
] as const;

/** Anonymous callers get the same modest budget PAVP gives them. */
export const PUBLIC_PROFILE_LIMIT = 30;
export const PUBLIC_PROFILE_WINDOW_SECONDS = 60;

/** How many published agents one page shows. The SQL function clamps to 100. */
export const PUBLIC_PROFILE_AGENT_CAP = 24;

/** Characters kept at each end when abbreviating a passport id, as PAVP does. */
const DISPLAY_EDGE = 8;

export type PublicAgentStatus = "active" | "suspended" | "revoked" | "unknown";
export type PublicOwnerTier = "unverified" | "domain" | "idv";

export interface PublicProfileOwnerView {
  subject: string;
  tier: PublicOwnerTier;
  verifiedAt: string | null;
}

export interface PublicProfileView {
  handle: string;
  displayName: string | null;
  bio: string | null;
  websiteUrl: string | null;
  company: string | null;
  /** Feeds /avatars/<key>. Null when the operator has no avatar. */
  avatarKey: string | null;
  memberSince: string | null;
  /** True only when the server-only platform registry has a current row. */
  verified: boolean;
  /** Null when no owner is bound, or when the owner has not published one. */
  owner: PublicProfileOwnerView | null;
  publishedAgentCount: number;
}

export interface PublicProfileAgentView {
  passportId: string;
  displayId: string;
  label: string;
  status: PublicAgentStatus;
  issuedAt: string | null;
}

export type PublicProfileResult =
  | { ok: true; profile: PublicProfileView; agents: PublicProfileAgentView[] }
  | { ok: false; reason: "not_found" | "throttled" | "unavailable" };

type ProfileDatabase = Pick<SupabaseClient, "rpc">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function date(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

/**
 * Only the tiers the schema defines are named, and anything else resolves to
 * `unverified` — never upward. An unrecognised tier is schema drift, and drift
 * that renders as "verified" would be a false claim about somebody's identity
 * on a page meant to be quotable. Same discipline as PAVP's normalizeTier; it
 * is re-implemented here rather than imported because that one is not exported.
 */
function normalizeTier(value: unknown): PublicOwnerTier {
  return value === "domain" || value === "idv" ? value : "unverified";
}

/** Drift resolves to "unknown", never to "active". Same rule, same reason. */
function normalizeStatus(value: unknown): PublicAgentStatus {
  switch (value) {
    case "active":
    case "suspended":
    case "revoked":
      return value;
    default:
      return "unknown";
  }
}

function abbreviate(passportId: string): string {
  if (passportId.length <= DISPLAY_EDGE * 2 + 1) return passportId;
  return `${passportId.slice(0, DISPLAY_EDGE)}…${passportId.slice(-DISPLAY_EDGE)}`;
}

/**
 * The owner block, or null when there is none.
 *
 * 0033 LEFT JOINs a *published* owner binding, so every owner column is NULL
 * for an operator who has one but has not published it — which is a deliberate
 * choice they made, and this returns null for it exactly as if there were none.
 */
export function buildPublicProfileOwnerView(
  row: Record<string, unknown>
): PublicProfileOwnerView | null {
  const subject = text(row.owner_subject);
  if (!subject) return null;

  const tier = normalizeTier(row.owner_tier);
  return {
    subject,
    tier,
    // A tier that proves nothing has no verification date to show. Reporting
    // one would dress a self-attested claim as a checked one.
    verifiedAt: tier === "unverified" ? null : date(row.owner_verified_at),
  };
}

/**
 * Build the view by naming every field, never by spreading the row. A column
 * added to the SQL function later is dropped here silently rather than leaking
 * through to a public page.
 */
export function buildPublicProfileView(row: unknown): PublicProfileView | null {
  if (!isRecord(row)) return null;

  const handle = text(row.username);
  // No handle means no page. The RPC filters on username, so this is a
  // belt-and-braces guard against a row that somehow arrives without one.
  if (!handle) return null;

  const count = Number(row.published_agent_count);

  return {
    handle,
    displayName: text(row.display_name),
    bio: text(row.bio),
    websiteUrl: text(row.website_url),
    company: text(row.company),
    avatarKey: text(row.avatar_key),
    memberSince: date(row.member_since),
    // Exact boolean only. Schema drift, strings and numbers all resolve down
    // to no badge; a public identity surface must never guess upward.
    verified: row.is_verified === true,
    owner: buildPublicProfileOwnerView(row),
    publishedAgentCount: Number.isFinite(count) && count > 0 ? Math.floor(count) : 0,
  };
}

/**
 * One published agent. Both a passport id and a label are required: 0033
 * filters for both, and a row missing either is a row this page cannot render
 * honestly — an unverifiable entry, or a blank one that invites somebody to
 * "fix" it by falling back to the internal agent name.
 */
export function buildPublicProfileAgentView(row: unknown): PublicProfileAgentView | null {
  if (!isRecord(row)) return null;

  const passportId = text(row.passport_pubkey);
  const label = text(row.label);
  if (!passportId || !label) return null;

  return {
    passportId,
    displayId: abbreviate(passportId),
    label,
    status: normalizeStatus(row.status),
    issuedAt: date(row.created_at),
  };
}

function firstRow(data: unknown): unknown {
  if (Array.isArray(data)) return data[0] ?? null;
  return data ?? null;
}

/**
 * Resolve one operator profile, and their published agents, for an anonymous
 * visitor.
 *
 * Order is deliberate, and matches lookupPublicPassport(): shape check, then
 * limiter, then database. A malformed handle costs nothing, and a throttled
 * caller never reaches the database at all.
 *
 * A database failure reports `unavailable`, never `not_found`. Rendering "no
 * such operator" during an outage would be a false statement about somebody's
 * identity. The agents query gets the same treatment for a subtler reason: the
 * profile carries `publishedAgentCount`, so a failed list would render "3
 * published agents" above an empty list, and a stranger cannot tell that apart
 * from an operator whose agents were withdrawn.
 */
export async function lookupPublicProfile(
  db: ProfileDatabase,
  handle: unknown,
  clientIp: string
): Promise<PublicProfileResult> {
  const normalized = normalizeHandle(handle);
  if (!HANDLE_PATTERN.test(normalized)) return { ok: false, reason: "not_found" };

  const limit = await rateLimit(
    `profile:${clientIp}`,
    PUBLIC_PROFILE_LIMIT,
    PUBLIC_PROFILE_WINDOW_SECONDS
  );
  if (!limit.success) return { ok: false, reason: "throttled" };

  const profileQuery = await db.rpc("public_operator_profile", { p_handle: normalized });
  if (profileQuery.error) return { ok: false, reason: "unavailable" };

  const profile = buildPublicProfileView(firstRow(profileQuery.data));
  if (!profile) return { ok: false, reason: "not_found" };

  // Only now. An operator whose profile is private must cost exactly one query,
  // and must not have their agent list read at all.
  const agentQuery = await db.rpc("public_operator_agents", {
    p_handle: normalized,
    p_limit: PUBLIC_PROFILE_AGENT_CAP,
  });
  if (agentQuery.error) return { ok: false, reason: "unavailable" };

  const rows = Array.isArray(agentQuery.data) ? agentQuery.data : [];
  const agents = rows
    .map((row) => buildPublicProfileAgentView(row))
    .filter((view): view is PublicProfileAgentView => view !== null);

  return { ok: true, profile, agents };
}
