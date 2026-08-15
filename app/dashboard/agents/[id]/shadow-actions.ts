"use server";
// Try a policy before it bites, then promote the exact thing you tried.
//
// ── Why these are here and not in app/dashboard/actions.ts ──────────────────
//
// That file's `requireUser` checks the session and stops. These two follow
// trace-action.ts and owner-actions.ts instead, which additionally require MFA
// step-up, because a server action is addressable over HTTP by its id — the
// page-level redirect in page.tsx protects the page, not the action. Shipping
// promote at the weaker bar would leave the read-only SIMULATOR on this page
// gated harder than the control that changes what the gateway actually does.
//
// ── The two rules ───────────────────────────────────────────────────────────
//
// 1. THE SERVICE-ROLE CLIENT IS DELIBERATE. Migration 0020 grants `authenticated`
//    no UPDATE on `policy_shadow`, exactly as 0011 left `policy`, so a
//    userClient() could not write these columns even if we wanted it to. The
//    tenant boundary is therefore enforced HERE, in code: the userId comes from
//    the verified session and goes into an explicit `.eq("user_id", …)` filter,
//    never from an argument.
//
// 2. PROMOTE RE-VALIDATES. This is the load-bearing check in the whole feature,
//    not a defensive extra. `policy_shadow` is reachable by SQL, and a malformed
//    value copied into `policy` is read by the gateway as `policy:malformed` —
//    which DENIES EVERY CALL for that agent. That is the only path from a
//    diagnostics feature to an outage, so it is closed at the moment of copying
//    and pinned by a test.
import { revalidatePath } from "next/cache";

import { recordAdminAction } from "@/lib/audit";
import { mfaAuthorizedUser } from "@/lib/mfa";
import { shadowRevision } from "@/lib/policy-shadow";
import { purgeAgentPolicy } from "@/lib/state/redis";
import { serviceClient } from "@/lib/supabase";
import { userClient } from "@/lib/supabase/server";
import { validatePolicy } from "@/lib/validate";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ShadowActionState {
  ok?: true;
  error?: string;
}

/**
 * Resolve the acting tenant, or fail.
 *
 * Two clients on purpose, as in owner-actions.ts: the cookie-bound one answers
 * "who is this and have they cleared MFA", the service-role one does the write.
 */
async function actingUser(): Promise<{ userId: string } | { error: string }> {
  const db = await userClient();
  const gate = await mfaAuthorizedUser(db);
  if (!gate.ok) {
    return {
      error:
        gate.reason === "step_up_required"
          ? "Complete two-factor verification to change this policy."
          : gate.reason === "unauthenticated"
            ? "Sign in again to change this policy."
            : "Your authentication assurance could not be verified. Try again.",
    };
  }
  return { userId: gate.user.id };
}

/**
 * An empty draft is `null`, never `{}`.
 *
 * `parsePolicy({})` is well-formed and means "a policy that permits everything",
 * so saving `{}` would leave shadow mode ON, recording "allow" against every
 * attempt forever, while the operator believes they turned it off. Note this is
 * inverted from fallbacks, where `[]` is the value that means off — worth
 * stating rather than leaving to be rediscovered.
 */
function normaliseDraft(raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return raw; // let validatePolicy refuse it
  return Object.keys(raw as Record<string, unknown>).length === 0 ? null : raw;
}

/**
 * Save (or clear) the shadow candidate. Changes nothing about enforcement.
 *
 * Validated even though nothing acts on the result: a malformed draft is inert
 * at the proxy, so the operator would otherwise get no signal at all until they
 * tried to promote it. Being told at the form is the point of having a form.
 */
export async function saveAgentPolicyShadow(
  agentId: string,
  draft: unknown
): Promise<ShadowActionState> {
  const acting = await actingUser();
  if ("error" in acting) return { error: acting.error };
  if (!UUID_RE.test(agentId)) return { error: "This agent is unavailable." };

  let clean: unknown;
  try {
    clean = validatePolicy(normaliseDraft(draft));
  } catch (e) {
    return { error: (e as Error).message };
  }

  const db = serviceClient();
  // Read first, so the audit row can answer "what was this draft before".
  const { data: before } = await db
    .from("agents")
    .select("policy_shadow")
    .eq("user_id", acting.userId)
    .eq("id", agentId)
    .maybeSingle();

  const { data, error } = await db
    .from("agents")
    .update({ policy_shadow: clean })
    .eq("user_id", acting.userId) // tenant boundary, in code
    .eq("id", agentId)
    .select("id")
    .maybeSingle();
  if (error) {
    console.error("[dashboard:saveAgentPolicyShadow]", error.code ?? "unknown");
    return { error: "Something went wrong. Please try again." };
  }
  if (!data) return { error: "This agent is unavailable." };

  await purgeAgentPolicy(acting.userId, agentId).catch(() => {});
  await recordAdminAction({
    userId: acting.userId,
    action: "agent.update",
    targetType: "agent",
    targetId: agentId,
    metadata: {
      fields: "policy_shadow",
      via: "dashboard",
      from: JSON.stringify(before?.policy_shadow ?? null),
      to: JSON.stringify(clean),
    },
  });
  revalidatePath(`/dashboard/agents/${agentId}`);
  return { ok: true };
}

