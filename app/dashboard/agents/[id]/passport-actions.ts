"use server";
// Retiring a passport key, and giving a passport an end date.
//
// Both require MFA step-up, following trace-action.ts, owner-actions.ts and
// shadow-actions.ts rather than dashboard/actions.ts: a server action is
// addressable over HTTP by its id, so the redirect on the page protects the
// page and not these. Rotation decides which key can speak for an agent, which
// is the most consequential thing on this screen.
//
// ── The private key is never here ───────────────────────────────────────────
//
// rotateAgentPassport takes a PUBLIC key. The browser generates the pair and
// shows the secret once, exactly as PassportIssuanceModal already does for a
// new agent. There is deliberately no code path in this file that could produce
// a private key — the gateway has never held one, and the convenience of
// generating it server-side is not worth being the first thing that does.
import { revalidatePath } from "next/cache";

import { recordAdminAction } from "@/lib/audit";
import { dispatchSecurityAlert } from "@/lib/alert";
import { mfaAuthorizedUser } from "@/lib/mfa";
import { logSecurityEvent } from "@/lib/seclog";
import { serviceClient } from "@/lib/supabase";
import { userClient } from "@/lib/supabase/server";
import { rotatePassport, setPassportExpiry, setSenderConstraintMode } from "@/lib/fleet";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PassportActionState {
  ok?: true;
  error?: string;
  /** Echoed back by a mode change so the control can settle on the real value. */
  senderConstraintMode?: string;
  /**
   * Whether the new mode is DECIDING yet, not merely stored.
   *
   * The gateway reads this setting from a cache, so a saved change that could
   * not invalidate that cache keeps the old mode in force for up to a minute.
   * On a switch to `required` that minute is one in which outstanding bearer
   * visas are still admitted, so the surface must not report it as done. False
   * means saved-but-not-yet-live; the write itself is durable either way and
   * must not be retried.
   */
  enforcementLive?: boolean;
  /** Set by a successful rotation, so the UI can state the deadline exactly. */
  previousValidUntil?: string;
  expiresAt?: string | null;
}

async function actingUser(): Promise<{ userId: string } | { error: string }> {
  const db = await userClient();
  const gate = await mfaAuthorizedUser(db);
  if (!gate.ok) {
    return {
      error:
        gate.reason === "step_up_required"
          ? "Complete two-factor verification to change this passport."
          : gate.reason === "unauthenticated"
            ? "Sign in again to change this passport."
            : "Your authentication assurance could not be verified. Try again.",
    };
  }
  return { userId: gate.user.id };
}

/**
 * Retire the current key and install a new one, keeping the agent.
 *
 * The service-role client is used because none of these columns is in 0011's
 * allowlist, so the tenant boundary is enforced here in code: the userId comes
 * from the verified session and is passed to fleet, which filters on it.
 */
export async function rotateAgentPassport(
  agentId: string,
  newPassportPubkey: string,
  graceSeconds: number
): Promise<PassportActionState> {
  const acting = await actingUser();
  if ("error" in acting) return { error: acting.error };
  if (!UUID_RE.test(agentId)) return { error: "This agent is unavailable." };

  const result = await rotatePassport(
    serviceClient(),
    acting.userId,
    agentId,
    newPassportPubkey,
    graceSeconds
  );
  if (!result.ok) {
    return { error: result.message ?? "This passport could not be rotated. Please try again." };
  }

  // Same class of event killswitch.master alerts on. An operator who did not do
  // this needs to hear about it now, not at the next audit read.
  logSecurityEvent("agent.passport_rotate", { user: acting.userId, agentId });
  await dispatchSecurityAlert("agent.passport_rotate", { user: acting.userId, agentId });
  await recordAdminAction({
    userId: acting.userId,
    action: "agent.update",
    targetType: "agent",
    targetId: agentId,
    // The new key is public and belongs in the record: an audit row saying a key
    // changed without saying to what is not much of a record. No private
    // material exists on this path to leak.
    //
    // Taken from the result rather than from the argument: fleet normalizes the
    // key before storing it, and an audit row naming a key that is not the one
    // on the row reads as authoritative while being unusable.
    metadata: {
      fields: "passport_pubkey",
      via: "dashboard",
      rotated: true,
      // The RETIRED key, and this row is the only place it survives:
      // lib/reconcile.ts clears previous_passport_pubkey once the grace window
      // closes. The public revocation list is built from this field, so a
      // rotation recorded without it is a dead key no verifier can be told
      // about. Public material, like `to` beside it.
      from: result.value.previousPassportPubkey,
      to: result.value.passportPubkey,
      previous_valid_until: result.value.previousValidUntil,
      expires_at: result.value.expiresAt,
    },
  });
  // Do not revalidate here. The browser has generated the replacement private
  // key but cannot commit it to reveal-once React state until this action
  // returns. PassportLifecycle refreshes both views only after acknowledgement.
  return {
    ok: true,
    previousValidUntil: result.value.previousValidUntil,
    expiresAt: result.value.expiresAt,
  };
}

/** Set or clear when this passport stops authenticating. `null` = never. */
export async function setAgentPassportExpiry(
  agentId: string,
  expiresAt: string | null
): Promise<PassportActionState> {
  const acting = await actingUser();
  if ("error" in acting) return { error: acting.error };
  if (!UUID_RE.test(agentId)) return { error: "This agent is unavailable." };

  const result = await setPassportExpiry(serviceClient(), acting.userId, agentId, expiresAt);
  if (!result.ok) {
    return { error: result.message ?? "That expiry could not be saved. Please try again." };
  }

  await recordAdminAction({
    userId: acting.userId,
    action: "agent.update",
    targetType: "agent",
    targetId: agentId,
    metadata: { fields: "expires_at", via: "dashboard", to: result.value.expiresAt },
  });
  revalidatePath(`/dashboard/agents/${agentId}`);
  return { ok: true };
}

/**
 * Choose whether this agent's calls must carry a per-request passport proof.
 *
 * `observe` is the state that makes the other two decidable: it verifies the
 * proof exactly as enforcement does and admits the call regardless, so an
 * operator can watch their real traffic for a fortnight before requiring
 * anything. See db/migrations/0049.
 *
 * MFA-gated like every other action in this file, and for a stronger reason
 * than most: `required` refuses every call from a client that does not sign,
 * which is a fleet-wide outage if it is chosen by someone who should not have
 * been able to choose it.
 */
export async function setAgentSenderConstraint(
  agentId: string,
  mode: string
): Promise<PassportActionState> {
  const acting = await actingUser();
  if ("error" in acting) return { error: acting.error };
  if (!UUID_RE.test(agentId)) return { error: "This agent is unavailable." };

  const result = await setSenderConstraintMode(serviceClient(), acting.userId, agentId, mode);
  if (!result.ok) {
    return { error: result.message ?? "That setting could not be saved. Please try again." };
  }

  await recordAdminAction({
    userId: acting.userId,
    action: "agent.update",
    targetType: "agent",
    targetId: agentId,
    metadata: {
      fields: "sender_constraint_mode",
      via: "dashboard",
      to: result.value.mode,
      // Recorded, because an operator reading the audit trail after an incident
      // needs to know whether the change was in force from this moment or from
      // up to a TTL later.
      enforcement_live: result.value.enforcementLive,
    },
  });
  revalidatePath(`/dashboard/agents/${agentId}`);
  return {
    ok: true,
    senderConstraintMode: result.value.mode,
    enforcementLive: result.value.enforcementLive,
  };
}
