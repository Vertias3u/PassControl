"use server";
// Owner binding from the Control Tower.
//
// The verification ladder itself already existed in lib/owner/manage.ts and has
// been reachable through /api/control/v1/owner since migration 0017. What was
// missing is this: a path for a human with a browser. An API key is the wrong
// instrument for the one feature whose entire purpose is telling strangers who
// stands behind a passport.
//
// ── Two rules these actions exist to preserve ───────────────────────────────
//
// 1. THE CALLER NEVER SETS `tier` OR `verified_at`. They say what they claim
//    (kind, subject) and whether to publish it; manage.ts decides what was
//    actually proven, from evidence it gathered itself. Migration 0017 grants
//    the client SELECT and nothing else for exactly this reason — so these
//    actions call the library, they never touch the table.
//
// 2. The service-role client is used deliberately, not lazily. agent_owners has
//    no insert or update policy for `authenticated` at all, so a userClient()
//    could not write it even if we wanted to. The tenant boundary is therefore
//    enforced HERE, in code: the userId comes from the verified session and is
//    passed explicitly, never taken from an argument.
import { revalidatePath } from "next/cache";

import { recordAdminAction } from "@/lib/audit";
import { mfaAuthorizedUser } from "@/lib/mfa";
import { setOwner, setOwnerPublished, verifyOwnerDomain } from "@/lib/owner/manage";
import type { OwnerRecord } from "@/lib/owner/manage";
import type { DomainFailure } from "@/lib/owner/domain";
import { rateLimit } from "@/lib/ratelimit";
import { serviceClient } from "@/lib/supabase";
import { userClient } from "@/lib/supabase/server";

// The outbound check fetches a hostname the caller chose. Unthrottled that is a
// request amplifier pointed at anything the gateway can reach — the redirect
// refusal in lib/owner/domain.ts bounds where it can go, this bounds how often.
const VERIFY_LIMIT = 10;
const VERIFY_WINDOW_S = 60;

export interface OwnerActionState {
  owner?: OwnerRecord | null;
  error?: string;
  /** Set only by checkOwnerDomain, so the form can explain a failed check. */
  reason?: DomainFailure;
}

/**
 * Resolve the acting tenant, or fail.
 *
 * Two clients on purpose: the cookie-bound one answers "who is this and have
 * they cleared MFA", the service-role one does the write. Mixing them up in
 * either direction is the whole risk in this file.
 */
async function actingUser(): Promise<{ userId: string } | { error: string }> {
  const db = await userClient();
  const gate = await mfaAuthorizedUser(db);
  if (!gate.ok) {
    return {
      error:
        gate.reason === "step_up_required"
          ? "Complete two-factor verification to change the owner."
          : gate.reason === "unauthenticated"
            ? "Sign in again to change the owner."
            : "Your authentication assurance could not be verified. Try again.",
    };
  }
  return { userId: gate.user.id };
}

/** A library failure, in words an operator can act on. Never leaks a DB code. */
function explain(code: string): string {
  switch (code) {
    case "invalid_kind":
      return "Choose whether you are claiming a name or a domain.";
    case "invalid_subject":
      return "Enter the name or domain this passport belongs to.";
    case "invalid_domain":
      return "That is not a domain we can check. Use a bare hostname, like acme.com.";
    case "no_owner":
      return "Declare an owner before publishing or checking it.";
    case "not_a_domain_owner":
      return "Only a domain claim can be checked. A name is self-attested by design.";
    case "no_verification_token":
      return "This claim has no token. Re-declare the domain to get a fresh one.";
    // The binding changed while the check was still out. Nothing was written —
    // the result belongs to the claim that was replaced, not to this one.
    case "owner_changed":
      return "The owner changed while that check was running, so it was discarded. Check again.";
    default:
      return "Something went wrong. Please try again.";
  }
}

/**
 * Declare who these passports belong to.
 *
 * Always lands at tier `unverified`, even for a domain — claiming a domain and
 * proving control of it are two different acts, and only the second moves the
 * tier. For a domain this returns a token to publish; checkOwnerDomain is what
 * goes and looks for it.
 */
export async function declareOwner(input: {
  kind: string;
  subject: string;
}): Promise<OwnerActionState> {
  const acting = await actingUser();
  if ("error" in acting) return { error: acting.error };

  const result = await setOwner(serviceClient(), acting.userId, {
    kind: input.kind,
    subject: input.subject,
    // Declaring is not publishing. A newly declared claim is never pushed onto
    // the public page or into receipts by the same click that created it.
    published: false,
  });
  if (!result.ok) return { error: explain(result.code) };

  await recordAdminAction({
    userId: acting.userId,
    action: "owner.set",
    targetType: "owner",
    targetId: acting.userId,
    // The subject is what the owner asked us to publish, so it is not a secret.
    // The token is, and is never recorded — admin_audit is tenant-readable and
    // is served by GET /api/control/v1/audit.
    metadata: { via: "dashboard", kind: result.data.kind },
  });
  revalidatePath("/dashboard/settings");
  return { owner: result.data };
}

/**
 * Publish or unpublish the binding.
 *
 * One switch, two effects: the public /verify page, and the `own` claim on
 * every signed receipt (lib/owner/current.ts reads the same flag). The UI is
 * required to say so; this action is required to record it.
 */
export async function publishOwner(published: boolean): Promise<OwnerActionState> {
  const acting = await actingUser();
  if ("error" in acting) return { error: acting.error };

  const result = await setOwnerPublished(serviceClient(), acting.userId, published);
  if (!result.ok) return { error: explain(result.code) };

  await recordAdminAction({
    userId: acting.userId,
    action: "owner.publish",
    targetType: "owner",
    targetId: acting.userId,
    metadata: { via: "dashboard", published },
  });
  revalidatePath("/dashboard/settings");
  return { owner: result.data };
}

/**
 * Go and look for the token, and record what was found.
 *
 * A failed check is not an error to the operator — it is the expected state
 * until they have published the file — so it returns the owner AND the reason,
 * and the form explains it. Only an infrastructure failure is an `error`.
 */
export async function checkOwnerDomain(): Promise<OwnerActionState> {
  const acting = await actingUser();
  if ("error" in acting) return { error: acting.error };

  const limited = await rateLimit(`owner-verify:${acting.userId}`, VERIFY_LIMIT, VERIFY_WINDOW_S);
  if (!limited.success) {
    return { error: "Too many checks. Wait a minute and try again." };
  }

  const result = await verifyOwnerDomain(serviceClient(), acting.userId);
  if (!result.ok) return { error: explain(result.code) };

  await recordAdminAction({
    userId: acting.userId,
    action: "owner.verify",
    targetType: "owner",
    targetId: acting.userId,
    metadata: { via: "dashboard", verified: result.data.verified },
  });
  revalidatePath("/dashboard/settings");
  return {
    owner: result.data.owner,
    ...(result.data.reason ? { reason: result.data.reason } : {}),
  };
}
