// Tenant-side writes to the operator profile.
//
// Every function here takes a service-role client, because 0032 revokes
// insert/update/delete on public.users from `authenticated` and `anon`. That is
// deliberate and it is the same posture agent_owners has had since 0017: RLS can
// only ask who owns a row, never whether the session that is writing it cleared a
// second factor, so the check has to happen in code above the write.
//
// The rule that comes with that: `userId` is always the id of a session verified
// by the caller (mfaAuthorizedUser -> gate.user.id), never a value taken from
// client input. lib/owner/manage.ts states the same rule and is the model for
// this file generally.
//
// Naming note, because there is a trap next door: do NOT introduce a const here
// called PUBLIC_COLS. lib/owner/manage.ts:42 has one, and despite the name it
// includes the secret `verification_token`. The genuinely public field lists for
// this feature live in lib/profile/public.ts and nowhere else.
import type { SupabaseClient, User } from "@supabase/supabase-js";

import { bytesToBase64url } from "@/lib/encoding";
import { validateHandle } from "./handle";
import { normalizeWebsiteUrl } from "./url";

type ProfileDatabase = Pick<SupabaseClient, "from">;
/** setHandle also needs `rpc` — 0034 does the change atomically in one call. */
type HandleDatabase = Pick<SupabaseClient, "from" | "rpc">;

/**
 * Reject a timezone the runtime cannot format with, rather than storing a
 * string that throws at render time. Intl is the authority here — there is no
 * hardcoded zone list to fall out of date.
 */
function isKnownTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * Columns updateProfile() will write. Everything else on public.users — id,
 * email, plan, created_at — is set by the system.
 *
 * `username` and `profile_public` are NOT here, and their absence is the point.
 * Both carry a mandatory side effect that lives outside the write:
 *
 *   username        retires the handle it replaces, or an old /@handle link
 *                   silently starts resolving to a different operator.
 *   profile_public  rotates avatar_key when it goes false, which is the ONLY
 *                   thing that revokes an avatar URL somebody already has —
 *                   avatar_object_path() in 0033 does not check profile_public.
 *
 * A generic field-mapping loop that accepted either would skip its handler and
 * look completely correct doing it. setHandle() and setProfilePublic() own
 * them, and updateProfile() drops anything not on this list.
 */
export const PROFILE_EDITABLE_FIELDS = [
  "display_name",
  "bio",
  "website_url",
  "company",
  "timezone",
] as const;

/** The two that must go through their own function. Named so the rule above is
 *  assertable rather than merely written down. */
export const PROFILE_SIDE_EFFECT_FIELDS = ["username", "profile_public"] as const;

/**
 * No row in public.users is created at signup. Not by app/actions/auth.ts, not
 * by app/auth/callback, and not by any trigger — there are none on auth.users.
 * Rows appear lazily: inside store_provider_key (0001/0027/0030), inside
 * redeem_beta_invite (0025), and at the two agent-creation call sites in
 * app/dashboard/actions.ts.
 *
 * So a freshly signed-up operator who has not yet stored a provider key or
 * created an agent has NO profile row, and every writer has to be prepared to
 * create one. Readers must tolerate null rather than assume one exists.
 *
 * Kept lazy on purpose. A trigger on auth.users would be tidier, but it adds a
 * cross-schema trigger to a security product to solve what an upsert solves, and
 * it would not backfill the users who already exist without one.
 */
export async function ensureProfileRow(admin: SupabaseClient, user: User): Promise<void> {
  const { error } = await admin
    .from("users")
    .upsert({ id: user.id, email: user.email }, { onConflict: "id" })
    .select("id");
  if (error) throw new Error("profile_row_unavailable");
}

/**
 * The profile as its OWNER reads it. `avatar_path` and `avatar_key` are in here
 * because the operator's own settings page needs them; neither belongs on a
 * public surface, and neither is in lib/profile/public.ts.
 *
 * Not named PUBLIC_COLS — see the header. lib/owner/manage.ts has a const by
 * that name whose contents include a secret.
 */
