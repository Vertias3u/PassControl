// Flow C — identity-aware reverse proxy.
//
// /v1/:provider/*  (OpenAI/Anthropic-shaped SDK traffic, Authorization: Bearer <visa>)
//
// Pipeline (target <15ms overhead before upstream on the cache-hit path):
//   1 verify visa  2 kill switch  3 scope + endpoint  4 current policy
//   5 budget reserve (atomic)  6 resolve key (encrypted cache | Vault RPC)
//   7 inject + forward  8 stream tee  9 waitUntil reconcile + audit log
export const runtime = "edge";

import { waitUntil } from "@vercel/functions";
import { verifyVisa, extractVisaToken } from "@/lib/auth/visa";
import { readKillState } from "@/lib/state/killswitch";
import {
  isSuspended,
  reserveBudget,
  reconcileBudget,
  getCachedKey,
  setCachedKey,
  seedSpent,
} from "@/lib/state/redis";
import { readCurrentAgentPolicy } from "@/lib/state/policy";
import { seal, open } from "@/lib/crypto/aesgcm";
import { serviceClient } from "@/lib/supabase";
import { canonicalEndpointPath } from "@/lib/scope";
import {
  POLICY_UNREADABLE,
  evaluateGate,
  type GateInput,
  type GatePolicyInput,
  type GateRateLimitInput,
} from "@/lib/gate";
import { costMicrocents, estimateTokenUsage, MICROCENTS_PER_CENT } from "@/lib/pricing";
import { createUsageTransform, usageFromJson, type Usage } from "@/lib/usage/parseStream";
import { writeLog, mirrorSpend } from "@/lib/log";
import { signReceipt, type OwnerClaim } from "@/lib/receipt";
import { readCurrentOwner } from "@/lib/owner/current";
import { isProvider, upstreamBaseUrl, authHeaders, usesOpenAiUsageShape, type ProviderId } from "@/lib/providers";
import { rateLimit } from "@/lib/ratelimit";
import { captureError, captureSecurityEvent, logFailOpen } from "@/lib/observability";

// Per-agent request-rate cap (independent of the token budget): bounds raw call
// volume so a runaway/abusive agent can't flood the gateway or upstream. Generous
// for normal fleets; tune via env. Returns 429 + Retry-After when exceeded.
const PROXY_RATE_LIMIT = Number(process.env.PROXY_RATE_LIMIT ?? "600");
const PROXY_RATE_WINDOW_S = Number(process.env.PROXY_RATE_WINDOW_S ?? "60");

const KEY_CACHE_TTL_S = 60;
const POLICY_RATE_WINDOW_S = 60 * 60;
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

type ServiceDatabase = ReturnType<typeof serviceClient>;
type GateBaseInput = Omit<
  GateInput,
  "policy" | "policyFailClosed" | "policyRateLimit" | "budget"
>;

const BLOCKED_POLICY_STATUS = "blocked_policy" satisfies Parameters<typeof writeLog>[0]["status"];

async function evaluateCurrentPolicyGate(
  db: ServiceDatabase,
  userId: string,
  agentId: string,
  base: GateBaseInput
): Promise<{
  gate: ReturnType<typeof evaluateGate>;
  policy: GatePolicyInput;
  policyRateLimit?: GateRateLimitInput;
}> {
  const currentPolicy = await readCurrentAgentPolicy(db, userId, agentId);
  const policy: GatePolicyInput =
    currentPolicy === POLICY_UNREADABLE
      ? { kind: POLICY_UNREADABLE }
      : { kind: "value", value: currentPolicy };

  if (currentPolicy === POLICY_UNREADABLE) {
    logFailOpen("policy_read");
  }

  let gate = evaluateGate({
    ...base,
    policy,
    policyFailClosed: process.env.POLICY_FAIL_CLOSED === "true",
  });
  let policyRateLimit: GateRateLimitInput | undefined;
  if (!gate.deniedBy && gate.policyRateLimitRequired !== null) {
    policyRateLimit = await rateLimit(
      `policy-hour:${userId}:${agentId}`,
      gate.policyRateLimitRequired,
      POLICY_RATE_WINDOW_S
    );
    gate = evaluateGate({
      ...base,
      policy,
      policyFailClosed: process.env.POLICY_FAIL_CLOSED === "true",
      policyRateLimit,
    });
  }

  return { gate, policy, ...(policyRateLimit ? { policyRateLimit } : {}) };
}

