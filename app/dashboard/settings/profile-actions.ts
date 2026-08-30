"use server";
// The operator profile, from the Settings page.
//
// Modelled on app/dashboard/owner-actions.ts, including the two rules that file
// exists to preserve, because they apply here for the same reasons:
//
// 1. THE SERVICE-ROLE CLIENT IS USED DELIBERATELY, NOT LAZILY. 0032 revokes
//    insert/update/delete on public.users from `authenticated`, so a
//    userClient() could not write these columns even if we wanted it to. The
//    tenant boundary is therefore enforced HERE, in code: the userId comes from
//    the verified session and is passed explicitly, never taken from an
//    argument. RLS can only ask who owns a row, never whether the session
//    writing it cleared a second factor.
//
// 2. Declaring is not publishing. `profile_public` is its own action with its
//    own confirmation wording, and it publishes NO agent — agents.published is
//    a second, independent opt-in. The UI is required to say so.
//
// ── Two things specific to this file ────────────────────────────────────────
//
// actingUser() creates the profile row. Nothing creates one at signup (see
// ensureProfileRow's note), so without this a brand-new operator would open
// Settings, type a display name, and get `no_profile` with no way forward.
// Doing it at the gate means every action below inherits it and none of them
// has to remember.
//
// changeHandle() is rate-limited, and it is the only write here that is. Every
// other field can be set back to what it was; a handle change permanently
// consumes an entry in a GLOBAL namespace, because 0033 retires the old handle
// rather than recycling it. Unthrottled, one authenticated account could burn
// arbitrarily many handles out of everyone's reach, and retirement is by design
// irreversible — so that is not a state anybody can clean up afterwards.
import { revalidatePath } from "next/cache";

import { recordAdminAction } from "@/lib/audit";
import { mfaAuthorizedUser } from "@/lib/mfa";
import { AVATAR_MAX_BYTES, sniffAvatar, stripAvatarMetadata } from "@/lib/profile/image";
import {
  avatarObjectPath,
  clearAvatar,
  ensureProfileRow,
  newAvatarKey,
  readProfile,
  setAvatar,
  setHandle,
  setProfilePublic,
  updateProfile,
  type ProfileRecord,
} from "@/lib/profile/manage";
import { rateLimit } from "@/lib/ratelimit";
import { serviceClient } from "@/lib/supabase";
import { userClient } from "@/lib/supabase/server";

/** Deliberately tight — see the header. A typo costs one of these; squatting the
 *  namespace costs all of them and then has to wait an hour. */
const HANDLE_LIMIT = 5;
const HANDLE_WINDOW_S = 3600;

/** Uploads are cheap for us and expensive for the free-tier storage quota. */
const AVATAR_LIMIT = 10;
const AVATAR_WINDOW_S = 600;

/** The bucket created by 0033. Private: every byte moves through our own server. */
const AVATAR_BUCKET = "avatars";

function avatarCleanupNotice(): string {
  return "Your avatar was removed and its link no longer works. The stored file could not be deleted — contact the operator of this instance.";
}

export interface ProfileActionState {
  profile?: ProfileRecord | null;
  error?: string;
  /** Set on success so the form can confirm what happened, not merely stop spinning. */
  notice?: string;
}

/**
 * Resolve the acting tenant, ensure they have a profile row, or fail.
 *
 * Two clients on purpose, exactly as in owner-actions.ts: the cookie-bound one
 * answers "who is this and have they cleared MFA", the service-role one does
 * the write. Mixing them up in either direction is the whole risk in this file.
 */
async function actingUser(): Promise<{ userId: string } | { error: string }> {
  const db = await userClient();
  const gate = await mfaAuthorizedUser(db);
  if (!gate.ok) {
    return {
      error:
        gate.reason === "step_up_required"
          ? "Complete two-factor verification to change your profile."
          : gate.reason === "unauthenticated"
            ? "Sign in again to change your profile."
            : "Your authentication assurance could not be verified. Try again.",
    };
  }

  try {
    await ensureProfileRow(serviceClient(), gate.user);
  } catch {
    return { error: "Your profile could not be opened. Please try again." };
  }
  return { userId: gate.user.id };
}

/** A library failure, in words an operator can act on. Never leaks a DB code. */
function explain(code: string): string {
  switch (code) {
    case "invalid_handle":
      return "A handle is 3–30 characters: lowercase letters, numbers and underscores, starting and ending with a letter or number.";
    case "reserved_handle":
      return "That handle is reserved.";
    // 0033 raises the same error for a handle somebody holds and for one that
    // was released and retired, on purpose — so this message covers both and
    // gives away neither. Saying "that one used to exist" would hand back an
    // oracle for which handles have ever been used.
    case "handle_taken":
      return "That handle is not available.";
    // Not phrased as a refusal to be argued with: the handle is genuinely gone
    // as a thing that can move, and the operator should know why rather than
    // wonder whether they are holding the form wrong.
    case "handle_locked":
      return "Your handle is permanent now. It became fixed when you first published your profile, because other people may have linked to it.";
    case "no_handle":
      return "Choose a handle first — a public profile needs an address to be public at.";
    case "invalid_website":
      return "That link cannot be used. Enter a plain https:// address, like vertias.eu.";
    case "invalid_timezone":
      return "That is not a time zone we recognise.";
    case "display_name_too_long":
      return "Your display name is too long (60 characters maximum).";
    case "bio_too_long":
      return "Your bio is too long (280 characters maximum).";
    case "company_too_long":
      return "Your company is too long (80 characters maximum).";
    case "no_changes":
      return "Nothing to save.";
    case "no_profile":
      return "Your profile could not be opened. Reload the page and try again.";
    case "retire_failed":
      return "Your handle was not changed, because the old one could not be retired. Try again.";
    default:
      return "Something went wrong. Please try again.";
  }
}