const PROFILE_COLS =
  "username, display_name, bio, website_url, company, timezone, profile_public, avatar_path, avatar_key, handle_locked_at, created_at";

export interface ProfileRecord {
  username: string | null;
  display_name: string | null;
  bio: string | null;
  website_url: string | null;
  company: string | null;
  timezone: string | null;
  profile_public: boolean;
  avatar_path: string | null;
  avatar_key: string | null;
  /** When the handle became permanent (0034). Null = never published, still
   *  free to change. Set once at first publish and never cleared. */
  handle_locked_at: string | null;
  created_at: string;
}

export type ProfileResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; code: string };

/** Mirrors the CHECK constraints in 0033. Rejecting here gives the operator a
 *  message; letting it reach the write gives them an unmapped 23514. */
const FIELD_LIMITS: Record<string, number> = {
  display_name: 60,
  bio: 280,
  company: 80,
  // No column constraint backs this one — it is an IANA zone name, and the
  // bound is here to stop an unbounded string reaching the row.
  timezone: 64,
};

/** Postgres error codes this module has an opinion about. */
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";

function pgCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : "";
}

/**
 * 128 bits of randomness, standing in for the storage path on public surfaces.
 *
 * It is a capability: possession of the key is what grants the avatar bytes,
 * because avatar_object_path() in 0033 is keyed on it and on nothing else. That
 * is deliberate — it keeps the tenant uuid off every public page, and it means
 * the operator's own sidebar chip works identically whether their profile is
 * public or not. The cost is that rotating the key is the only revocation, so
 * every caller that changes what should be visible must rotate it.
 */
export function newAvatarKey(): string {
  return bytesToBase64url(crypto.getRandomValues(new Uint8Array(16)));
}

/**
 * Read the operator's own profile.
 *
 * Returns null rather than an error when there is no row: ensureProfileRow()'s
 * note explains why a freshly signed-up operator legitimately has none, and a
 * reader that treats that as a failure would break the dashboard for every new
 * account.
 */
export async function readProfile(
  admin: ProfileDatabase,
  userId: string
): Promise<ProfileResult<ProfileRecord | null>> {
  const { data, error } = await admin
    .from("users")
    .select(PROFILE_COLS)
    .eq("id", userId) // tenant boundary — service_role bypasses RLS
    .maybeSingle();

  if (error) return { ok: false, status: 500, code: "query_failed" };
  return { ok: true, data: (data as ProfileRecord | null) ?? null };
}

async function patchProfile(
  admin: ProfileDatabase,
  userId: string,
  patch: Record<string, unknown>
): Promise<ProfileResult<ProfileRecord>> {
  const { data, error } = await admin
    .from("users")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", userId) // tenant boundary — service_role bypasses RLS
    .select(PROFILE_COLS)
    .maybeSingle();

  if (error) {
    // The trigger in 0033 raises unique_violation for a RETIRED handle too, and
    // that is the whole point: a caller cannot tell "taken" from "was once
    // used", so there is no oracle for which handles have ever existed.
    if (pgCode(error) === UNIQUE_VIOLATION) return { ok: false, status: 409, code: "handle_taken" };
    if (pgCode(error) === CHECK_VIOLATION) return { ok: false, status: 400, code: "invalid_value" };
    return { ok: false, status: 500, code: "write_failed" };
  }
  // No error and no row means there is no profile row to patch. The caller was
  // supposed to run ensureProfileRow() first; say so rather than reporting a
  // successful write of nothing.
  if (!data) return { ok: false, status: 409, code: "no_profile" };
  return { ok: true, data: data as ProfileRecord };
}

/**
 * Update the plain profile fields.
 *
 * Every field is validated here rather than only in the server action, on the
 * same reasoning that puts the limiter inside lookupPublicPassport(): a second
 * caller added later cannot skip a check it does not have to remember.
 *
 * Anything outside PROFILE_EDITABLE_FIELDS is dropped, including `username` and
 * `profile_public` — those have their own functions because they have side
 * effects this generic path does not perform.
 */