function policyBlockDetails(gate: ReturnType<typeof evaluateGate>): {
  reason: "deny" | "window" | "malformed" | "rate_limit" | "unreadable";
  rule: string;
  status: 403 | 429;
} {
  const step = gate.steps.find((candidate) => candidate.name === "policy");
  const rule = step?.rule ?? "policy:malformed";
  const reason =
    rule === "policy:unreadable"
      ? "unreadable"
      : rule === "max_requests_per_hour"
        ? "rate_limit"
        : rule === "policy:malformed"
          ? "malformed"
          : rule === "windows:no_match"
            ? "window"
            : "deny";
  return { reason, rule, status: step?.httpStatus === 429 ? 429 : 403 };
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

  // Keyless demo provider (local "try it" stack + CI). Env-gated OFF by default,
  // so production has ZERO extra surface. It runs the full real governance
  // pipeline (visa → kill → scope → policy → budget); only the Vault-key resolution +
  // upstream forward is replaced with a synthesized response — it never reaches
  // get_provider_key and never forwards anywhere.
  if (providerRaw === "demo") {
    return demoEnabled() ? handleDemo(req, path, started) : err(404, "unknown_provider");
  }

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

  // Identity, ownership, and budget travel in the (short-lived) visa. Policy is
  // intentionally current state and adds an `agents` SELECT only on its 60-second
  // cache miss. Instant revocation remains Redis-backed below.
  const agentId = claims.agid;
  const passportId = claims.sub;
  const jti = claims.jti;
  const reserveId = crypto.randomUUID();
  // Named here so the id can travel in a response header before the log row —
  // and the signed receipt inside it — exists. The proof is built and signed
  // later, in waitUntil; the hot path costs one uuid and one header.
  const receiptId = crypto.randomUUID();
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
    // No receipt id: the rate limit fires before any gate runs and writes no
    // row, so there would be nothing for the id to name.
    return new Response(JSON.stringify({ error: "rate_limited" }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": String(PROXY_RATE_WINDOW_S) },
    });
  }

  // Used on a policy-cache miss and on a provider-key-cache miss.
  const db = serviceClient();

  // Names the receipt for a GOVERNED decision — one where the gate ran and a row
  // is written. Used only on paths that also call logBlocked/reconcile, so the
  // id in the header always resolves at /api/control/v1/receipts/{id}.
  //
  // Deliberately NOT used for malformed-request rejections (415/413/400) or the
  // rate limit: those write no row, so advertising an id there would hand the
  // caller a reference that 404s. The header's contract is "this id names a
  // decision the gateway recorded", and it has to stay true to be worth having.
  const errR = (status: number, code: string) =>
    new Response(JSON.stringify({ error: code }), {
      status,
      headers: { "content-type": "application/json", "x-passcontrol-receipt-id": receiptId },
    });

  // The revocation gate runs before the body is read, deliberately. A receipt
  // written from there has no request to digest, and must say so by omitting the
  // digest rather than reporting one over "". Assigned once the body is read.
  let capturedBody: string | null = null;

  // signReceipt already swallows its own failures, but this call sits INSIDE the
  // argument list of writeLog inside reconcile(). If it ever throws, the tasks
  // array is destroyed before Promise.all forms: the budget reservation is never
  // released and the audit row is lost. Never make a governance path depend on a
  // signing path staying well-behaved — belt and braces, one line.
  const safeReceipt = (input: Parameters<typeof signReceipt>[0]): string | null => {
    try {
      return signReceipt(input);
    } catch {
      return null;
    }
  };

  // Read at most once per request, and only if a receipt is actually written.
  // Redis-cached for 300s, so the common case costs nothing; resolves to null on
  // any failure, because a receipt with no owner claim is still a valid receipt.
  let ownerRead: Promise<OwnerClaim | null> | null = null;
  const currentOwner = () =>
    (ownerRead ??= readCurrentOwner(db, userId).catch(() => null));

  const logBlocked = (
    status: Parameters<typeof writeLog>[0]["status"],
    model?: string,
    httpStatus = 403
  ) =>
    waitUntil(
      (async () =>
        writeLog({
          id: receiptId,
          receipt: safeReceipt({
            receiptId,
            passportId,
            agentId,
            visaJti: jti,
            provider,
            model,
            method: req.method,
            path: path.join("/"),
            rawBody: capturedBody,
            inputTokens: 0,
            outputTokens: 0,
            costMicrocents: 0,
            status,
            httpStatus,
            startedAt: started,
            latencyMs: Date.now() - started,
            owner: await currentOwner(),
          }),
          agentId,
          userId,
          passportId,
          jti,
          provider,
          model,
          status,
          latencyMs: Date.now() - started,
        }))()
    );

  const captureBlocked = (code: string, status: number, controlScope?: string) =>
    waitUntil(
      captureSecurityEvent(`proxy.${code}`, {
        route: "api.proxy",
        method: req.method,
        status,
        provider,
        agentId,
        jti,
        code,
        controlScope,
      })
    );

  // ── 2. Kill switch (Redis: platform + this tenant + denylist; Redis per-agent suspend) ──
  const [kill, suspended] = await Promise.all([readKillState(userId), isSuspended(agentId)]);
  const revocationGate = evaluateGate({
    agentId,
    killState: kill,
    suspended,
    provider,
    method: req.method,
    path,
    model: "",
  });
  if (revocationGate.deniedBy === "kill" || revocationGate.deniedBy === "suspend") {
    const blocked = revocationGate.deniedBy === "kill" ? "blocked_killed" : "blocked_suspended";
    // Log and alert on the control that actually fired; answer the wire with the
    // single opaque code so a caller still cannot probe which one it tripped.
    logBlocked(blocked);
    captureBlocked(blocked, 403);
    return errR(403, "blocked_suspended");
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
  // From here a receipt can bind what the client actually sent. Note this is
  // rawBody, never forwardBody: the proxy injects stream_options.include_usage
  // below and re-serialises, and the verifier holds the client's bytes.
  capturedBody = rawBody;
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
  const gateBase: GateBaseInput = {
    agentId,
    killState: kill,
    suspended,
    scopes: claims.scope,
    provider,
    method: req.method,
    path,
    model,
    now: new Date(),
  };
  const prePolicyGate = evaluateGate(gateBase);
  if (prePolicyGate.deniedBy === "scope") {
    logBlocked("blocked_scope", model);
    captureBlocked("blocked_scope", 403);
    return errR(403, "blocked_scope");
  }
  if (prePolicyGate.deniedBy === "endpoint") {
    logBlocked("blocked_endpoint", model);
    captureBlocked("blocked_endpoint", 403);
    return errR(403, "blocked_endpoint");
  }
  const upstreamPath = canonicalEndpointPath(provider, req.method, path);
  if (!upstreamPath) {
    // Defensive invariant: the shared evaluator and canonical path resolver use
    // the same allowlist and must never disagree.
    logBlocked("blocked_endpoint", model);
    captureBlocked("blocked_endpoint", 403);
    return errR(403, "blocked_endpoint");
  }

  // ── 4. Current per-agent policy ────────────────────────────────────────────
  // Policy is deliberately not a visa claim: an owner's change takes effect on
  // the next cache refresh rather than waiting for the visa TTL.
  const currentPolicyGate = await evaluateCurrentPolicyGate(db, userId, agentId, gateBase);
  if (currentPolicyGate.gate.deniedBy === "policy") {
    const policy = policyBlockDetails(currentPolicyGate.gate);
    logBlocked(BLOCKED_POLICY_STATUS, model, policy.status);
    captureBlocked(`blocked_policy_${policy.reason}`, policy.status, policy.rule);
    return errR(policy.status, "blocked_policy");
  }

  // S5: ensure OpenAI-compatible streams report usage.
  if (usesOpenAiUsageShape(provider) && wantsStream) {
    bodyObj.stream_options = { ...(bodyObj.stream_options ?? {}), include_usage: true };
  }
  const forwardBody = JSON.stringify(bodyObj);

  // ── 5. Budget reserve (atomic) ───────────────────────────────────────────────
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
  const finalGate = evaluateGate({
    ...gateBase,
    policy: currentPolicyGate.policy,
    policyFailClosed: process.env.POLICY_FAIL_CLOSED === "true",
    ...(currentPolicyGate.policyRateLimit
      ? { policyRateLimit: currentPolicyGate.policyRateLimit }
      : {}),
    budget: {
      ok: reserve.ok,
      reason: reserve.reason,
      estimateTokens: estimate,
      estimateMicrocents,
      reservedTokens: reserve.reserved,
      reservedMicrocents: reserve.reservedMicrocents,
      source: "atomic_reserve",
    },
  });
  if (finalGate.deniedBy === "budget") {
    logBlocked("blocked_budget", model, 402);
    captureBlocked("blocked_budget", 402);
    return errR(402, "blocked_budget");
  }

  // From here a reservation is held; it MUST be reconciled on every exit path.
  const reconcile = async (
    usage: Usage,
    status: Parameters<typeof writeLog>[0]["status"],
    httpStatus = 200
  ) => {
    const cost = costMicrocents(model, usage.inputTokens, usage.outputTokens, provider);

    // Release the reservation FIRST and hold its promise. Everything after this
    // line — receipt signing included — is then structurally unable to prevent
    // it. Built inline in the tasks array instead, a throw while assembling the
    // writeLog argument would destroy the array before reconcileBudget was ever
    // called, leaking the reservation until its marker expires 960s later and
    // silently shrinking the agent's budget in the meantime.
    const budget = reconcileBudget({
      agentId,
      reserveId,
      estimate,
      estimateMicrocents,
      actualTokens: usage.inputTokens + usage.outputTokens,
      actualMicrocents: cost,
    });

    // Signed here, inside waitUntil, so the hot path pays nothing for it.
    // signReceipt never throws — it returns null on any failure, including an
    // unconfigured deployment.
    const receipt = safeReceipt({
      receiptId,
      passportId,
      agentId,
      visaJti: jti,
      provider,
      model,
      method: req.method,
      path: path.join("/"),
      rawBody: capturedBody,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costMicrocents: cost,
      status,
      httpStatus,
      startedAt: started,
      latencyMs: Date.now() - started,
      owner: await currentOwner(),
    });

    const tasks: Promise<unknown>[] = [
      budget,
      writeLog({
        id: receiptId,
        receipt,
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

  // ── 6. Resolve provider key (encrypted cache, else Vault RPC) ────────────────
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
    waitUntil(reconcile({ inputTokens: 0, outputTokens: 0 }, "upstream_error", 409));
    return errR(409, "no_provider_key");
  }

  // ── 7. Inject + forward ──────────────────────────────────────────────────────
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
    waitUntil(reconcile({ inputTokens: 0, outputTokens: 0 }, "upstream_error", 502));
    return errR(502, "upstream_unreachable");
  }

  const contentType = upstream.headers.get("content-type") ?? "";
  const isStream = contentType.includes("text/event-stream");

  // Surface upstream errors verbatim (never leak the key); reconcile by releasing.
  if (!upstream.ok) {
    waitUntil(reconcile({ inputTokens: 0, outputTokens: 0 }, "upstream_error", upstream.status));
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type": contentType || "application/json",
        "x-passcontrol-receipt-id": receiptId,
      },
    });
  }

  // ── 8/9. Stream tee + reconcile, OR buffered JSON path ───────────────────────
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
        // The id, not the receipt: on a stream the response headers are already
        // committed before usage resolves, so a usage-bound proof cannot ride
        // here. Same shape on the buffered path so callers have one rule.
        "x-passcontrol-receipt-id": receiptId,
      },
    });
  }

  // Non-streaming JSON: read, tally, forward.
  const json = await upstream.json().catch(() => ({}));
  const usage = usageFromJson(provider, json);
  waitUntil(reconcile(usage, "ok"));
  return new Response(JSON.stringify(json), {
    status: 200,
    headers: { "content-type": "application/json", "x-passcontrol-receipt-id": receiptId },
  });
}

