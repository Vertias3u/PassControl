/**
 * Reads over public.problem_reports.
 *
 * The table is unreachable to the browser role — RLS on, no policies, no grant
 * — so every read here goes through the service client, and the tenant boundary
 * is enforced in code by an explicit filter rather than by RLS. That is the
 * trade the migration header explains: RLS filters rows, not columns, and a
 * table-level SELECT grant would have handed every tenant the operator-
 * restricted build stamp along with their own row.
 *
 * Which makes the column lists below load-bearing rather than tidy. There are
 * two, and they differ on purpose:
 *
 *   loadOwnProblemReports  — omits app_version / schema_head / release_commit.
 *                            Those describe OUR instance, and how far behind a
 *                            database is doubles as a list of the fixes it
 *                            lacks. Omits diagnostics too: the reporter already
 *                            saw and approved that payload, and re-serving it
 *                            on a page load is bytes for nothing.
 *   loadProblemReportRows  — the operator surface, which needs the stamp to
 *                            answer "which build was this filed against". Reads
 *                            the denormalised diagnostics_attached flag and NOT
 *                            the payload: 250 rows x 256 KB would be a 64 MB
 *                            response to render a checkbox.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { maskEmail } from "@/lib/seclog";

const OWN_COLUMNS = "id, kind, status, created_at, updated_at";
const OPERATOR_COLUMNS =
  "id, user_id, kind, message, status, app_version, schema_head, release_commit, diagnostics_attached, created_at, updated_at";

export interface OwnProblemReport {
  id: string;
  kind: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProblemReportRow {
  id: string;
  userId: string;
  reporter: string;
  kind: string;
  message: string;
  status: string;
  appVersion: string | null;
  schemaHead: string | null;
  releaseCommit: string | null;
  diagnosticsAttached: boolean;
  createdAt: string;
}

/** A pre-0038 database is not an error here — the page renders without history. */
function absentTable(code: string | undefined): boolean {
  return code === "42P01" || code === "PGRST205";
}

export async function loadOwnProblemReports(
  admin: SupabaseClient,
  userId: string,
  limit = 20
): Promise<OwnProblemReport[]> {
  const { data, error } = await admin
    .from("problem_reports")
    .select(OWN_COLUMNS)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    if (absentTable(error.code)) return [];
    throw new Error("problem_reports_unavailable");
  }
  return (data ?? []).map((row) => ({
    id: String(row.id),
    kind: String(row.kind),
    status: String(row.status),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }));
}

export async function loadProblemReportRows(
  admin: SupabaseClient,
  limit = 250
): Promise<ProblemReportRow[]> {
  const { data, error } = await admin
    .from("problem_reports")
    .select(OPERATOR_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    if (absentTable(error.code)) return [];
    throw new Error("problem_reports_unavailable");
  }
  const rows = data ?? [];

  // One bounded lookup for the reporters actually on this page, masked before
  // it reaches a component. An operator needs to correlate two reports to one
  // person; they do not need the address to do it.
  const userIds = [...new Set(rows.map((row) => String(row.user_id)))];
  const emails = new Map<string, string>();
  if (userIds.length > 0) {
    const { data: users } = await admin.from("users").select("id, email").in("id", userIds);
    for (const user of users ?? []) {
      const email = typeof user.email === "string" ? user.email : "";
      if (email) emails.set(String(user.id), maskEmail(email));
    }
  }

  return rows.map((row) => ({
    id: String(row.id),
    userId: String(row.user_id),
    reporter: emails.get(String(row.user_id)) ?? "unknown",
    kind: String(row.kind),
    message: String(row.message),
    status: String(row.status),
    appVersion: row.app_version === null ? null : String(row.app_version),
    schemaHead: row.schema_head === null ? null : String(row.schema_head),
    releaseCommit: row.release_commit === null ? null : String(row.release_commit),
    // The denormalised flag, never the payload — that is the whole reason the
    // column exists. loadProblemReportDiagnostics fetches the one an operator
    // actually opens.
    diagnosticsAttached: row.diagnostics_attached === true,
    createdAt: String(row.created_at),
  }));
}

export async function loadProblemReportDiagnostics(
  admin: SupabaseClient,
  id: string
): Promise<unknown | null> {
  const { data, error } = await admin.from("problem_reports").select("diagnostics").eq("id", id).maybeSingle();
  if (error || !data) return null;
  return data.diagnostics ?? null;
}
