// Flow C — identity-aware reverse proxy.
//
// /v1/:provider/*  (OpenAI/Anthropic-shaped SDK traffic, Authorization: Bearer <visa>)
//
// Pipeline (target <15ms overhead before upstream on the cache-hit path):
//   1 verify visa  2 kill switch  3 scope  4 budget reserve (atomic)
//   5 resolve key (encrypted cache | Vault RPC)  6 inject + forward
//   7 single pass-through stream tee  8 waitUntil reconcile + audit log
export const runtime = "edge";

import { waitUntil } from "@vercel/functions";
import { verifyVisa, extractVisaToken } from "@/lib/auth/visa";
import { readKillState, isBlocked } from "@/lib/state/killswitch";
import {
  isSuspended,
  reserveBudget,
  reconcileBudget,
  getCachedKey,
  setCachedKey,
  seedSpent,
} from "@/lib/state/redis";
import { seal, open } from "@/lib/crypto/aesgcm";
import { serviceClient } from "@/lib/supabase";
import { canonicalEndpointPath, isModelListing, scopeAllows } from "@/lib/scope";
import { costMicrocents, estimateTokenUsage, MICROCENTS_PER_CENT } from "@/lib/pricing";
import { createUsageTransform, usageFromJson, type Usage } from "@/lib/usage/parseStream";
import { writeLog, mirrorSpend } from "@/lib/log";
import { isProvider, upstreamBaseUrl, authHeaders, usesOpenAiUsageShape, type ProviderId } from "@/lib/providers";
import { rateLimit } from "@/lib/ratelimit";
import { captureError, captureSecurityEvent } from "@/lib/observability";

// Per-agent request-rate cap (independent of the token budget): bounds raw call
// volume so a runaway/abusive agent can't flood the gateway or upstream. Generous
// for normal fleets; tune via env. Returns 429 + Retry-After when exceeded.
const PROXY_RATE_LIMIT = Number(process.env.PROXY_RATE_LIMIT ?? "600");
const PROXY_RATE_WINDOW_S = Number(process.env.PROXY_RATE_WINDOW_S ?? "60");

const KEY_CACHE_TTL_S = 60;
const RESERVE_MARKER_TTL_S = 960; // > max visa TTL (900s) + buffer
// Generous cap for an LLM request body (large prompts are legitimate) while still
// bounding memory/CPU against an oversized payload DoS.
const MAX_BODY_BYTES = 4 * 1024 * 1024;