// ── Keyless demo provider ─────────────────────────────────────────────────────
// A no-key, no-cost provider for the local "try it" experience and for CI. It is
// enabled ONLY when PASSCONTROL_DEMO=1 — production is unaffected. A demo call
// goes through the entire real governance pipeline (identical primitives: verify
// visa, kill switch, per-model scope, atomic budget reserve). The single thing it
// does NOT do is resolve/inject a real provider key or forward upstream — that
// step is replaced with a locally synthesized response, clearly marked `[demo]`.
// So everything that makes PassControl PassControl is real; only the downstream
// model is faked, and the Vault is never touched.
function demoEnabled(): boolean {
  return process.env.PASSCONTROL_DEMO === "1";
}

// Synthetic per-token price so budget/spend demos show real (small) numbers.
const DEMO_MICROCENTS_PER_TOKEN = 1;

function lastUserMessage(body: any): string {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      return m.content
        .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
        .join(" ")
        .trim();
    }
  }
  return "";
}

function demoText(body: any): string {
  const echo = lastUserMessage(body).slice(0, 500);
  return (
    "[demo] PassControl governed this call — visa verified, scope and budget " +
    "enforced, kill switch live. The real provider key never left the vault. " +
    (echo ? `You said: ${echo}` : "Add a real provider key to make this a live model call.")
  );
}

