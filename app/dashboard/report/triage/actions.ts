"use server";

import { revalidatePath } from "next/cache";
import { betaOperatorGate } from "@/lib/beta-operator";
import { serviceClient } from "@/lib/supabase";
import { recordAdminAction } from "@/lib/audit";

const STATUSES = ["open", "acknowledged", "resolved"] as const;
export type ProblemReportStatus = (typeof STATUSES)[number];

export type TriageState = { ok: boolean; message: string } | undefined;

/**
 * A gate on the page does not gate an action. `/dashboard/report/triage` checks
 * betaOperatorGate() before it renders, and this re-checks it before it writes,
 * because a server action is a POST endpoint that anyone who knows its id can
 * call — the page it happens to be imported by is not a boundary.
 *
 * The audit row is written under the OPERATOR's id, not the reporter's, so the
 * trail answers "who decided this" rather than "who was complained about".
 */
export async function setProblemReportStatus(
  _previous: TriageState,
  formData: FormData
): Promise<TriageState> {
  const gate = await betaOperatorGate();
  if (!gate.ok) return { ok: false, message: "Only a named operator can triage reports." };

  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { ok: false, message: "That report id is malformed." };
  if (!(STATUSES as readonly string[]).includes(status)) {
    return { ok: false, message: "That is not a status a report can be in." };
  }

  const { error } = await serviceClient()
    .from("problem_reports")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return { ok: false, message: "The status could not be saved. Try again." };

  await recordAdminAction({
    userId: gate.user.id,
    action: "problem.triage",
    targetType: "problem_report",
    targetId: id,
    metadata: { via: "dashboard", status },
  });

  revalidatePath("/dashboard/report/triage");
  return { ok: true, message: `Marked ${status}.` };
}
