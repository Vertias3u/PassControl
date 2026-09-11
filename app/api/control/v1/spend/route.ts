// GET /api/control/v1/spend — per-agent + fleet spend (read scope). Tenant-scoped.
// Cost is in micro-cents (µ¢): USD = micro_cents / 100_000_000.
//
// ── WHAT `spent_microcents` IS, AND WHAT IT IS NOT ──────────────────────────
//
// It is what PassControl CHARGED AGAINST THE BUDGET. Postgres defines that once,
// in 0055, as `coalesce(enforced_microcents, coalesce(cost_microcents, 0))`, and
// both `reconcile_agent_spend` and `rebuild_agent_spend` fold that same
// expression so the incremental total and the full rebuild cannot drift.
//
// For every call to a provider PassControl prices, that equals the observed
// cost. For a call it CANNOT price — a custom endpoint, where the operator's own
// gateway may mark up, re-route, or alias a familiar model name — the audit row
// records `cost_microcents: null` with `unpriced: true`, while the enforcement
// figure is a conservative estimate. The budget must still advance, or an agent
// runs forever against a limit that cannot move; so the estimate is charged, and
// this counter contains it.
//
// That made this endpoint say something the receipt for the same call denied:
// the receipt said the cost was unknown, this returned a precise dollar figure
// (T4-02). The counter is NOT changed here — making this surface disagree with
// the database's own definition of spend would be a worse defect than the one
// being fixed. `basis` states what the number is instead, so a consumer that
// persists it cannot read it as money a provider actually charged.
//
// Unpriced calls are reachable only where custom endpoints are enabled, which is
// self-host: Cloud leaves `PROVIDER_ENDPOINT_MODE` unset. An agent with a DOLLAR
// cap can no longer make one at all — the gateway refuses rather than enforce a
// limit it cannot compute — so `basis` differs from observed cost only for
// agents with no cost cap, or a token-only one.
export const runtime = "edge";

import { control } from "@/lib/control/handler";
import { jsonResponse, errorResponse } from "@/lib/control/respond";

/**
 * What the figure is measured on. `enforced` = charged against the budget, which
 * equals observed provider cost except on calls PassControl could not price.
 *
 * A constant rather than a literal because it is a contract: the day a second
 * basis exists, every place that emits one has to be found.
 */
const SPEND_BASIS = "enforced" as const;

const handler = control("read", async ({ userId, db, requestId }) => {
  const { data, error } = await db
    .from("agents")
    .select("id, name, spent_tokens, spent_microcents")
    .eq("user_id", userId); // tenant boundary
  if (error) return errorResponse(500, "query_failed", requestId);

  const agents = (data ?? []).map((a: any) => ({
    id: a.id,
    name: a.name,
    spent_tokens: Number(a.spent_tokens ?? 0),
    spent_microcents: Number(a.spent_microcents ?? 0),
    // Deliberately on every row, not only rows that contain an estimate. A field
    // that appears sometimes is a field a client will forget to check.
    basis: SPEND_BASIS,
  }));
  const fleet = agents.reduce(
    (acc, a) => ({
      spent_tokens: acc.spent_tokens + a.spent_tokens,
      spent_microcents: acc.spent_microcents + a.spent_microcents,
    }),
    { spent_tokens: 0, spent_microcents: 0 }
  );

  return jsonResponse({ data: { fleet: { ...fleet, basis: SPEND_BASIS }, agents } }, requestId);
});

export function GET(req: Request): Promise<Response> {
  return handler(req);
}
