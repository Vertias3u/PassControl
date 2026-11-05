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
  fp?: string;
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
  exec: () => Promise<Response>,
  fp: string
): Promise<Response> {
  const r = redis();
  const cacheKey = `idem:${scopeKey}:${idemKey}`;

  // The claim is a STRING, not an object: a still-running older deployment reads any
  // object here as a finished response and would replay it as an empty 200. A string
  // it answers with 409, as it always did.
  const claimed = await r.set(cacheKey, `pending:${fp}`, { nx: true, ex: TTL_S });
  if (claimed !== "OK") {
    const existing = await r.get<unknown>(cacheKey);
    // Expired between the claim and the read: it was in flight a moment ago.
    if (existing === null) return errorResponse(409, "request_in_progress", requestId);
    const record = existing && typeof existing === "object"
      ? existing as Record<string, unknown> : null;
    const cached = record && typeof record.status === "number" && typeof record.body === "string";
    // Rolling deploy compatibility: the old bare pending marker and response
    // shape remain valid until their TTL expires. Unknown shapes fail closed.
    const pendingFp = typeof existing === "string" && existing.startsWith("pending:") ? existing.slice(8) : null;
    // A bare "pending" claim or an fp-less response predates CP6: honour it as before.
    const legacy = existing === "pending" || (cached && record.fp === undefined);
    const sameRequest = legacy || (cached ? record.fp === fp : pendingFp === fp);
    if ((!cached && !legacy && pendingFp === null) || !sameRequest) {
      return errorResponse(422, "idempotency_key_reused", requestId);
    }
    if (cached) {
      return new Response(record.body as string, {
        status: record.status as number,
        headers: { "content-type": "application/json", "x-request-id": requestId, "idempotent-replay": "true" },
      });
    }
    return errorResponse(409, "request_in_progress", requestId);
  }

  try {
    const res = await exec();
    const body = await res.text();
    if (res.status >= 500) {
      // Don't cache transient failures; free the claim so a retry can run.
      await r.del(cacheKey).catch(() => {});
    } else {
      await r.set(cacheKey, { status: res.status, body, fp } satisfies Cached, { ex: TTL_S });
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
