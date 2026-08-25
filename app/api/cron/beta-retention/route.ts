export const runtime = "edge";

import { timingSafeEqual } from "@/lib/crypto/constantTime";
import { serviceClient } from "@/lib/supabase";

export async function GET(request: Request) {
  const expected = process.env.CRON_SECRET;
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/iu, "");
  if (!expected || !provided || !timingSafeEqual(provided, expected)) {
    return new Response("unauthorized", { status: 401 });
  }
  const admin = serviceClient();
  const { data, error } = await admin.rpc("purge_beta_launch_data");
  if (error) return Response.json({ ok: false, error: "retention_unavailable" }, { status: 503 });

  // Problem reports age out on the same schedule, in the same request. A
  // retention rule with no caller is a comment, not a rule — and this is the
  // only scheduled sweep in the product, so a second cron entry would be one
  // more thing to forget to configure. Resolved reports only: an OPEN report
  // is one nobody has answered, and deleting it destroys the record of a
  // problem while the problem is still live.
  //
  // A failure here does NOT fail the beta sweep that already succeeded — the
  // response reports each half separately rather than turning a partial
  // success into a 503 that invites a retry of work already done.
  const reports = await admin.rpc("purge_problem_reports");
  return Response.json({
    ok: true,
    purged: data,
    problem_reports: reports.error ? "unavailable" : (reports.data ?? 0),
  });
}
