"use server";

import { revalidatePath } from "next/cache";
import { rateLimit } from "@/lib/ratelimit";
import { serviceClient } from "@/lib/supabase";
import { userClient } from "@/lib/supabase/server";
import { delegationRevokeMetadata, revokeAgentDelegation, revokeAllAgentDelegations } from "@/lib/delegation/manage";
import { logSecurityEvent } from "@/lib/seclog";
import { dispatchSecurityAlert } from "@/lib/alert";
import { recordAdminAction } from "@/lib/audit";

const REVOKE_RATE_LIMIT = 30;
const REVOKE_RATE_WINDOW_S = 60;
const JTI_RE = /^[A-Za-z0-9_-]{16,64}$/;
// Local, not lib/sessions.ts's: that module is Cloud-only and pruned from the mirror,
// and delegation ships everywhere.
const AGENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RevokeDelegationResult = { ok: true; immediate: boolean } | { ok: false; error: string };

/** The signed-in owner, and the shared checks every revocation passes first. */
async function owner(agentId: string): Promise<{ userId: string } | { error: string }> {
  const db = await userClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return { error: "Sign in again to revoke a delegation." };
  if (!AGENT_ID_RE.test(agentId)) return { error: "This agent is unavailable." };
  // Each revocation writes an audit row and an alert, so it is bounded like any write.
  const limited = await rateLimit(`delegation-revoke:${user.id}`, REVOKE_RATE_LIMIT, REVOKE_RATE_WINDOW_S);
  if (!limited.success) return { error: "Too many changes. Wait a minute and try again." };
  return { userId: user.id };
}

async function record(userId: string, agentId: string, fields: Record<string, unknown>, metadata: Record<string, unknown>) {
  logSecurityEvent("agent.delegation_revoke", { user: userId, agentId, ...fields });
  await dispatchSecurityAlert("agent.delegation_revoke", { user: userId, agentId, ...fields });
  await recordAdminAction({ userId, action: "agent.delegation_revoke", targetType: "agent", targetId: agentId, metadata });
  revalidatePath(`/dashboard/agents/${agentId}`);
}

/**
 * Revoke one delegation of this owner's agent, and everything delegated under it
 * (Bet D). Not behind an MFA step-up, for the reason suspend and session stop are
 * not: stopping a credential must never wait. The owner is the signed-in user,
 * never anything the browser sends; manage.ts filters every read on it.
 */
export async function revokeDelegationAction(agentId: string, jti: string): Promise<RevokeDelegationResult> {
  if (!JTI_RE.test(jti)) return { ok: false, error: "This delegation is unavailable." };
  const who = await owner(agentId);
  if ("error" in who) return { ok: false, error: who.error };
  const r = await revokeAgentDelegation(serviceClient(), who.userId, agentId, jti);
  if (!r.ok) return { ok: false, error: r.status === 404 ? "This agent is unavailable." : "The revocation was not recorded. Try again." };
  await record(
    who.userId,
    agentId,
    { all: false, jti },
    delegationRevokeMetadata({ all: false, jti, passports: r.passports, immediate: r.immediate, via: "dashboard" })
  );
  return { ok: true, immediate: r.immediate };
}

/**
 * Revoke every delegation this owner's agent issued before now, seen or not: the
 * watermark. The audit row carries its value and the passports it covered, which is
 * what the public revocation list publishes (P2.4).
 */
export async function revokeAllDelegationsAction(agentId: string): Promise<RevokeDelegationResult> {
  const who = await owner(agentId);
  if ("error" in who) return { ok: false, error: who.error };
  const r = await revokeAllAgentDelegations(serviceClient(), who.userId, agentId);
  if (!r.ok) return { ok: false, error: r.status === 404 ? "This agent is unavailable." : "The revocation was not recorded. Try again." };
  await record(
    who.userId,
    agentId,
    { all: true },
    delegationRevokeMetadata({ all: true, validAfter: r.validAfter, passports: r.passports, immediate: r.immediate, via: "dashboard" })
  );
  return { ok: true, immediate: r.immediate };
}