export async function updateProfile(
  admin: ProfileDatabase,
  userId: string,
  input: Record<string, unknown>
): Promise<ProfileResult<ProfileRecord>> {
  const patch: Record<string, unknown> = {};

  for (const field of PROFILE_EDITABLE_FIELDS) {
    if (!(field in input)) continue;

    if (field === "website_url") {
      const url = normalizeWebsiteUrl(input[field]);
      if (!url.ok) return { ok: false, status: 400, code: "invalid_website" };
      patch[field] = url.url;
      continue;
    }

    const raw = input[field];
    const value = typeof raw === "string" ? raw.trim() : "";
    if (!value) {
      // Clearing a field is a legitimate edit. Null rather than "" so the
      // column's `is null` checks and the view's falsiness agree.
      patch[field] = null;
      continue;
    }
    const limit = FIELD_LIMITS[field] ?? 0;
    if (limit && value.length > limit) return { ok: false, status: 400, code: `${field}_too_long` };
    if (field === "timezone" && !isKnownTimeZone(value)) {
      return { ok: false, status: 400, code: "invalid_timezone" };
    }
    patch[field] = value;
  }

  // An empty patch is reported, not quietly succeeded. If a caller ever sends
  // only `username` and `profile_public` — the two fields this function drops —
  // returning ok would tell the operator their edit was saved when nothing was
  // written at all. Loud beats plausible.
  if (Object.keys(patch).length === 0) return { ok: false, status: 400, code: "no_changes" };

  return patchProfile(admin, userId, patch);
}

/**
 * Claim or change a handle.
 *
 * ONE DATABASE CALL, and that is the point. This used to be two statements —
 * insert the retirement row, then update the username — ordered retire-first so
 * that a failure in between left the operator holding a handle that was also
 * marked retired (harmless) rather than releasing a name a stranger could
 * immediately claim (an impersonation vector).
 *
 * That ordering was correct and still cost something: a REFUSED change retired
 * the handle the operator kept, quietly removing their ability to return to
 * their own name later. 0034's change_handle() does both writes in one
 * transaction, so the retirement rolls back with the update it belongs to and
 * there is no interleaving left to reason about.
 *
 * The reserved-word and shape checks stay here rather than in SQL: the database
 * has no list of route names, and this is the only path that writes a handle.
 */
export async function setHandle(
  admin: HandleDatabase,
  userId: string,
  input: unknown
): Promise<ProfileResult<ProfileRecord>> {
  const candidate = validateHandle(input);
  if (!candidate.ok) return { ok: false, status: 400, code: candidate.reason };

  const { data, error } = await admin.rpc("change_handle", {
    p_user_id: userId,
    p_new_username: candidate.handle,
  });
  if (error) return { ok: false, status: 500, code: "write_failed" };

  const row = Array.isArray(data) ? data[0] : data;
  const status = row && typeof row === "object" ? (row as { status?: unknown }).status : null;

  switch (status) {
    case "ok":
      break;
    case "no_profile":
      return { ok: false, status: 409, code: "no_profile" };
    case "locked":
      return { ok: false, status: 409, code: "handle_locked" };
    // 0040 puts the list in Postgres as well as this build. This branch matters
    // during a rolling deploy: a newer database may know a protected identity
    // an older application bundle does not. Drift still refuses the claim.
    case "reserved":
      return { ok: false, status: 409, code: "reserved_handle" };
    // Held by somebody, or retired. Deliberately the same answer for both —
    // 0033 raises unique_violation for the retired case precisely so there is
    // no oracle for which handles have ever been used.
    case "taken":
      return { ok: false, status: 409, code: "handle_taken" };
    default:
      return { ok: false, status: 500, code: "write_failed" };
  }

  // The function returns only what it changed; the caller wants the whole row.
  const current = await readProfile(admin, userId);
  if (!current.ok) return current;
  if (!current.data) return { ok: false, status: 409, code: "no_profile" };
  return { ok: true, data: current.data };
}

