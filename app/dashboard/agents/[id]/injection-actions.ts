"use server";
// The injection guard's Clear (Phase 2, owner 2026-10-30): end a tainted agent's hold
// now instead of at its 30 minutes.
//
// The taint is a Redis key per agent (lib/state/taint.ts), so the tenant boundary is
// HERE: the agent is found through the caller's own session (RLS) and an explicit
// user_id filter, and nothing is cleared for an agent that is not theirs. The blocks
// that caused the taint never taint again (their rows remember them); a new one does.
// An Allow on a held action is a different act and never clears (DECISIONS 2026-10-30).
import { revalidatePath } from "next/cache";

import { recordAdminAction } from "@/lib/audit";
import { clearTaint } from "@/lib/state/taint";
import { userClient } from "@/lib/supabase/server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNAVAILABLE = "This agent is unavailable.";

export interface InjectionClearResult {
  ok?: boolean;
  /** False when there was no hold to clear. */
  cleared?: boolean;
  error?: string;
}

export async function clearInjectionTaint(agentId: string): Promise<InjectionClearResult> {
  const db = await userClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return { error: "Sign in again to change this agent." };
  if (!UUID_RE.test(agentId ?? "")) return { error: UNAVAILABLE };

  const { data: agent, error } = await db.from("agents").select("id").eq("user_id", user.id).eq("id", agentId).maybeSingle();
  if (error || !agent) return { error: UNAVAILABLE };

  let cleared: boolean;
  try {
    cleared = await clearTaint(agentId);
  } catch {
    return { error: "PassControl could not clear the hold just now. Try again." };
  }
  await recordAdminAction({
    userId: user.id,
    action: "agent.injection_clear",
    targetType: "agent",
    targetId: agentId,
    metadata: { cleared },
  });
  revalidatePath(`/dashboard/agents/${agentId}`);
  return { ok: true, cleared };
}
