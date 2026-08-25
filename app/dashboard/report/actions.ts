"use server";

import type { User } from "@supabase/supabase-js";
import { revalidatePath } from "next/cache";
import { mfaAuthorizedUser } from "@/lib/mfa";
import { userClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase";
import { rateLimit } from "@/lib/ratelimit";
import { recordAdminAction } from "@/lib/audit";
import { redactSecrets } from "@/lib/redact";
import { buildProblemDiagnostics, readInstanceStamp, withinDiagnosticSizeLimit } from "@/lib/problem-diagnostics";
// A "use server" file may export only async functions, so the vocabulary and
// the bounds live in a plain module both this and the client form can import.
import { PROBLEM_REPORT_TYPES, MESSAGE_MIN, MESSAGE_MAX } from "@/lib/problem-report-kinds";

/** Redis burst limiter — latency protection, and it fails open. */
const REPORT_LIMIT = 5;
const REPORT_WINDOW_S = 900;
/**
 * Database ceiling — durability protection, and it fails closed because it is
 * a plain indexed count with no second service to be unavailable. The pair is
 * the point: neither can be bypassed by the other's outage.
 */
const DAILY_REPORT_CEILING = 20;

export type ProblemReportState = { ok: boolean; message: string } | undefined;

/**
 * Copied from app/dashboard/settings/profile-actions.ts:80. Two clients, on
 * purpose: the cookie-bound one answers "who is this and have they cleared
 * MFA", the service-role one does the write, because RLS can only ask who owns
 * a row and never whether the session writing it cleared a second factor.
 *
 * No ensureProfileRow here — filing a report does not require a profile.
 */
type ActingUser =
  | { error: string }
  | { db: Awaited<ReturnType<typeof userClient>>; user: User };

async function actingUser(): Promise<ActingUser> {
  const db = await userClient();
  const gate = await mfaAuthorizedUser(db);
  if (!gate.ok) {
    return {
      error:
        gate.reason === "step_up_required"
          ? "Complete two-factor verification before sending a report."
          : gate.reason === "unauthenticated"
            ? "Sign in again to send a report."
            : "Your authentication assurance could not be verified. Try again.",
    };
  }
  return { db, user: gate.user };
}

/**
 * ── Diagnostics are DERIVED here. They are never accepted from the caller. ──
 *
 * The form shows a preview, and that preview is thrown away. If this action
 * took the rendered artifact back as an argument, a tenant could store anything
 * at all — a forged bundle, a secret-bearing blob, a megabyte of padding
 * (next.config.mjs caps a server action body at 1mb) — into a jsonb column with
 * the word "diagnostics" on it, which an operator would later open and believe.
 * The whole value of buildCloudSupportBundle is that it constructs from an
 * allowlist; a client-supplied artifact has none of that and looks identical.
 *
 * tests/problem-report-action.test.ts pins this, because it is the kind of
 * thing a later refactor "simplifies" by passing the preview through.
 */
export async function submitProblemReport(
  _previous: ProblemReportState,
  formData: FormData
): Promise<ProblemReportState> {
  const acting = await actingUser();
  if ("error" in acting) return { ok: false, message: acting.error };
  const { db, user } = acting;

  const kind = String(formData.get("kind") ?? "");
  if (!(PROBLEM_REPORT_TYPES as readonly string[]).includes(kind)) {
    return { ok: false, message: "Choose what kind of problem this is." };
  }
  const raw = String(formData.get("message") ?? "").trim();
  if (raw.length < MESSAGE_MIN || raw.length > MESSAGE_MAX) {
    return {
      ok: false,
      message: `Describe the problem in ${MESSAGE_MIN} to ${MESSAGE_MAX.toLocaleString()} characters.`,
    };
  }
  const attach = formData.get("attach_diagnostics") === "on";

  /**
   * Fail-open, deliberately, and it is the opposite call from the Direct Agent
   * Key path. That one fails closed because admitting an unauthenticated
   * request moves an outage onto the shared database. Here the caller has
   * already cleared session and MFA, the cost of one extra row is one row, and
   * the failure mode is perverse: a Redis outage is exactly when someone wants
   * to report that everything is broken, and refusing the report is the worst
   * possible answer.
   */
  const limited = await rateLimit(`problem-report:${user.id}`, REPORT_LIMIT, REPORT_WINDOW_S);
  if (!limited.success) {
    return { ok: false, message: "That is several reports in a short time. Try again in a few minutes." };
  }

  const admin = serviceClient();
  const now = new Date();

  // The backstop the fail-open limiter needs, because unlike a handle change
  // this write is durable and can carry 256 KB. One indexed count on
  // problem_reports_user_created_idx.
  const { count: recent, error: ceilingError } = await admin
    .from("problem_reports")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .gte("created_at", new Date(now.getTime() - 86_400_000).toISOString());
  if (ceilingError) return { ok: false, message: "The report could not be saved. Try again." };
  if ((recent ?? 0) >= DAILY_REPORT_CEILING) {
    return {
      ok: false,
      message: "This workspace has filed a lot of reports today. Reply to the existing thread instead, or try tomorrow.",
    };
  }

  let diagnostics = null as Awaited<ReturnType<typeof buildProblemDiagnostics>> | null;
  let droppedForSize = false;
  if (attach) {
    try {
      const built = await buildProblemDiagnostics(db, user, now);
      // Drop rather than reject, and drop rather than truncate: a truncated
      // artifact is worse than none because it still looks complete.
      if (withinDiagnosticSizeLimit(built)) diagnostics = built;
      else droppedForSize = true;
    } catch {
      // A failed collector must not cost the report. The words are the point.
      droppedForSize = true;
    }
  }

  const stamp = await readInstanceStamp();

  const { data: inserted, error } = await admin
    .from("problem_reports")
    .insert({
      // From the verified session, never from an argument.
      user_id: user.id,
      kind,
      // The one free-text field in the product that reaches durable storage.
      // Scrubbed on the way in rather than warned about on the way out.
      message: redactSecrets(raw),
      diagnostics,
      // Written from the same expression that decides the payload, so the two
      // cannot drift. The check constraint in 0038 rejects the row if they do.
      diagnostics_attached: diagnostics !== null,
      app_version: stamp.app_version,
      schema_head: stamp.schema_head,
      release_commit: stamp.build_commit,
    })
    .select("id")
    .single();

  if (error || !inserted) return { ok: false, message: "The report could not be saved. Try again." };

  await recordAdminAction({
    userId: user.id,
    action: "problem.report",
    targetType: "problem_report",
    targetId: inserted.id,
    // Field names and shapes, never the body. admin_audit is served by
    // GET /api/control/v1/audit; the text belongs in exactly one column.
    metadata: { via: "dashboard", kind, diagnostics_attached: diagnostics !== null, message_chars: raw.length },
  });

  revalidatePath("/dashboard/report");
  return {
    ok: true,
    message: droppedForSize
      ? "Report sent. The diagnostics could not be collected this time, so the report was sent without them."
      : diagnostics
        ? "Report sent, with the diagnostics you approved. Thank you."
        : "Report sent. Thank you.",
  };
}