/**
 * Publish or unpublish the whole profile.
 *
 * Going private rotates avatar_key, and that is not a nicety. 0033's
 * avatar_object_path() looks up an avatar by key alone and does NOT check
 * profile_public — deliberately, so the operator's own sidebar chip keeps
 * working while their profile is private. Rotation is therefore the only thing
 * that revokes an avatar URL a stranger already copied. Forget it and going
 * private leaves every previously shared avatar URL live.
 *
 * Publishing requires a handle. A public profile with no handle has no address
 * to be public AT, and profile_public would silently mean nothing.
 */
export async function setProfilePublic(
  admin: ProfileDatabase,
  userId: string,
  isPublic: boolean
): Promise<ProfileResult<ProfileRecord>> {
  const current = await readProfile(admin, userId);
  if (!current.ok) return current;
  if (!current.data) return { ok: false, status: 409, code: "no_profile" };
  if (isPublic && !current.data.username) return { ok: false, status: 400, code: "no_handle" };

  return patchProfile(admin, userId, {
    profile_public: isPublic,
    // Stamped once, the first time this profile becomes public, and never
    // cleared — not even by un-publishing. From here the handle is an address
    // other people may have written down. Un-publishing does not un-write it.
    ...(isPublic && !current.data.handle_locked_at
      ? { handle_locked_at: new Date().toISOString() }
      : {}),
    // Rotate only when there is something to revoke. Minting a key for an
    // operator with no stored avatar produced a key with no object behind it,
    // and 0033's profile RPC used to publish it — so the public page rendered
    // an <img> pointing at a guaranteed 404. The RPC now refuses to publish
    // such a key as well; this stops the state being created at all.
    ...(isPublic || !current.data.avatar_path ? {} : { avatar_key: newAvatarKey() }),
  });
}

/**
 * Where one avatar key's bytes live.
 *
 * The key is IN the path, and that is the whole point. `/avatars/<key>` is
 * served `immutable` for a year on the claim that a key can only ever name one
 * set of bytes — which holds only if two keys can never name the same object.
 * A per-user path overwritten in place breaks it: the previous key, still live
 * until the row update lands, resolves straight to the replacement image.
 *
 * Keeping the owner's uuid as the prefix is what lets the bucket's own policies
 * stay per-owner; the uuid never reaches a public surface, because the public
 * surface only ever carries the key (see app/avatars/[key]/route.ts).
 */
export function avatarObjectPath(userId: string, key: string): string {
  return `${userId}/${key}`;
}

/**
 * Point the profile at freshly uploaded avatar bytes.
 *
 * The key is supplied rather than minted here: the caller needs it BEFORE the
 * upload, to build the object path from it. Minting a second one at this point
 * would hand back a key that names nothing.
 *
 * A new key every time, so a previously shared /avatars/<key> URL stops
 * resolving rather than silently serving the new picture — and so the URL can
 * be cached `immutable`, which is the whole reason the key exists.
 */
export async function setAvatar(
  admin: ProfileDatabase,
  userId: string,
  objectPath: string,
  avatarKey: string
): Promise<ProfileResult<ProfileRecord>> {
  if (!objectPath.trim()) return { ok: false, status: 400, code: "invalid_avatar_path" };
  // A blank key would store bytes that avatar_object_path() can never resolve.
  if (!avatarKey.trim()) return { ok: false, status: 400, code: "invalid_avatar_key" };
  return patchProfile(admin, userId, { avatar_path: objectPath, avatar_key: avatarKey });
}

/**
 * Forget the avatar. Clears the key as well as the path: leaving a key behind
 * would leave a live URL for an object the operator asked us to stop showing.
 *
 * Removing the stored object is the caller's job — this module does not touch
 * Storage.
 */
export async function clearAvatar(
  admin: ProfileDatabase,
  userId: string
): Promise<ProfileResult<ProfileRecord>> {
  return patchProfile(admin, userId, { avatar_path: null, avatar_key: null });
}
