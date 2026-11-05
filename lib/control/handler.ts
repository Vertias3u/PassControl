// Control-plane route wrapper. Handles, in order: assign request-id → authenticate
// the API key → enforce the endpoint's required scope → per-key rate limit → run
// the handler → catch and generically report errors. Handlers get a ctx with the
// authenticated userId (which they MUST scope every query by — the service-role
// client bypasses RLS, so `.eq("user_id", ctx.userId)` is the tenant boundary).
import { readBoundedBody } from "@/lib/http/bounded-body";
import { clientIp } from "@/lib/http/client-ip";
import { waitUntil } from "@vercel/functions";
import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceClient } from "@/lib/supabase";
import { rateLimit } from "@/lib/ratelimit";
import { captureError, captureSecurityEvent } from "@/lib/observability";
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
/** The same cap lib/control/body.ts applies; control payloads are tiny. */
const CONTROL_BODY_MAX_BYTES = 64 * 1024;
// Pre-auth, per-IP flood guard: bounds requests bearing missing/invalid keys so an
// attacker can't force an unbounded SHA-256 + key-lookup per request. Generous —
// legit single-client traffic stays well under it; it only clips floods.
const IP_LIMIT = Number(process.env.CONTROL_IP_LIMIT ?? "1000");

type RouteCtx = { params?: Promise<Record<string, string>> };

export function control(
  required: Scope,
  fn: (ctx: ControlCtx) => Promise<Response>
): (req: Request, routeCtx?: RouteCtx) => Promise<Response> {
  return async (req, routeCtx) => {
    const requestId = newRequestId();
    const captureControlSecurity = (code: string, status: number) =>
      waitUntil(
        captureSecurityEvent(`control.${code}`, {
          route: "api.control",
          method: req.method,
          status,
          requestId,
          controlScope: required,
          code,
        })
      );

    try {
      // Cheapest rejection first: bound floods by source IP before any auth work.
      const ipRl = await rateLimit(`control-ip:${clientIp(req)}`, IP_LIMIT, WINDOW_S);
      if (!ipRl.success) {
        captureControlSecurity("rate_limited", 429);
        return errorResponse(429, "rate_limited", requestId, { "retry-after": String(WINDOW_S) });
      }

      const auth = await authenticateApiKey(req);
      if (!auth.ok) {
        if (auth.status >= 500) {
          waitUntil(
            captureError(new Error(`control ${auth.code}`), {
              route: "api.control",
              method: req.method,
              status: auth.status,
              requestId,
              controlScope: required,
              code: auth.code,
            })
          );
        } else {
          captureControlSecurity(auth.code, auth.status);
        }
        return errorResponse(auth.status, auth.code, requestId);
      }
      if (required === "write" && auth.scope !== "write") {
        captureControlSecurity("insufficient_scope", 403);
        return errorResponse(403, "insufficient_scope", requestId);
      }
      const limit = required === "write" ? WRITE_LIMIT : READ_LIMIT;
      const rl = await rateLimit(`control:${auth.keyId}`, limit, WINDOW_S);
      if (!rl.success) {
        captureControlSecurity("rate_limited", 429);
        return errorResponse(429, "rate_limited", requestId, { "retry-after": String(WINDOW_S) });
      }
      const params = routeCtx?.params ? await routeCtx.params : {};
      const exec = (request: Request = req) =>
        fn({
          req: request,
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
        if (!idem) {
          captureControlSecurity("invalid_idempotency_key", 400);
          return errorResponse(400, "invalid_idempotency_key", requestId);
        }
        // Cloud review 2026-11-03, CP6: the key is bound to the request it was first
        // sent with. Read the body once, under the control plane's 64 KiB cap, and
        // hand the handler a request rebuilt from those bytes (no tee to cancel).
        const body = await readBoundedBody(req, CONTROL_BODY_MAX_BYTES);
        if (!body.ok) return errorResponse(413, "payload_too_large", requestId);
        const replayable = new Request(req.url, {
          method: req.method,
          headers: req.headers,
          body: body.text === "" ? undefined : body.text,
        });
        const url = new URL(req.url);
        // Web Crypto, not node:crypto: every control route runs on the edge runtime.
        const digest = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode([req.method, url.pathname + url.search, body.text].join("\n"))
        );
        const fp = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
        return await runIdempotent(auth.keyId, idem, requestId, () => exec(replayable), fp);
      }
      return await exec();
    } catch (e) {
      waitUntil(
        captureError(e, {
          route: "api.control",
          method: req.method,
          status: 500,
          requestId,
          controlScope: required,
          code: "internal_error",
        })
      );
      // eslint-disable-next-line no-console
      console.error("[control]", requestId, e instanceof Error ? e.message : "unknown");
      return errorResponse(500, "internal_error", requestId);
    }
  };
}