/**
 * Make the draft live, in one write.
 *
 * Promotion exists so an operator never retypes the rule they tested. Retyping
 * is how you end up enforcing a policy one character different from the one the
 * numbers on this panel describe.
 *
 * ── Why it takes a revision ────────────────────────────────────────────────
 *
 * "Promote the current draft" is not the same request as "promote the draft I
 * just reviewed", and only the second one is safe. An operator who reads the
 * panel, leaves the tab open while another tab (or another admin, or a script)
 * saves a different draft, and then clicks Promote would otherwise ship a
 * document nobody reviewed and be told it succeeded. `expectedRevision` is the
 * revision the page rendered; it is derived from the draft itself, so there is
 * no version column to keep in step. A caller that supplies nothing is refused
 * rather than treated as agreeing to whatever is there — a server action is
 * addressable over HTTP by its id, so "no opinion" cannot mean "any draft".
 *
 * The shadow is cleared in the SAME update. Leaving it would mean the gateway
 * evaluates a draft identical to the live policy on every call forever, and the
 * panel would advertise a pending candidate that is no longer pending.
 */
export async function promoteAgentPolicyShadow(
  agentId: string,
  expectedRevision: string
): Promise<ShadowActionState> {
  const acting = await actingUser();
  if ("error" in acting) return { error: acting.error };
  if (!UUID_RE.test(agentId)) return { error: "This agent is unavailable." };

  const db = serviceClient();
  const { data: row, error: readError } = await db
    .from("agents")
    .select("policy, policy_shadow")
    .eq("user_id", acting.userId)
    .eq("id", agentId)
    .maybeSingle();
  if (readError) {
    console.error("[dashboard:promoteAgentPolicyShadow]", readError.code ?? "unknown");
    return { error: "Something went wrong. Please try again." };
  }
  if (!row) return { error: "This agent is unavailable." };

  const draft = row.policy_shadow ?? null;
  if (draft === null) {
    return { error: "There is no draft policy to promote. Save one first." };
  }

  // The draft that is here now must be the draft the numbers were measured
  // against — the same revision the panel stamped onto every verdict it counted.
  if (shadowRevision(draft) !== expectedRevision) {
    return {
      error:
        "This draft has changed since this page was loaded, so promoting now would make a policy live that you have not reviewed. Reload, check the draft and its measurements, then promote.",
    };
  }

  // See rule 2 at the top of this file. The draft is re-checked against the
  // gateway's own reader immediately before it becomes the thing that decides,
  // because the column is reachable by SQL and the form is not the only writer.
  try {
    validatePolicy(draft);
  } catch {
    return {
      error:
        "That draft is not a policy the gateway can read, so promoting it would block every call. Fix it, then promote.",
    };
  }

  const { data, error } = await db
    .from("agents")
    // One write: there is never a moment where the draft is live and also still
    // pending, or cleared without having been promoted.
    .update({ policy: draft, policy_shadow: null })
    .eq("user_id", acting.userId)
    .eq("id", agentId)
    // Compare-and-swap, closing the window between the read above and this
    // write. Without it a save landing in that gap is destroyed: the update
    // clears `policy_shadow` unconditionally, so the newer draft disappears and
    // the older one goes live, with success reported for both. `=` on jsonb
    // ignores key order, which matters because the column does not preserve the
    // order it was written in — verified against the local PostgREST on
    // 2026-08-08: a reordered but identical document matched, a different one
    // matched zero rows and wrote nothing.
    .eq("policy_shadow", JSON.stringify(draft))
    .select("id")
    .maybeSingle();
  if (error) {
    console.error("[dashboard:promoteAgentPolicyShadow]", error.code ?? "unknown");
    return { error: "Something went wrong. Please try again." };
  }
  // The read found the row, so zero rows now means the draft moved underneath
  // this write, not that the agent went away. Say which — "unavailable" would
  // send the operator looking for the wrong problem.
  if (!data) {
    return {
      error:
        "This draft changed while it was being promoted, so nothing was written. Reload, check the draft, then promote.",
    };
  }

  // Enforcement just changed, so the stale pair must not survive. Still
  // best-effort: the row is written, and a failed purge costs one cache window.
  await purgeAgentPolicy(acting.userId, agentId).catch(() => {});
  await recordAdminAction({
    userId: acting.userId,
    action: "agent.update",
    targetType: "agent",
    targetId: agentId,
    metadata: {
      fields: "policy",
      via: "dashboard",
      promoted: true,
      from: JSON.stringify(row.policy ?? null),
      to: JSON.stringify(draft),
    },
  });
  revalidatePath(`/dashboard/agents/${agentId}`);
  return { ok: true };
}
