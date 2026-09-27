// Reconciliation cron (Tension 2). lib/reconcile.ts is the authority; this is
// what it does now, and each step there says why:
//   - RAISES spent:<agid> / spent_cost:<agid> toward the running totals from the
//     incremental, lagged reconcile_agent_spend RPC (a cron-owned checkpoint
//     folds in only newly settled agent_logs rows). A monotone floor: it can
//     recover a settlement whose Redis write was lost, and it can never lower a
//     counter or create capacity. It used to SET them, which erased every
//     settlement made inside the lag window.
//   - Does NOT write reserved:<agid> / reserved_cost:<agid>. Reservations move
//     only through the atomic hold transitions; open holds and any mismatch
//     between reserved: and the open holds are REPORTED in the result, never
//     corrected. It used to rebuild reserved: from a SCAN of per-request markers,
//     which could overwrite a reservation taken concurrently.
//   - Flushes coalesced lastseen:<agid> into agents.last_seen_at.
//   - Passport housekeeping: clears retired keys past their grace window, lists
//     passports about to expire (reported, not renewed), closes lapsed
//     break-glass grants, and reports observe-only passport source signals.
//
// Schedule via vercel.json cron hitting GET /api/cron/reconcile with CRON_SECRET.
export const runtime = "edge";

import { redis } from "@/lib/state/redis";
import { serviceClient } from "@/lib/supabase";
import { timingSafeEqual } from "@/lib/crypto/constantTime";
import { runReconcile } from "@/lib/reconcile";

// Only fold agent_logs rows that have settled for this long, so a row whose
// created_at (= now() at insert) precedes the cutoff but whose commit lands after
// the reconcile snapshot can never be skipped permanently. The hot-path budget
// counter is updated live by the proxy; this correction layer can safely lag.
const RECONCILE_LAG_SECONDS = Number(process.env.RECONCILE_LAG_SECONDS ?? "60");

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const provided =
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    new URL(req.url).searchParams.get("secret");
  if (!secret || !provided || !timingSafeEqual(provided, secret)) {
    return new Response("unauthorized", { status: 401 });
  }

  const result = await runReconcile(serviceClient(), redis(), {
    lagSeconds: RECONCILE_LAG_SECONDS,
  });
  return Response.json({ ok: true, ...result });
}
