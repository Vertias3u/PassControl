// POST /api/control/v1/agents/{id}/trace — non-cacheable, read-only gate snapshot.
export const runtime = "edge";

import { control } from "@/lib/control/handler";
import { readJsonBody } from "@/lib/control/body";
import { errorResponse, jsonResponse } from "@/lib/control/respond";
import { rateLimit } from "@/lib/ratelimit";
import { isProvider } from "@/lib/providers";
import { evaluateDecisionTrace } from "./decision-trace";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MODEL_LENGTH = 200;
const TRACE_RATE_LIMIT = 30;
const TRACE_RATE_WINDOW_S = 60;

function noStore(response: Response): Response {
  response.headers.set("cache-control", "no-store");
  return response;
}

const handler = control("read", async ({ req, userId, db, params, requestId }) => {
  const agentId = params.id ?? "";
  if (!UUID_RE.test(agentId)) return noStore(errorResponse(400, "invalid_id", requestId));

  // This is the sole trace-specific Redis mutation. It is deliberately outside
  // all agent governance namespaces and is required to prevent free probing.
  const traceLimit = await rateLimit(
    `decision-trace:${userId}`,
    TRACE_RATE_LIMIT,
    TRACE_RATE_WINDOW_S
  );
  if (!traceLimit.success) {
    return noStore(
      errorResponse(429, "rate_limited", requestId, {
        "retry-after": String(TRACE_RATE_WINDOW_S),
      })
    );
  }

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return noStore(errorResponse(parsed.status, parsed.code, requestId));
  const provider = typeof parsed.body?.provider === "string" ? parsed.body.provider : "";
  const model = typeof parsed.body?.model === "string" ? parsed.body.model.trim() : "";
  if (!isProvider(provider) || !model || model.length > MAX_MODEL_LENGTH) {
    return noStore(errorResponse(400, "invalid_request", requestId));
  }

  const evaluatedAt = new Date();
  let policyAt = evaluatedAt;
  if (parsed.body?.timestamp !== undefined && parsed.body.timestamp !== "") {
    if (
      typeof parsed.body.timestamp !== "string" ||
      !/Z$/i.test(parsed.body.timestamp)
    ) {
      return noStore(errorResponse(400, "invalid_request", requestId));
    }
    policyAt = new Date(parsed.body.timestamp);
    if (!Number.isFinite(policyAt.getTime())) {
      return noStore(errorResponse(400, "invalid_request", requestId));
    }
  }

  const result = await evaluateDecisionTrace({
    db,
    userId,
    agentId,
    provider,
    model,
    evaluatedAt,
    policyAt,
  });
  if (!result.ok) {
    return noStore(errorResponse(result.status, result.code, requestId));
  }
  return noStore(jsonResponse({ data: result.trace }, requestId));
});

export function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
): Promise<Response> {
  // POST prevents bookmark/deep-link replay. Ignore Idempotency-Key so the
  // generic control wrapper cannot create an idempotency record for a read.
  const headers = new Headers(req.headers);
  headers.delete("idempotency-key");
  return handler(new Request(req, { headers }), ctx);
}