function err(status: number, code: string) {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface Ctx {
  params: Promise<{ provider: string; path: string[] }>;
}

export async function POST(req: Request, ctx: Ctx) {
  return observedHandle(req, ctx);
}
export async function GET(req: Request, ctx: Ctx) {
  return observedHandle(req, ctx);
}

async function observedHandle(req: Request, ctx: Ctx): Promise<Response> {
  let provider: string | undefined;
  try {
    const params = await ctx.params;
    provider = params.provider;
    return await handle(req, params);
  } catch (error) {
    waitUntil(
      captureError(error, {
        route: "api.proxy",
        method: req.method,
        status: 500,
        provider,
        code: "internal_error",
      })
    );
    return err(500, "internal_error");
  }
}

async function handle(req: Request, params: { provider: string; path: string[] }): Promise<Response> {
  const started = Date.now();
  const { provider: providerRaw, path } = params;
  if (!isProvider(providerRaw)) return err(404, "unknown_provider");
  const provider: ProviderId = providerRaw;

  // Defense-in-depth: the upstream URL is built by string-joining these segments
  // onto a fixed allowlisted host. Reject traversal/encoded-traversal segments so
  // the path can't be manipulated into an unexpected shape. (No filesystem is
  // touched — this only guards the constructed upstream path.)
  if (path.some((seg) => seg === ".." || seg.includes("/") || /%2e%2e/i.test(seg))) {
    return err(400, "invalid_path");
  }

  // ── 1. Verify visa ──────────────────────────────────────────────────────────
  // Drop-in: accept the visa from Authorization: Bearer (OpenAI SDK) or x-api-key
  // (Anthropic SDK) so an existing agent only re-points its baseURL + apiKey.
  const visaToken = extractVisaToken(req.headers);
  if (!visaToken) return err(401, "missing_visa");
  const claims = await verifyVisa(visaToken);
  if (!claims) {
    waitUntil(
      captureSecurityEvent("proxy.invalid_visa", {
        route: "api.proxy",
        method: req.method,
        status: 401,
        provider,
        code: "invalid_visa",
      })
    );
    return err(401, "invalid_visa");
  }

  // Identity, ownership, and budget all travel in the (short-lived) visa, so the
  // hot path needs no per-request `agents` SELECT. Status changes propagate
  // within the visa TTL; instant revocation goes through the Redis suspend set
  // and the Redis-backed kill switches checked below.
  const agentId = claims.agid;
  const passportId = claims.sub;
  const jti = claims.jti;
  const reserveId = crypto.randomUUID();
  const userId: string = claims.uid;
  const capTokens: number | null = claims.bt ?? null;
  const capMicrocents: number | null =
    claims.bc == null ? null : Math.round(Number(claims.bc) * MICROCENTS_PER_CENT);
  const spentSnapshot: number = Number(claims.st ?? 0);
  const spentMicrocentsSnapshot: number = Number(claims.sc ?? 0);

  // ── Per-agent request-rate limit (call-volume DoS / abuse guard) ─────────────
  const rl = await rateLimit(`proxy:${agentId}`, PROXY_RATE_LIMIT, PROXY_RATE_WINDOW_S);
  if (!rl.success) {
    waitUntil(
      captureSecurityEvent("proxy.rate_limited", {
        route: "api.proxy",
        method: req.method,
        status: 429,
        provider,
        agentId,
        jti,
        code: "rate_limited",
      })
    );
    return new Response(JSON.stringify({ error: "rate_limited" }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": String(PROXY_RATE_WINDOW_S) },
    });
  }

  const db = serviceClient(); // used only on a key-cache miss (get_provider_key RPC)

  const logBlocked = (status: Parameters<typeof writeLog>[0]["status"], model?: string) =>
    waitUntil(
      writeLog({
        agentId,
        userId,
        passportId,
        jti,
        provider,
        model,
        status,
        latencyMs: Date.now() - started,
      })
    );

  const captureBlocked = (code: string, status: number) =>
    waitUntil(
      captureSecurityEvent(`proxy.${code}`, {
        route: "api.proxy",
        method: req.method,
        status,
        provider,
        agentId,
        jti,
        code,
      })
    );

  // ── 2. Kill switch (Redis: platform + this tenant + denylist; Redis per-agent suspend) ──
  const [kill, suspended] = await Promise.all([readKillState(userId), isSuspended(agentId)]);
  if (isBlocked(kill, agentId) || suspended) {
    logBlocked("blocked_suspended");
    captureBlocked("blocked_suspended", 403);
    return err(403, "blocked_suspended");
  }

  // ── Read body once (small); extract model + stream; mutate for usage ─────────
  // POST bodies must be JSON (the proxy parses + re-serializes them); reject other
  // declared content types rather than silently parsing.
  if (req.method !== "GET") {
    const ct = (req.headers.get("content-type") ?? "").toLowerCase();
    if (ct && !ct.includes("application/json")) return err(415, "unsupported_media_type");
  }
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return err(413, "payload_too_large");
  }
  let bodyObj: any = {};
  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY_BYTES) return err(413, "payload_too_large");
  if (rawBody) {
    try {
      bodyObj = JSON.parse(rawBody);
    } catch {
      return err(400, "invalid_body");
    }
  }
  const model: string = typeof bodyObj?.model === "string" ? bodyObj.model : "";
  const wantsStream = bodyObj?.stream === true;

  // ── 3. Scope + endpoint allowlist ────────────────────────────────────────────
  // Per-model scope applies to model-bound calls; the read-only model-listing
  // endpoint carries no model, so it is gated by the endpoint allowlist instead.
  if (!isModelListing(path) && !scopeAllows(claims.scope, provider, model)) {
    logBlocked("blocked_scope", model);
    captureBlocked("blocked_scope", 403);
    return err(403, "blocked_scope");
  }
  const upstreamPath = canonicalEndpointPath(provider, req.method, path);
  if (!upstreamPath) {
    logBlocked("blocked_endpoint", model);
    captureBlocked("blocked_endpoint", 403);
    return err(403, "blocked_endpoint");
  }

  // S5: ensure OpenAI-compatible streams report usage.
  if (usesOpenAiUsageShape(provider) && wantsStream) {
    bodyObj.stream_options = { ...(bodyObj.stream_options ?? {}), include_usage: true };
  }
  const forwardBody = JSON.stringify(bodyObj);

  // ── 4. Budget reserve (atomic) ───────────────────────────────────────────────
  const estimatedUsage = estimateTokenUsage(bodyObj);
  const estimate = estimatedUsage.totalTokens;
  const estimateMicrocents = costMicrocents(
    model,
    estimatedUsage.inputTokens,
    estimatedUsage.outputTokens,
    provider
  );
  if (capTokens != null || capMicrocents != null) {
    await seedSpent(agentId, spentSnapshot, spentMicrocentsSnapshot);
  }
  const reserve = await reserveBudget({
    agentId,
    reserveId,
    estimate,
    estimateMicrocents,
    capTokens,
    capMicrocents,
    markerTtlSeconds: RESERVE_MARKER_TTL_S,
  });
  if (!reserve.ok) {
    logBlocked("blocked_budget", model);
    captureBlocked("blocked_budget", 402);
    return err(402, "blocked_budget");
  }

  // From here a reservation is held; it MUST be reconciled on every exit path.
  const reconcile = (usage: Usage, status: Parameters<typeof writeLog>[0]["status"]) => {
    const cost = costMicrocents(model, usage.inputTokens, usage.outputTokens, provider);
    const tasks: Promise<unknown>[] = [
      reconcileBudget({
        agentId,
        reserveId,
        estimate,
        estimateMicrocents,
        actualTokens: usage.inputTokens + usage.outputTokens,
        actualMicrocents: cost,
      }),
      writeLog({
        agentId,
        userId,
        passportId,
        jti,
        provider,
        model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costMicrocents: cost,
        status,
        latencyMs: Date.now() - started,
      }),
    ];
    if (status === "ok") {
      tasks.push(mirrorSpend(agentId, usage.inputTokens + usage.outputTokens, cost));
    }
    return Promise.all(tasks);
  };

  // ── 5. Resolve provider key (encrypted cache, else Vault RPC) ────────────────
  let providerKey: string | null = null;
  const cached = await getCachedKey(agentId, provider);
  if (cached) providerKey = await open(cached);
  if (!providerKey) {
    const { data: keyData } = await db.rpc("get_provider_key", {
      p_agent_id: agentId,
      p_provider: provider,
    });
    providerKey = typeof keyData === "string" ? keyData : null;
    if (providerKey) {
      // store ciphertext only
      waitUntil(seal(providerKey).then((s) => setCachedKey(agentId, provider, s, KEY_CACHE_TTL_S)));
    }
  }
  if (!providerKey) {
    // No usage; release the reservation by reconciling with the estimate as spend
    // would over-count, so release exactly the reserve and log zero usage.
    waitUntil(reconcile({ inputTokens: 0, outputTokens: 0 }, "upstream_error"));
    return err(409, "no_provider_key");
  }

  // ── 6. Inject + forward ──────────────────────────────────────────────────────
  const targetUrl = `${upstreamBaseUrl(provider)}/${upstreamPath.join("/")}${new URL(req.url).search}`;
  const fwdHeaders = new Headers();
  fwdHeaders.set("content-type", "application/json");
  // Forward only a sanitized Accept (strip CR/LF/control chars to prevent header
  // injection, and bound the length). Everything else we set ourselves.
  const accept = req.headers.get("accept");
  if (accept) {
    const safeAccept = accept.replace(/[\r\n\x00-\x1f]/g, "").slice(0, 256);
    if (safeAccept) fwdHeaders.set("accept", safeAccept);
  }
  for (const [h, v] of Object.entries(authHeaders(provider, providerKey))) fwdHeaders.set(h, v);

  let upstream: Response;
  try {
    upstream = await fetch(targetUrl, {
      method: req.method,
      headers: fwdHeaders,
      body: req.method === "GET" ? undefined : forwardBody,
      signal: req.signal,
    });
  } catch (error) {
    waitUntil(
      captureError(error, {
        route: "api.proxy",
        method: req.method,
        status: 502,
        provider,
        agentId,
        jti,
        code: "upstream_unreachable",
      })
    );
    waitUntil(reconcile({ inputTokens: 0, outputTokens: 0 }, "upstream_error"));
    return err(502, "upstream_unreachable");
  }

  const contentType = upstream.headers.get("content-type") ?? "";
  const isStream = contentType.includes("text/event-stream");

  // Surface upstream errors verbatim (never leak the key); reconcile by releasing.
  if (!upstream.ok) {
    waitUntil(reconcile({ inputTokens: 0, outputTokens: 0 }, "upstream_error"));
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "content-type": contentType || "application/json" },
    });
  }

  // ── 7/8. Stream tee + reconcile, OR buffered JSON path ───────────────────────
  if (isStream && upstream.body) {
    const { stream, usage } = createUsageTransform(provider);
    // The monitored transform resolves usage exactly once on normal close or client cancel.
    waitUntil(usage.then((u) => reconcile(u, "ok")));
    return new Response(upstream.body.pipeThrough(stream), {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      },
    });
  }

  // Non-streaming JSON: read, tally, forward.
  const json = await upstream.json().catch(() => ({}));
  const usage = usageFromJson(provider, json);
  waitUntil(reconcile(usage, "ok"));
  return new Response(JSON.stringify(json), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
