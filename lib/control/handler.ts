// Control-plane route wrapper. Handles, in order: assign request-id → authenticate
// the API key → enforce the endpoint's required scope → per-key rate limit → run
// the handler → catch and generically report errors. Handlers get a ctx with the
// authenticated userId (which they MUST scope every query by — the service-role
// client bypasses RLS, so `.eq("user_id", ctx.userId)` is the tenant boundary).
import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceClient } from "@/lib/supabase";
import { rateLimit } from "@/lib/ratelimit";
import { authenticateApiKey, type Scope } from "./auth";
import { errorResponse, newRequestId } from "./respond";
import { normalizeIdemKey, runIdempotent } from "./idempotency";

export interface ControlCtx {
  req: Request;
  userId: string;
  scope: Scope;
  keyId: string;
  requestId: string;
  db: SupabaseClient;
  params: Record<string, string>;
}

// Per-key request budgets (call-volume guard; tune later). Writes are tighter.
const READ_LIMIT = 600;
const WRITE_LIMIT = 120;
const WINDOW_S = 60;
// Pre-auth, per-IP flood guard: bounds requests bearing missing/invalid keys so an
// attacker can't force an unbounded SHA-256 + key-lookup per request. Generous —
// legit single-client traffic stays well under it; it only clips floods.
const IP_LIMIT = Number(process.env.CONTROL_IP_LIMIT ?? "1000");

type RouteCtx = { params?: Promise<Record<string, string>> };

function clientIp(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

export function control(
  required: Scope,
  fn: (ctx: ControlCtx) => Promise<Response>
): (req: Request, routeCtx?: RouteCtx) => Promise<Response> {
  return async (req, routeCtx) => {
    const requestId = newRequestId();
    try {
      // Cheapest rejection first: bound floods by source IP before any auth work.
      const ipRl = await rateLimit(`control-ip:${clientIp(req)}`, IP_LIMIT, WINDOW_S);
      if (!ipRl.success) {
        return errorResponse(429, "rate_limited", requestId, { "retry-after": String(WINDOW_S) });
      }

      const auth = await authenticateApiKey(req);
      if (!auth.ok) return errorResponse(auth.status, auth.code, requestId);
      if (required === "write" && auth.scope !== "write") {
        return errorResponse(403, "insufficient_scope", requestId);
      }
      const limit = required === "write" ? WRITE_LIMIT : READ_LIMIT;
      const rl = await rateLimit(`control:${auth.keyId}`, limit, WINDOW_S);
      if (!rl.success) {
        return errorResponse(429, "rate_limited", requestId, { "retry-after": String(WINDOW_S) });
      }
      const params = routeCtx?.params ? await routeCtx.params : {};
      const exec = () =>
        fn({
          req,
          userId: auth.userId,
          scope: auth.scope,
          keyId: auth.keyId,
          requestId,
          db: serviceClient(),
          params,
        });

      // Idempotency for writes: if the client sends an Idempotency-Key, a retry
      // of the same request replays the first response instead of re-applying.
      const idemRaw = req.method !== "GET" ? req.headers.get("idempotency-key") : null;
      if (idemRaw != null) {
        const idem = normalizeIdemKey(idemRaw);
        if (!idem) return errorResponse(400, "invalid_idempotency_key", requestId);
        return await runIdempotent(auth.keyId, idem, requestId, exec);
      }
      return await exec();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[control]", requestId, e instanceof Error ? e.message : "unknown");
      return errorResponse(500, "internal_error", requestId);
    }
  };
}
