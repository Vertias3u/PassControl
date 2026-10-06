"use server";
// "Ask me first": the owner's answer from the dashboard.
//
// Signed in is enough, with no two-factor step-up: the same bar as a Telegram
// tap, which this is the dashboard's equal of. An approval admits ONE request
// the owner can read in full on this page, for ten minutes; it widens nothing
// else. The user id comes from the verified session, never from the client,
// and decideApproval refuses an approval that belongs to another workspace.
import { recordAdminAction } from "@/lib/audit";
import { closeTelegramPrompt } from "@/lib/alerts/approvals";
import { decideApproval, readApproval, type ApprovalDecision } from "@/lib/state/approvals";
import { userClient } from "@/lib/supabase/server";

export type DecideResult = { state: ApprovalDecision | "used" | "pending" | "missing" } | { error: string };

export async function decideApprovalAction(id: string, decision: ApprovalDecision): Promise<DecideResult> {
  if (decision !== "approved" && decision !== "denied") return { error: "Unknown decision." };
  const db = await userClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return { error: "Sign in again to answer this." };

  let before;
  let result;
  try {
    before = await readApproval(user.id, id);
    result = await decideApproval({ userId: user.id, id, decision, by: "dashboard" });
  } catch {
    return { error: "The answer could not be saved. Try again." };
  }

  if (result.state === decision && before) {
    await recordAdminAction({
      userId: user.id,
      action: "approval.decide",
      targetType: "agent",
      targetId: before.agentId,
      // The service and method, not the path or body: admin_audit is served by
      // the control API, and a path can name a private repository or channel.
      metadata: { decision, service: before.service, method: before.method },
    });
    if (before.telegram) await closeTelegramPrompt(user.id, before.telegram, decision);
  }
  // No revalidatePath: re-rendering the list would drop the answered request
  // and with it the confirmation beside it. The panel shows the answer, and
  // its Refresh reads the list again.
  return result;
}