/** Save the plain profile fields. Never touches the handle or the public flag. */
export async function saveProfile(input: {
  display_name?: string;
  bio?: string;
  website_url?: string;
  company?: string;
  timezone?: string;
}): Promise<ProfileActionState> {
  const acting = await actingUser();
  if ("error" in acting) return { error: acting.error };

  const result = await updateProfile(serviceClient(), acting.userId, { ...input });
  if (!result.ok) return { error: explain(result.code) };

  await recordAdminAction({
    userId: acting.userId,
    action: "profile.update",
    targetType: "profile",
    targetId: acting.userId,
    // The values themselves are the operator's own and mostly destined for a
    // public page, but admin_audit is served by GET /api/control/v1/audit, so
    // only the field NAMES are recorded. An audit row is not a change log.
    metadata: { via: "dashboard", fields: Object.keys(input).sort() },
  });
  revalidatePath("/dashboard/settings");
  return { profile: result.data, notice: "Profile saved." };
}

/**
 * Claim or change the handle.
 *
 * Rate-limited before the write, and the limiter is consumed by a REJECTED
 * attempt too. That is intentional: a rejected attempt is also how somebody
 * would enumerate which handles are already held.
 */
export async function changeHandle(handle: string): Promise<ProfileActionState> {
  const acting = await actingUser();
  if ("error" in acting) return { error: acting.error };

  const limited = await rateLimit(`profile-handle:${acting.userId}`, HANDLE_LIMIT, HANDLE_WINDOW_S);
  if (!limited.success) {
    return { error: "Too many handle changes. A released handle is retired permanently, so this is deliberately slow. Try again later." };
  }

  const result = await setHandle(serviceClient(), acting.userId, handle);
  if (!result.ok) return { error: explain(result.code) };

  await recordAdminAction({
    userId: acting.userId,
    action: "profile.handle",
    targetType: "profile",
    targetId: acting.userId,
    metadata: { via: "dashboard", handle: result.data.username },
  });
  revalidatePath("/dashboard/settings");
  return { profile: result.data, notice: `Your handle is @${result.data.username}.` };
}

/**
 * Publish or unpublish the profile page.
 *
 * Publishing exposes the profile and NOTHING ELSE — no agent is listed until it
 * is separately published. Unpublishing rotates the avatar key inside
 * setProfilePublic(), which is what revokes an avatar URL somebody already has.
 */
export async function publishProfile(isPublic: boolean): Promise<ProfileActionState> {
  const acting = await actingUser();
  if ("error" in acting) return { error: acting.error };

  const result = await setProfilePublic(serviceClient(), acting.userId, isPublic);
  if (!result.ok) return { error: explain(result.code) };

  await recordAdminAction({
    userId: acting.userId,
    action: "profile.publish",
    targetType: "profile",
    targetId: acting.userId,
    metadata: { via: "dashboard", published: isPublic },
  });
  revalidatePath("/dashboard/settings");
  return {
    profile: result.data,
    notice: isPublic
      ? `Your profile is public at /@${result.data.username}. No agent is listed until you publish it separately.`
      : "Your profile is private again, and any avatar link you shared has stopped working.",
  };
}

/**
 * Store a new avatar.
 *
 * The key is minted FIRST and the object path is built from it, so each upload
 * occupies its own object and no two keys ever name the same bytes.
 *
 * That ordering is not a preference between two risks — it dissolves them. A
 * fixed `<userId>/avatar` overwritten in place looks safe because the key still
 * changes, but the PREVIOUS key stays live until the row update lands, and it
 * resolves through avatar_object_path() to whatever is at that path: the new
 * image. If the update then fails, it stays that way for good, while the
 * operator is told the image could not be stored. `/avatars/<key>` is served
 * `immutable` for a year on the promise that this cannot happen.
 *
 * The cost is bookkeeping, handled in both directions below: a failed row
 * update removes the object nothing now names, and a successful one removes the
 * object the previous key named.
 */
