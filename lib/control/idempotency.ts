// Idempotency for control-plane writes. When a client sends `Idempotency-Key`,
// a retry of the SAME logical request returns the first response instead of
// re-applying the mutation. Backed by Redis: we claim the key (SET NX), run the
// handler once, cache its response, and replay it on retries. A concurrent retry
// while the first is in flight gets 409; transient 5xx responses are not cached
// (the claim is released so a real retry can proceed).
import { redis } from "@/lib/state/redis";
import { errorResponse } from "./respond";

const TTL_S = 86_400; // 24h
const MAX_LEN = 200;

/** Sanitize/bound a client Idempotency-Key. Returns null if unusable. */
export function normalizeIdemKey(raw: string): string | null {
  const k = raw.replace(/[\r\n\t\x00-\x1f\x7f]/g, "").trim();
  if (!k || k.length > MAX_LEN) return null;
  return k;
}

interface Cached {
  status: number;
  body: string;
}

/** Run `exec` at most once per (scopeKey, idemKey); replay the cached response on
 *  retries. `scopeKey` should namespace by the API key so keys don't collide
 *  across tenants. */
export async function runIdempotent(
  scopeKey: string,
  idemKey: string,
  requestId: string,
  exec: () => Promise<Response>
): Promise<Response> {
  const r = redis();
  const cacheKey = `idem:${scopeKey}:${idemKey}`;

  const claimed = await r.set(cacheKey, "pending", { nx: true, ex: TTL_S });
  if (claimed !== "OK") {
    const existing = await r.get<Cached | string>(cacheKey);
    if (existing && typeof existing === "object") {
      return new Response(existing.body, {
        status: existing.status,
        headers: { "content-type": "application/json", "x-request-id": requestId, "idempotent-replay": "true" },
      });
    }
    // Still "pending" — the original request is in flight.
    return errorResponse(409, "request_in_progress", requestId);
  }

  try {
    const res = await exec();
    const body = await res.text();
    if (res.status >= 500) {
      // Don't cache transient failures; free the claim so a retry can run.
      await r.del(cacheKey).catch(() => {});
    } else {
      await r.set(cacheKey, { status: res.status, body } satisfies Cached, { ex: TTL_S });
    }
    return new Response(body, {
      status: res.status,
      headers: { "content-type": "application/json", "x-request-id": requestId },
    });
  } catch (e) {
    await r.del(cacheKey).catch(() => {});
    throw e;
  }
}
