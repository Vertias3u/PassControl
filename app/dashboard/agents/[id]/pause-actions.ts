"use server";
// The soft pause's dashboard control (1.6.0, L4): "Let it go on for an hour" and
// "Keep paused".
//
// The lift is a Redis key per agent with a TTL (lib/state/pause.ts), so the tenant
// boundary is HERE: the agent is found through the caller's own session (RLS) and an
// explicit user_id filter, and nothing is written for an agent that is not theirs.
// Behind the same gate as resuming a suspended agent (a signed-in owner), because it
// is the same kind of act: letting one's own agent go on. It can never let the agent
// spend past a limit: a lift skips only the pause check, never the hard budget.
import { revalidatePath } from "next/cache";

import { liftSeconds } from "@/lib/budget-pause";
import { recordAdminAction } from "@/lib/audit";
import { endPauseLift, liftPause } from "@/lib/state/pause";
import { userClient } from "@/lib/supabase/server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNAVAILABLE = "This agent is unavailable.";

export interface PauseLiftResult {
  ok?: boolean;
  /** When the lift ends, for the page to say. */
  until?: string;
  error?: string;
}

export async function setAgentPauseLift(agentId: string, lift: boolean): Promise<PauseLiftResult> {
  const db = await userClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return { error: "Sign in again to change this agent." };
  if (!UUID_RE.test(agentId ?? "")) return { error: UNAVAILABLE };

  const { data: agent, error } = await db
    .from("agents")
    .select("id, pause_percent, budget_period")
    .eq("user_id", user.id)
    .eq("id", agentId)
    .maybeSingle();
  if (error || !agent) return { error: UNAVAILABLE };

  const row = agent as { pause_percent?: unknown; budget_period?: unknown };
  try {
    if (!lift) {
      await endPauseLift(agentId);
    } else {
      if (row.pause_percent == null) return { error: "This agent has no pause line, so there is nothing to lift." };
      const nowMs = Date.now();
      const period = row.budget_period === "day" || row.budget_period === "month" ? row.budget_period : null;
      const seconds = liftSeconds(period, nowMs);
      await liftPause(agentId, seconds);
      await recordAdminAction({
        userId: user.id,
        action: "agent.pause_lift",
        targetType: "agent",
        targetId: agentId,
        metadata: { lifted: true, seconds },
      });
      revalidatePath(`/dashboard/agents/${agentId}`);
      return { ok: true, until: new Date(nowMs + seconds * 1000).toISOString() };
    }
  } catch {
    return { error: "PassControl could not change the pause just now. Try again." };
  }
  await recordAdminAction({
    userId: user.id,
    action: "agent.pause_lift",
    targetType: "agent",
    targetId: agentId,
    metadata: { lifted: false },
  });
  revalidatePath(`/dashboard/agents/${agentId}`);
  return { ok: true };
}
