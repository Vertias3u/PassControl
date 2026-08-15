"use server";
// Taking and ending a break-glass elevation.
//
// MFA step-up, like every other consequential action on this page. This one has
// the strongest claim to it: an elevation widens what an agent may reach beyond
// its stored capability, and a server action is addressable over HTTP by its id,
// so the page redirect is not what protects it.
//
// The service-role client is used because migration 0022 gives `authenticated`
// no insert or update path on break_glass_grants at all — deliberately, since a
// client that could write its own grant would make the mechanism decorative.
// The tenant boundary is therefore enforced here in code: the userId comes from
// the verified session and is passed to fleet, which filters on it.
import { revalidatePath } from "next/cache";

import { recordAdminAction } from "@/lib/audit";
import { dispatchSecurityAlert } from "@/lib/alert";
import { mfaAuthorizedUser } from "@/lib/mfa";
import { logSecurityEvent } from "@/lib/seclog";
import { serviceClient } from "@/lib/supabase";
import { userClient } from "@/lib/supabase/server";
import { grantBreakGlass, revokeBreakGlass } from "@/lib/fleet";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface BreakGlassActionState {
  ok?: true;
  error?: string;
  expiresAt?: string;
}

async function actingUser(): Promise<{ userId: string } | { error: string }> {
  const db = await userClient();
  const gate = await mfaAuthorizedUser(db);
  if (!gate.ok) {
    return {
      error:
        gate.reason === "step_up_required"
          ? "Complete two-factor verification to take an elevation."
          : gate.reason === "unauthenticated"
            ? "Sign in again to change this elevation."
            : "Your authentication assurance could not be verified. Try again.",
    };
  }
  return { userId: gate.user.id };
}

/**
 * Open the hole, for a bounded time, with a stated reason.
 *
 * Every bound — TTL, scope validity, the size of the resulting union, the
 * mandatory reason, one live grant per agent — is enforced in lib/fleet.ts, not
 * here and not in the form. This function's job is the session, the record and
 * the alert.
 */
export async function takeBreakGlass(
  agentId: string,
  input: { scopes: unknown; reason: unknown; ttlSeconds: unknown }
): Promise<BreakGlassActionState> {
  const acting = await actingUser();
  if ("error" in acting) return { error: acting.error };
  if (!UUID_RE.test(agentId)) return { error: "This agent is unavailable." };

  const result = await grantBreakGlass(serviceClient(), acting.userId, agentId, input);
  if (!result.ok) {
    return { error: result.message ?? "This elevation could not be taken. Please try again." };
  }

  // Critical, alongside killswitch.master. The entire justification for having
  // break-glass at all is that nobody can take one quietly.
  logSecurityEvent("agent.break_glass", { user: acting.userId, agentId });
  await dispatchSecurityAlert("agent.break_glass", { user: acting.userId, agentId });
  await recordAdminAction({
    userId: acting.userId,
    action: "agent.break_glass",
    targetType: "agent",
    targetId: agentId,
    // The reason is the point of the row. Scopes and expiry make it reviewable
    // without a second lookup; none of this is secret — it is what the operator
    // chose to grant, and admin_audit is tenant-readable by design.
    //
    // Scopes come from the RESULT, never from the request: fleet stores what
    // validateScopes produced — trimmed, with anything it was not asked for
    // dropped — so auditing the submitted document would state an elevation
    // that was never granted, on the one surface built to be reviewed later.
    metadata: {
      via: "dashboard",
      reason: String(input.reason ?? "").trim(),
      scopes: JSON.stringify(result.value.scopes),
      expires_at: result.value.expiresAt,
    },
  });
  revalidatePath(`/dashboard/agents/${agentId}`);
  revalidatePath("/dashboard");
  return { ok: true, expiresAt: result.value.expiresAt };
}

/**
 * End it now.
 *
 * "Now" means no NEW visa carries the elevation. One already minted keeps it
 * until it expires, because the proxy gates on the snapshot in the token and
 * never re-reads this table — the property that keeps break-glass off the hot
 * path. The UI says so at the button; a revoke that reads as instant when it is
 * not is the failure this feature can least afford.
 */
export async function endBreakGlass(agentId: string): Promise<BreakGlassActionState> {
  const acting = await actingUser();
  if ("error" in acting) return { error: acting.error };
  if (!UUID_RE.test(agentId)) return { error: "This agent is unavailable." };

  const result = await revokeBreakGlass(serviceClient(), acting.userId, agentId);
  if (!result.ok) return { error: "This elevation could not be ended. Please try again." };

  logSecurityEvent("agent.break_glass", {
    user: acting.userId,
    agentId,
    ended: true,
    revoked: result.value.revoked,
  });
  await recordAdminAction({
    userId: acting.userId,
    action: "agent.break_glass",
    targetType: "agent",
    targetId: agentId,
    metadata: { via: "dashboard", ended: true, revoked: result.value.revoked },
  });
  revalidatePath(`/dashboard/agents/${agentId}`);
  revalidatePath("/dashboard");
  return { ok: true };
}