async function handleDemo(req: Request, path: string[], started: number): Promise<Response> {
  // 1. Verify visa — the same Ed25519/HS256 crypto as the real path.
  const visaToken = extractVisaToken(req.headers);
  if (!visaToken) return err(401, "missing_visa");
  const claims = await verifyVisa(visaToken);
  if (!claims) return err(401, "invalid_visa");

  const agentId = claims.agid;
  const userId: string = claims.uid;
  const passportId = claims.sub;
  const jti = claims.jti;
  const reserveId = crypto.randomUUID();
  // The demo signs receipts on the same terms as the real path. The synthesized
  // reply is the ONLY fake thing here: which agent called, which gate answered,
  // what it cost and when are all real, and those are the only things a receipt
  // ever claims. Withholding one would make the demo misrepresent the product in
  // the one direction that matters — it is the only surface reachable without a
  // key, so for most people it is the only receipt they will ever see.
  const receiptId = crypto.randomUUID();
  const capTokens: number | null = claims.bt ?? null;
  const capMicrocents: number | null =
    claims.bc == null ? null : Math.round(Number(claims.bc) * MICROCENTS_PER_CENT);
  const spentSnapshot: number = Number(claims.st ?? 0);
  const spentMicrocentsSnapshot: number = Number(claims.sc ?? 0);

  // Created up here rather than at the policy step below, because the owner read
  // needs it and the first receipt can be written before policy is ever reached.
  // serviceClient() builds a client object; it opens nothing.
  const db = serviceClient();

  // Same contract as the real path: the header names a decision that WAS
  // recorded, so it only rides on responses that write a row. See the comment on
  // `errR` in handle().
  const errR = (status: number, code: string) =>
    new Response(JSON.stringify({ error: code }), {
      status,
      headers: { "content-type": "application/json", "x-passcontrol-receipt-id": receiptId },
    });

  // The revocation gate runs before the body is read; a receipt written there
  // omits the digest rather than reporting one over "".
  let capturedBody: string | null = null;

  let ownerRead: Promise<OwnerClaim | null> | null = null;
  const currentOwner = () => (ownerRead ??= readCurrentOwner(db, userId).catch(() => null));

  // Wrapped for the same reason as in handle(): this call sits inside the
  // argument list of writeLog, and a throw there destroys the surrounding tasks
  // array before the budget reconcile is ever awaited.
  const safeReceipt = (input: Parameters<typeof signReceipt>[0]): string | null => {
    try {
      return signReceipt(input);
    } catch {
      return null;
    }
  };

  const logBlocked = (
    status: Parameters<typeof writeLog>[0]["status"],
    model?: string,
    httpStatus = 403
  ) =>
    waitUntil(
      (async () =>
        writeLog({
          id: receiptId,
          receipt: safeReceipt({
            receiptId,
            passportId,
            agentId,
            visaJti: jti,
            provider: "demo",
            model,
            method: req.method,
            path: path.join("/"),
            rawBody: capturedBody,
            inputTokens: 0,
            outputTokens: 0,
            costMicrocents: 0,
            status,
            httpStatus,
            startedAt: started,
            latencyMs: Date.now() - started,
            owner: await currentOwner(),
          }),
          agentId,
          userId,
          passportId,
          jti,
          provider: "demo",
          model,
          status,
          latencyMs: Date.now() - started,
        }))()
    );

  const capturePolicyBlocked = (reason: string, status: number, rule: string) =>
    waitUntil(
      captureSecurityEvent(`proxy.blocked_policy_${reason}`, {
        route: "api.proxy",
        method: req.method,
        status,
        provider: "demo",
        agentId,
        jti,
        code: `blocked_policy_${reason}`,
        controlScope: rule,
      })
    );

  // 2. Per-agent request-rate limit.
  const rl = await rateLimit(`proxy:${agentId}`, PROXY_RATE_LIMIT, PROXY_RATE_WINDOW_S);
  if (!rl.success) {
    return new Response(JSON.stringify({ error: "rate_limited" }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": String(PROXY_RATE_WINDOW_S) },
    });
  }

  // 3. Kill switch (platform + tenant + denylist; per-agent suspend).
  const [kill, suspended] = await Promise.all([readKillState(userId), isSuspended(agentId)]);
  const revocationGate = evaluateGate({
    agentId,
    killState: kill,
    suspended,
    provider: "demo",
    method: req.method,
    path,
    model: "",
  });
  if (revocationGate.deniedBy === "kill" || revocationGate.deniedBy === "suspend") {
    const blocked = revocationGate.deniedBy === "kill" ? "blocked_killed" : "blocked_suspended";
    // Attribute in the log; keep the wire response opaque (see the other handler).
    logBlocked(blocked);
    return errR(403, "blocked_suspended");
  }

  // Parse body (model + stream).
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return err(413, "payload_too_large");
  }
  let bodyObj: any = {};
  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY_BYTES) return err(413, "payload_too_large");
  // Digest the bytes the client actually sent. From here on a receipt can bind
  // the request; before it, `capturedBody` stays null and the digest is omitted.
  capturedBody = rawBody;
  if (rawBody) {
    try {
      bodyObj = JSON.parse(rawBody);
    } catch {
      return err(400, "invalid_body");
    }
  }
  const model: string = typeof bodyObj?.model === "string" && bodyObj.model ? bodyObj.model : "demo-1";
  const wantsStream = bodyObj?.stream === true;

  // 4. Scope (per-model) + endpoint allowlist.
  const gateBase: GateBaseInput = {
    agentId,
    killState: kill,
    suspended,
    scopes: claims.scope,
    provider: "demo",
    method: req.method,
    path,
    model,
    now: new Date(),
  };
  const prePolicyGate = evaluateGate(gateBase);
  if (prePolicyGate.deniedBy === "scope") {
    logBlocked("blocked_scope", model);
    return errR(403, "blocked_scope");
  }
  if (prePolicyGate.deniedBy === "endpoint") {
    logBlocked("blocked_endpoint", model);
    return errR(403, "blocked_endpoint");
  }

  // 5. Current policy — real, because the demo promises the governance path.
  const currentPolicyGate = await evaluateCurrentPolicyGate(db, userId, agentId, gateBase);
  if (currentPolicyGate.gate.deniedBy === "policy") {
    const policy = policyBlockDetails(currentPolicyGate.gate);
    logBlocked(BLOCKED_POLICY_STATUS, model, policy.status);
    capturePolicyBlocked(policy.reason, policy.status, policy.rule);
    return errR(policy.status, "blocked_policy");
  }

  // 6. Budget reserve (atomic) — real, so the budget/kill demos are honest.
  const estimatedUsage = estimateTokenUsage(bodyObj);
  const estimate = estimatedUsage.totalTokens;
  const estimateMicrocents = estimate * DEMO_MICROCENTS_PER_TOKEN;
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
  const finalGate = evaluateGate({
    ...gateBase,
    policy: currentPolicyGate.policy,
    policyFailClosed: process.env.POLICY_FAIL_CLOSED === "true",
    ...(currentPolicyGate.policyRateLimit
      ? { policyRateLimit: currentPolicyGate.policyRateLimit }
      : {}),
    budget: {
      ok: reserve.ok,
      reason: reserve.reason,
      estimateTokens: estimate,
      estimateMicrocents,
      reservedTokens: reserve.reserved,
      reservedMicrocents: reserve.reservedMicrocents,
      source: "atomic_reserve",
    },
  });
  if (finalGate.deniedBy === "budget") {
    logBlocked("blocked_budget", model, 402);
    return errR(402, "blocked_budget");
  }

  // 7. Synthesize the response in place of Vault-key resolution + upstream forward.
  const text = demoText(bodyObj);
  const outputTokens = Math.max(1, Math.ceil(text.length / 4));
  const usage = { inputTokens: estimatedUsage.inputTokens, outputTokens };
  const totalTokens = usage.inputTokens + usage.outputTokens;
  const cost = totalTokens * DEMO_MICROCENTS_PER_TOKEN;

  waitUntil(
    (async () => {
      // Release the reservation FIRST and hold its promise — the same ordering
      // rule as reconcile() on the real path. Built inline in the array below,
      // a throw while assembling the writeLog argument would destroy the array
      // before reconcileBudget was ever called, leaking the reservation until
      // its marker expires ~960s later and quietly shrinking the agent's budget.
      const budget = reconcileBudget({
        agentId,
        reserveId,
        estimate,
        estimateMicrocents,
        actualTokens: totalTokens,
        actualMicrocents: cost,
      });

      const receipt = safeReceipt({
        receiptId,
        passportId,
        agentId,
        visaJti: jti,
        provider: "demo",
        model,
        method: req.method,
        path: path.join("/"),
        rawBody: capturedBody,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costMicrocents: cost,
        status: "ok",
        httpStatus: 200,
        startedAt: started,
        latencyMs: Date.now() - started,
        owner: await currentOwner(),
      });

      return Promise.all([
        budget,
        writeLog({
          id: receiptId,
          receipt,
          agentId,
          userId,
          passportId,
          jti,
          provider: "demo",
          model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          costMicrocents: cost,
          status: "ok",
          latencyMs: Date.now() - started,
        }),
        mirrorSpend(agentId, totalTokens, cost),
      ]);
    })()
  );

  const id = `demo-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  if (wantsStream) {
    const chunk = (delta: object, finish: string | null) =>
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
    const sse = chunk({ role: "assistant", content: text }, null) + chunk({}, "stop") + "data: [DONE]\n\n";
    return new Response(sse, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "x-passcontrol-receipt-id": receiptId,
      },
    });
  }

  return new Response(
    JSON.stringify({
      id,
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: usage.inputTokens,
        completion_tokens: usage.outputTokens,
        total_tokens: totalTokens,
      },
    }),
    {
      status: 200,
      headers: { "content-type": "application/json", "x-passcontrol-receipt-id": receiptId },
    }
  );
}