export async function uploadAvatar(formData: FormData): Promise<ProfileActionState> {
  const acting = await actingUser();
  if ("error" in acting) return { error: acting.error };

  const limited = await rateLimit(`profile-avatar:${acting.userId}`, AVATAR_LIMIT, AVATAR_WINDOW_S);
  if (!limited.success) return { error: "Too many uploads. Wait a few minutes and try again." };

  const file = formData.get("avatar");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose an image to upload." };
  // Checked before reading the body into memory, so an oversized upload costs a
  // header rather than a buffer.
  if (file.size > AVATAR_MAX_BYTES) {
    return { error: "That image is larger than 256 KB. Crop or re-save it and try again." };
  }

  // Strip before sniffing. PNG and WebP are chunked containers, so metadata
  // removal is a byte-slice — refusing the file instead was telling operators
  // to go and do by hand something the server can simply do. JPEG is still
  // refused by the sniff below, because its EXIF genuinely cannot be removed
  // without an image library.
  const bytes = stripAvatarMetadata(new Uint8Array(await file.arrayBuffer()));
  // The uploader's declared MIME type and the filename are never consulted —
  // both are claims made by whoever is uploading. Only the bytes decide.
  const sniffed = sniffAvatar(bytes);
  if (!sniffed.ok) {
    return { error: describeRejection(sniffed.reason) };
  }

  const admin = serviceClient();

  // Read the outgoing object before anything replaces it. The row is the only
  // record of where it lives, and the update below overwrites that field.
  const previous = await readProfile(admin, acting.userId);
  const previousPath = previous.ok ? (previous.data?.avatar_path ?? null) : null;

  const avatarKey = newAvatarKey();
  const objectPath = avatarObjectPath(acting.userId, avatarKey);
  const upload = await admin.storage.from(AVATAR_BUCKET).upload(objectPath, bytes, {
    // The DETECTED type, never the declared one.
    contentType: sniffed.contentType,
    // The path carries 128 bits of fresh randomness, so a collision is not a
    // real case — and overwriting would mean silently replacing bytes some
    // other key already promised were immutable.
    upsert: false,
  });
  if (upload.error) return { error: "The image could not be stored. Please try again." };

  const result = await setAvatar(admin, acting.userId, objectPath, avatarKey);
  if (!result.ok) {
    // Nothing names these bytes now. Leaving them would be an orphan in a
    // bucket with no sweep — the same thing account deletion refuses to do.
    await admin.storage.from(AVATAR_BUCKET).remove([objectPath]);
    return { error: explain(result.code) };
  }

  // The old key stopped resolving the moment the row changed, so its object is
  // unreachable. Best-effort: a failure here costs storage, not correctness.
  if (previousPath && previousPath !== objectPath) {
    await admin.storage.from(AVATAR_BUCKET).remove([previousPath]);
  }

  await recordAdminAction({
    userId: acting.userId,
    action: "profile.avatar",
    targetType: "profile",
    targetId: acting.userId,
    metadata: { via: "dashboard", content_type: sniffed.contentType },
  });
  revalidatePath("/dashboard/settings");
  return { profile: result.data, notice: "Avatar updated." };
}

/**
 * Remove the avatar.
 *
 * The row is cleared FIRST, then the object. That order is deliberate and it is
 * the opposite of the upload: clearing the row is what makes the URL stop
 * resolving, so it must not wait on a storage call that might fail. If the
 * object removal then fails, the result is an orphan nothing references — a
 * quota nuisance, not a disclosure — and it is reported rather than swallowed,
 * in the same partial-failure style account-actions.ts already uses.
 */
export async function removeAvatar(): Promise<ProfileActionState> {
  const acting = await actingUser();
  if ("error" in acting) return { error: acting.error };

  const admin = serviceClient();
  const current = await readProfile(admin, acting.userId);
  if (!current.ok) return { error: explain(current.code) };
  const objectPath = current.data?.avatar_path ?? null;

  const result = await clearAvatar(admin, acting.userId);
  if (!result.ok) return { error: explain(result.code) };

  let orphaned = false;
  if (objectPath) {
    const removal = await admin.storage.from(AVATAR_BUCKET).remove([objectPath]);
    orphaned = Boolean(removal.error);
  }

  await recordAdminAction({
    userId: acting.userId,
    action: "profile.avatar_removed",
    targetType: "profile",
    targetId: acting.userId,
    metadata: { via: "dashboard", orphaned },
  });
  revalidatePath("/dashboard/settings");
  return {
    profile: result.data,
    notice: orphaned
      ? avatarCleanupNotice()
      : "Avatar removed.",
  };
}

/** Why a file was refused, in words that say what to do about it. */
function describeRejection(reason: string): string {
  switch (reason) {
    case "too_large":
      return "That image is larger than 256 KB. Crop or re-save it and try again.";
    case "empty":
      return "That file is empty.";
    case "dimensions":
      return "That image is too large to display. Use one no bigger than 2048×2048.";
    // Stated rather than hidden: we cannot strip metadata here, so we refuse
    // files that carry it instead of silently publishing somebody's GPS
    // coordinates on a page anyone can fetch.
    case "carries_metadata":
      return "That image carries metadata we could not remove automatically. Re-save it without metadata and try again.";
    case "malformed":
      return "That file is not a complete image.";
    default:
      return "Use a PNG or WebP image. JPEG is not accepted because we cannot strip its location metadata here.";
  }
}
