// GET /api/control/v1/spend — per-agent + fleet spend (read scope). Tenant-scoped.
// Cost is in micro-cents (µ¢): USD = micro_cents / 100_000_000.
export const runtime = "edge";

import { control } from "@/lib/control/handler";
import { jsonResponse, errorResponse } from "@/lib/control/respond";

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
  }));
  const fleet = agents.reduce(
    (acc, a) => ({
      spent_tokens: acc.spent_tokens + a.spent_tokens,
      spent_microcents: acc.spent_microcents + a.spent_microcents,
    }),
    { spent_tokens: 0, spent_microcents: 0 }
  );

  return jsonResponse({ data: { fleet, agents } }, requestId);
});

export function GET(req: Request): Promise<Response> {
  return handler(req);
}
