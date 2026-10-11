// "This session passed $X" (1.4.0 candidate 3, owner 2026-10-10). An agent's policy
// can set `session_alert_cents`. After each settled charge of a call that declares
// a session, the session's running total grows; the charge that carries it across
// the threshold sends ONE alert to the workspace's Slack, Discord or Telegram
// destination. It alerts and never pauses or refuses: stopping the session is the
// Sessions view's Stop button (T8), which the alert links to.
//
// Called inside waitUntil after the call was answered. Best-effort by contract:
// the audit row is the record, and this never throws.
import { addSessionSpend } from "@/lib/state/redis";
import { notifyWorkspace } from "@/lib/alerts/workspace";

/** Did this charge carry the total from below the threshold to at or above it? */
export function sessionSpendCrossed(before: number, after: number, threshold: number): boolean {
  return before < threshold && after >= threshold;
}

export async function noteSessionSpend(input: {
  userId: string;
  agentId: string;
  session: string;
  deltaMicrocents: number;
  thresholdMicrocents: number;
  origin: string;
  notify?: typeof notifyWorkspace;
}): Promise<boolean> {
  try {
    if (!(input.deltaMicrocents > 0)) return false;
    const added = await addSessionSpend(input.agentId, input.session, input.deltaMicrocents);
    if (!added) return false;
    const before = added.total - Math.round(input.deltaMicrocents);
    if (!sessionSpendCrossed(before, added.total, input.thresholdMicrocents)) return false;
    await (input.notify ?? notifyWorkspace)({
      userId: input.userId,
      agentId: input.agentId,
      type: "session_spend",
      session: input.session,
      spentMicrocents: added.total,
      thresholdMicrocents: input.thresholdMicrocents,
      origin: input.origin,
    });
    return true;
  } catch {
    return false;
  }
}
