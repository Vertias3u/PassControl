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
import {
  clearOwnerCompany,
  setOwner,
  setOwnerCompany,
  setOwnerPublished,
  verifyOwnerControl,
} from "@/lib/owner/manage";
import type { ControlFailure, OwnerRecord } from "@/lib/owner/manage";
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
  /** Set only by checkOwnerControl, so the form can explain a failed check. */
  reason?: ControlFailure;
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
      return "Choose whether you are claiming a name, a domain, or a GitHub account.";
    case "invalid_subject":
      return "Enter the name, domain, or GitHub account this passport belongs to.";
    case "invalid_domain":
      return "That is not a domain we can check. Use a bare hostname, like acme.com.";
    case "invalid_login":
      return "That is not a GitHub username. Use the account name, like octocat.";
    // Not a typo — the right value in the wrong field. Saying "invalid" here
    // would send someone hunting for a mistake in a string that has none.
    case "looks_like_domain":
      return "That looks like a domain. Choose Domain above to claim it.";
    case "no_owner":
      return "Declare an owner before publishing or checking it.";
    case "not_verifiable_kind":
      return "Only a domain or a GitHub account can be checked. A name is self-attested by design.";
    case "no_verification_token":
      return "This claim has no token. Re-declare it to get a fresh one.";
    case "invalid_company_id":
      return "Enter an EU VAT number or a 20-character LEI. Other registers cannot be checked for free.";
    case "company_not_found":
      return "That register has no active entry with this number. Check the number and try again.";
    // A register that is down is not a company that does not exist, and telling
    // an owner their real company is not registered would be a false negative
    // they cannot argue with.
    case "register_unreachable":
      return "The register did not answer. Nothing was changed — try again shortly.";
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
 * tier. For a domain or a GitHub account this returns a token to publish;
 * checkOwnerControl is what
 * goes and looks for it. Same for a GitHub account.
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
export async function checkOwnerControl(): Promise<OwnerActionState> {
  const acting = await actingUser();
  if ("error" in acting) return { error: acting.error };

  const limited = await rateLimit(`owner-verify:${acting.userId}`, VERIFY_LIMIT, VERIFY_WINDOW_S);
  if (!limited.success) {
    return { error: "Too many checks. Wait a minute and try again." };
  }

  const result = await verifyOwnerControl(serviceClient(), acting.userId);
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

/**
 * Record a company register line against the existing binding.
 *
 * Separate from declareOwner on purpose, and the separation is the safety
 * property rather than tidiness. A register lookup confirms an entry EXISTS; it
 * cannot show that this tenant is it, because a register is a public record
 * anyone can quote with nowhere to publish a token. So this never travels
 * through the code path that sets `tier` — see db/migrations/0048 and the
 * enumerated forbidden keys in tests/owner-manage-evidence.test.ts.
 *
 * Rate limited on the same budget as verification: both spend an outbound
 * request to somebody else's service on a tenant's say-so.
 */
export async function setCompany(identifier: string): Promise<OwnerActionState> {
  const acting = await actingUser();
  if ("error" in acting) return { error: acting.error };

  const limited = await rateLimit(`owner-verify:${acting.userId}`, VERIFY_LIMIT, VERIFY_WINDOW_S);
  if (!limited.success) {
    return { error: "Too many lookups. Wait a minute and try again." };
  }

  const result = await setOwnerCompany(serviceClient(), acting.userId, identifier);
  if (!result.ok) return { error: explain(result.code) };

  await recordAdminAction({
    userId: acting.userId,
    action: "owner.company.set",
    targetType: "owner",
    targetId: acting.userId,
    // The identifier is a public register number the owner asked us to publish,
    // so it is not a secret. The resolved legal name is not recorded here — it
    // came from the register, not from the operator, and the row already holds it.
    metadata: { via: "dashboard", source: result.data.company_source },
  });
  revalidatePath("/dashboard/settings");
  return { owner: result.data };
}

/** Withdraw the company claim. Every column together — never a subset. */
export async function clearCompany(): Promise<OwnerActionState> {
  const acting = await actingUser();
  if ("error" in acting) return { error: acting.error };

  const result = await clearOwnerCompany(serviceClient(), acting.userId);
  if (!result.ok) return { error: explain(result.code) };

  await recordAdminAction({
    userId: acting.userId,
    action: "owner.company.clear",
    targetType: "owner",
    targetId: acting.userId,
    metadata: { via: "dashboard" },
  });
  revalidatePath("/dashboard/settings");
  return { owner: result.data };
}
