// Reconciliation cron (Tension 2). Periodically:
//   - recompute spent:<agid> and spent_cost:<agid> from agent_logs
//     (authoritative) -> fixes Redis drift.
//     Done INCREMENTALLY DB-side via the reconcile_agent_spend RPC (a cron-owned
//     checkpoint folds in only newly-settled rows each run) — O(new rows), not a
//     full-history scan per agent.
//   - reset reserved:<agid> and reserved_cost:<agid> to the sum of still-live
//     per-jti markers (orphaned reservations from crashed reconciles have
//     already expired) -> self-heal
//   - flush coalesced lastseen:<agid> into agents.last_seen_at
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
