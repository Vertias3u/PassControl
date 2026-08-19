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
import {
  authenticateDirectAgentKey,
  classifyGatewayCredential,
  type DirectKeyPrincipal,
} from "@/lib/auth/direct-key";
import { readKillState } from "@/lib/state/killswitch";
import {
  isSuspended,
  reserveBudget,
  reconcileBudget,
  getCachedKey,
  setCachedKey,
  seedSpent,
} from "@/lib/state/redis";
import { readCurrentAgentPolicyAndShadow } from "@/lib/state/policy";
import { seal, open } from "@/lib/crypto/aesgcm";
import { serviceClient } from "@/lib/supabase";
import { canonicalEndpointPath, isModelListingIndex } from "@/lib/scope";
import { filterModelListingToScope } from "@/lib/providers/model-listing";
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
import { shadowRevision, stampShadowVerdict } from "@/lib/policy-shadow";
import { signReceipt, type OwnerClaim } from "@/lib/receipt";
import { readCurrentOwner } from "@/lib/owner/current";
import { isProvider, upstreamBaseUrl, authHeaders, usesOpenAiUsageShape, type ProviderId } from "@/lib/providers";
import { classifyUpstreamFailure, isClassifiableStatus } from "@/lib/providers/exhaustion";
import { buildAlternatives } from "@/lib/providers/alternatives";
import { readProvidersWithKeys } from "@/lib/providers/available";
import {
  MAX_FALLBACKS,
  failoverReasonFor,
  type FailoverReason,
  type FallbackEntry,
} from "@/lib/providers/fallbacks";
import { readCurrentAgentFallbacks } from "@/lib/state/fallbacks";
import { rateLimit, rateLimitFailClosed } from "@/lib/ratelimit";
import { consumeCloudBetaQuota } from "@/lib/cloud-beta-quota";
import { captureError, captureSecurityEvent, logFailOpen } from "@/lib/observability";

// Per-agent request-rate cap (independent of the token budget): bounds raw call
// volume so a runaway/abusive agent can't flood the gateway or upstream. Generous
// for normal fleets; tune via env. Returns 429 + Retry-After when exceeded.
const PROXY_RATE_LIMIT = Number(process.env.PROXY_RATE_LIMIT ?? "600");
const PROXY_RATE_WINDOW_S = Number(process.env.PROXY_RATE_WINDOW_S ?? "60");
// This fires BEFORE a random pc_agent_ credential can cost a Supabase lookup.
// Unlike the passport challenge limiter, Redis failure closes this edge: its
// purpose is protecting the shared database from unauthenticated work.
const DIRECT_KEY_IP_LIMIT = Number(process.env.DIRECT_KEY_IP_LIMIT ?? "60");
const DIRECT_KEY_IP_WINDOW_S = Number(process.env.DIRECT_KEY_IP_WINDOW_S ?? "60");

const KEY_CACHE_TTL_S = 60;
const POLICY_RATE_WINDOW_S = 60 * 60;
const RESERVE_MARKER_TTL_S = 960; // > max visa TTL (900s) + buffer
// Generous cap for an LLM request body (large prompts are legitimate) while still
// bounding memory/CPU against an oversized payload DoS.
const MAX_BODY_BYTES = 4 * 1024 * 1024;
// A provider error body is a few hundred bytes. A provider that DECLARES a larger
// one is not sending something the exhaustion classifier could match, so it
// streams through unread. This bounds the declared case only — see the gate at
// the !upstream.ok branch for why an undeclared length is still inspected.
const MAX_ERROR_BODY_BYTES = 64 * 1024;
// The primary plus every configured fallback. Enforced in the loop independently
// of the list's own length cap, so one client request can never fan out across
// providers even if a longer list reaches the column some other way.
const MAX_ATTEMPTS = 1 + MAX_FALLBACKS;

function err(status: number, code: string) {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function quotaUnavailable(
  req: Request,
  provider: string,
  agentId: string,
  jti: string,
  route = "api.proxy"
) {
  waitUntil(
    captureSecurityEvent("proxy.cloud_beta_quota_unavailable", {
      route,
      method: req.method,
      status: 503,
      provider,
      agentId,
      jti,
      code: "quota_unavailable",
    })
  );
  return err(503, "quota_unavailable");
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

type PassportPrincipal = {
  kind: "passport";
  agentId: string;
  userId: string;
  scopes: VisaScope[];
  budgetTokens: number | null;
  budgetCents: number | null;
  spentTokens: number;
  spentMicrocents: number;
  passportId: string;
  visaJti: string;
};

type GatewayPrincipal = PassportPrincipal | DirectKeyPrincipal;
type VisaScope = { provider: string; models: string[] };

type GatewayAuthentication =
  | { ok: true; principal: GatewayPrincipal; db: ServiceDatabase }
  | { ok: false; response: Response };

function clientIp(req: Request): string {
  // Cloudflare overwrites this header at its edge, but other hosts may pass a
  // client-supplied value through. Trust it only in the Workers deployment,
  // whose committed configuration explicitly opts in.
  const cloudflareIp = process.env.PASSCONTROL_TRUST_CF_CONNECTING_IP === "true"
    ? req.headers.get("cf-connecting-ip")?.trim()
    : undefined;
  return (
    cloudflareIp ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip")?.trim() ||
    "unknown"
  );
}

/** Authenticate either door without letting one format fall through to the other. */
async function authenticateGatewayRequest(
  req: Request,
  provider: string
): Promise<GatewayAuthentication> {
  // extractVisaToken is intentionally still the one header-precedence source:
  // Authorization Bearer wins over x-api-key, including when they carry
  // different credential classes.
  const token = extractVisaToken(req.headers);
  const credential = classifyGatewayCredential(token);
  if (credential.kind === "missing") return { ok: false, response: err(401, "missing_visa") };
  if (credential.kind === "invalid") {
    return { ok: false, response: err(401, "invalid_credential") };
  }

  const db = serviceClient();
  if (credential.kind === "direct_key") {
    const limited = await rateLimitFailClosed(
      `direct-key-ip:${clientIp(req)}`,
      DIRECT_KEY_IP_LIMIT,
      DIRECT_KEY_IP_WINDOW_S
    );
    if (!limited.success) {
      const code = limited.unreadable
        ? "authentication_rate_limit_unavailable"
        : "rate_limited";
      waitUntil(
        captureSecurityEvent("proxy.direct_key_pre_auth_limited", {
          route: "api.proxy",
          method: req.method,
          status: limited.unreadable ? 503 : 429,
          provider,
          code,
        })
      );
      return {
        ok: false,
        response: new Response(JSON.stringify({ error: code }), {
          status: limited.unreadable ? 503 : 429,
          headers: {
            "content-type": "application/json",
            ...(limited.unreadable
              ? {}
              : { "retry-after": String(DIRECT_KEY_IP_WINDOW_S) }),
          },
        }),
      };
    }

    try {
      const principal = await authenticateDirectAgentKey(db, credential.token);
      if (!principal) {
        waitUntil(
          captureSecurityEvent("proxy.invalid_direct_key", {
            route: "api.proxy",
            method: req.method,
            status: 401,
            provider,
            code: "invalid_credential",
          })
        );
        return { ok: false, response: err(401, "invalid_credential") };
      }
      return { ok: true, principal, db };
    } catch {
      waitUntil(
        captureError(new Error("direct key authentication unavailable"), {
          route: "api.proxy",
          method: req.method,
          status: 503,
          provider,
          code: "authentication_unavailable",
        })
      );
      return { ok: false, response: err(503, "authentication_unavailable") };
    }
  }

  const claims = await verifyVisa(credential.token);
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
    return { ok: false, response: err(401, "invalid_visa") };
  }
  return {
    ok: true,
    db,
    principal: {
      kind: "passport",
      agentId: claims.agid,
      userId: claims.uid,
      scopes: claims.scope,
      budgetTokens: claims.bt ?? null,
      budgetCents: claims.bc ?? null,
      spentTokens: Number(claims.st ?? 0),
      spentMicrocents: Number(claims.sc ?? 0),
      passportId: claims.sub,
      visaJti: claims.jti,
    },
  };
}

/**
 * What the LIVE policy's hourly counter was asked, and what it answered.
 *
 * `cap` is the limit the reading was taken FOR. Without it a `{success:true}`
 * is just a boolean with no question attached, and handing it to a candidate
 * that caps something else asserts an answer nobody computed.
 */
interface HourlyObservation {
  cap: number | null;
  reading?: GateRateLimitInput;
}

/**
 * What the shadow policy WOULD have decided for this call.
 *
 * Four rules, and every one of them is the difference between a diagnostic and
 * a liability:
 *
 *  1. It is the SAME evaluateGate, called a second time with the candidate
 *     value. Not a reimplementation — a second implementation could disagree
 *     with enforcement, and a shadow verdict that does not predict the real one
 *     is worse than no shadow verdict, because an operator would promote on it.
 *
 *  2. It does NOT take the rate limit again. `rateLimit()` mutates a counter, so
 *     a shadow evaluation that charged it would make observing the system change
 *     it — the operator's hourly cap would be consumed twice as fast for having
 *     switched shadow mode on. The reading the live gate already took is passed
 *     straight through.
 *
 *  3. It only uses that reading when it answers the CANDIDATE's question. The
 *     reading is a boolean decided against the live cap: `{success:true}` at a
 *     cap of 10 says nothing about a draft that caps at 1, and a draft that caps
 *     anything while the live policy caps nothing has no reading in existence at
 *     all — the counter was never touched. In both cases there is no observation
 *     to report, so this returns null and the attempt is recorded with NO
 *     verdict. "No measurement" is the true answer; "allow" is a confident false
 *     one, on precisely the rule the operator is trialling. Predicting a
 *     different cap would need a second, real counter, and creating one would
 *     break rule 2.
 *
 *  4. It cannot throw. This runs on the path that resolves a provider
 *     credential; diagnostics that can 500 a proxied call are strictly worse
 *     than no diagnostics.
 *
 * Returns null when the shadow policy decided nothing worth recording — which
 * includes the case where an earlier gate (kill, suspend, scope, endpoint)
 * denied. Those inputs are identical in both runs, so the shadow policy was
 * never reached and recording its "deny" would attribute someone else's refusal
 * to a rule being trialled.
 */
function shadowVerdict(
  shadow: unknown,
  base: GateBaseInput,
  hourly: HourlyObservation
): string | null {
  try {
    if (shadow === null || shadow === undefined) return null;
    const policy: GatePolicyInput = { kind: "value", value: shadow };
    const policyFailClosed = process.env.POLICY_FAIL_CLOSED === "true";

    // First pass with no reading, exactly as the live evaluation begins. It
    // answers two questions at once: whether a rule (deny, window, malformed)
    // decides before the counter is ever consulted, and — if not — which cap the
    // candidate would need a reading for.
    const first = evaluateGate({ ...base, policy, policyFailClosed });
    const needs = first.policyRateLimitRequired;
    if (needs === null) {
      if (first.deniedBy === "policy") return "deny:policy";
      return first.verdict === "allow" ? "allow" : null;
    }
    if (hourly.reading === undefined || hourly.cap !== needs) return null;

    const second = evaluateGate({ ...base, policy, policyFailClosed, policyRateLimit: hourly.reading });
    if (second.deniedBy === "policy") return "deny:policy";
    return second.verdict === "allow" ? "allow" : null;
  } catch {
    // Never observable to the caller, by construction.
    return null;
  }
}

async function evaluateCurrentPolicyGate(
  db: ServiceDatabase,
  userId: string,
  agentId: string,
  base: GateBaseInput
): Promise<{
  gate: ReturnType<typeof evaluateGate>;
  policy: GatePolicyInput;
  policyRateLimit?: GateRateLimitInput;
  /** The candidate document itself, so each fallback can be judged by it too. */
  shadow: unknown;
  /** Which candidate it is. Stamped onto every verdict; see lib/policy-shadow.ts. */
  shadowRev: string | null;
  /** The live counter question and its answer, for shadowVerdict's rule 3. */
  hourly: HourlyObservation;
  shadowWould?: string;
}> {
  const { policy: currentPolicy, shadow } = await readCurrentAgentPolicyAndShadow(
    db,
    userId,
    agentId
  );
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
  // The cap the LIVE policy required, which is the question the counter was
  // asked. Carried alongside the answer so a candidate with a different cap
  // cannot be judged by it.
  const liveCap = gate.policyRateLimitRequired;
  if (!gate.deniedBy && liveCap !== null) {
    policyRateLimit = await rateLimit(
      `policy-hour:${userId}:${agentId}`,
      liveCap,
      POLICY_RATE_WINDOW_S
    );
    gate = evaluateGate({
      ...base,
      policy,
      policyFailClosed: process.env.POLICY_FAIL_CLOSED === "true",
      policyRateLimit,
    });
  }

  const hourly: HourlyObservation = {
    cap: liveCap,
    ...(policyRateLimit ? { reading: policyRateLimit } : {}),
  };
  const shadowRev = shadowRevision(shadow);
  // After the live gate is final, so it can be handed the reading that gate
  // actually used rather than taking one of its own.
  const would = shadowVerdict(shadow, base, hourly);
  const shadowWould = would === null ? undefined : stampShadowVerdict(would, shadowRev);

  return {
    gate,
    policy,
    ...(policyRateLimit ? { policyRateLimit } : {}),
    shadow,
    shadowRev,
    hourly,
    ...(shadowWould ? { shadowWould } : {}),
  };
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

  // ── 1. Authenticate passport visa or Direct Agent Key ─────────────────────
  const authentication = await authenticateGatewayRequest(req, provider);
  if (!authentication.ok) return authentication.response;
  const { principal, db } = authentication;
  const agentId = principal.agentId;
  const userId = principal.userId;
  const scopes = principal.scopes;
  // Observability already calls this field `jti`; for a direct call it carries
  // the per-call credential-use id, never a fabricated visa id.
  const credentialUseId = crypto.randomUUID();
  const jti = principal.kind === "passport" ? principal.visaJti : credentialUseId;
  const receiptIdentity =
    principal.kind === "passport"
      ? ({ passportId: principal.passportId, visaJti: principal.visaJti } as const)
      : ({
          authMethod: "direct_key",
          agentAccessKeyId: principal.keyId,
          credentialUseId,
        } as const);
  const logIdentity =
    principal.kind === "passport"
      ? ({ passportId: principal.passportId, jti: principal.visaJti } as const)
      : ({
          authMethod: "direct_key",
          agentAccessKeyId: principal.keyId,
          credentialUseId,
        } as const);
  const reserveId = crypto.randomUUID();
  // Named here so the id can travel in a response header before the log row —
  // and the signed receipt inside it — exists. The proof is built and signed
  // later, in waitUntil; the hot path costs one uuid and one header.
  const receiptId = crypto.randomUUID();
  const capTokens: number | null = principal.budgetTokens;
  const capMicrocents: number | null =
    principal.budgetCents == null
      ? null
      : Math.round(Number(principal.budgetCents) * MICROCENTS_PER_CENT);
  const spentSnapshot: number = principal.spentTokens;
  const spentMicrocentsSnapshot: number = principal.spentMicrocents;

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

  // Set once the policy gate has run, and read by the log helpers below —
  // which are defined first, so this is a `let` rather than a parameter on every
  // one of them. Stays undefined when the agent has no shadow policy, and the
  // key is then omitted from the insert entirely (see lib/log.ts).
  let shadowWould: string | undefined;

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
            ...receiptIdentity,
            agentId,
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
          ...logIdentity,
          provider,
          model,
          status,
          latencyMs: Date.now() - started,
          ...(shadowWould ? { policyShadowWould: shadowWould } : {}),
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

  // Temporary Cloud launch guard, deliberately outside RESERVE_LUA. Count only
  // after the cheap per-agent limiter and emergency controls pass, so a killed,
  // suspended, or already-rate-limited agent cannot exhaust the shared beta.
  const betaQuota = await consumeCloudBetaQuota(userId);
  if (!betaQuota.ok) {
    if (betaQuota.reason === "unavailable") {
      return quotaUnavailable(req, provider, agentId, jti);
    }
    return err(429, "beta_quota_exceeded");
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
    scopes,
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
  shadowWould = currentPolicyGate.shadowWould;
  if (currentPolicyGate.gate.deniedBy === "policy") {
    const policy = policyBlockDetails(currentPolicyGate.gate);
    logBlocked(BLOCKED_POLICY_STATUS, model, policy.status);
    captureBlocked(`blocked_policy_${policy.reason}`, policy.status, policy.rule);
    return errR(policy.status, "blocked_policy");
  }

  // ── 5–9, once per attempt ───────────────────────────────────────────────────
  //
  // Failover turns what was a straight line into a loop, so everything that
  // varies per attempt lives inside runAttempt. The list is exact, and every
  // item on it is a way to get this wrong: the reservation and its id, the
  // receipt id, the provider, the model, the cost estimate, the forwarded body,
  // the upstream path and the provider key. Anything left outside settles, bills
  // or signs for the wrong attempt.
  //
  // The checks above (visa, rate limit, kill, scope, endpoint, policy) ran for
  // the PRIMARY. A fallback is re-checked separately in `qualifies` below, and a
  // fallback that fails one of those is not an error to report — it is simply a
  // fallback that does not qualify. That is what leaves every existing
  // early-refusal path above exactly as it was.
  const estimatedUsage = estimateTokenUsage(bodyObj);
  const estimate = estimatedUsage.totalTokens;
  // NX, and the snapshot does not change between attempts, so this stays outside
  // the loop.
  if (capTokens != null || capMicrocents != null) {
    await seedSpent(agentId, spentSnapshot, spentMicrocentsSnapshot);
  }

  interface Settlement {
    /** The budget release alone. The loop AWAITS this before the next reserve. */
    released: Promise<unknown>;
    /** Release + audit row + spend mirror. Handed to waitUntil. */
    done: Promise<unknown>;
  }
  interface AttemptTarget {
    provider: ProviderId;
    model: string;
    upstreamPath: readonly string[];
    receiptId: string;
    prev: string | null;
    why: FailoverReason | null;
    /**
     * What the shadow policy would have decided about THIS provider and model.
     * Per target, not per call: the live policy is re-evaluated for every
     * fallback, and a shadow verdict that did not follow it would report an
     * Anthropic attempt as one a draft allows when the draft denies Anthropic
     * by name. Undefined means no verdict was recorded for this attempt.
     */
    shadowWould?: string;
  }
  type AttemptOutcome =
    | { kind: "response"; response: Response }
    /** This fallback does not qualify, or could not run. Its reserve is already released. */
    | { kind: "skipped" }
    | {
        kind: "retryable";
        why: FailoverReason;
        receiptId: string;
        response: Response;
        settle: Settlement;
      };

  const runAttempt = async (
    target: AttemptTarget,
    { primary }: { primary: boolean }
  ): Promise<AttemptOutcome> => {
    const attemptProvider = target.provider;
    const attemptModel = target.model;
    const attemptReceiptId = target.receiptId;
    const reserveId = crypto.randomUUID();

    // S5: ensure OpenAI-compatible streams report usage. Re-derived per attempt —
    // the flag is provider-shaped and the model in the body changes. A copy, not
    // a mutation of bodyObj, so one attempt cannot contaminate the next. The
    // model key is only set when the client sent one, so a model-listing GET
    // keeps the body it had.
    const attemptBody: Record<string, unknown> = model
      ? { ...bodyObj, model: attemptModel }
      : { ...bodyObj };
    if (usesOpenAiUsageShape(attemptProvider) && wantsStream) {
      attemptBody.stream_options = {
        ...((bodyObj.stream_options as Record<string, unknown> | undefined) ?? {}),
        include_usage: true,
      };
    }
    const forwardBody = JSON.stringify(attemptBody);

    const estimateMicrocents = costMicrocents(
      attemptModel,
      estimatedUsage.inputTokens,
      estimatedUsage.outputTokens,
      attemptProvider
    );

    // ── 5. Budget reserve (atomic) ─────────────────────────────────────────────
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
      provider: attemptProvider,
      model: attemptModel,
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
      // A failed reserve rolls both dimensions back inside the Lua script, so
      // there is nothing held to release here.
      if (!primary) return { kind: "skipped" };
      logBlocked("blocked_budget", attemptModel, 402);
      captureBlocked("blocked_budget", 402);
      return { kind: "response", response: errR(402, "blocked_budget") };
    }

    // From here a reservation is held; it MUST be reconciled on every exit path.
    const reconcile = (
      usage: Usage,
      status: Parameters<typeof writeLog>[0]["status"],
      httpStatus = 200
    ): Settlement => {
      const cost = costMicrocents(
        attemptModel,
        usage.inputTokens,
        usage.outputTokens,
        attemptProvider
      );

      // Release the reservation FIRST and hold its promise. Everything after this
      // line — receipt signing included — is then structurally unable to prevent
      // it. Built inline in the tasks array instead, a throw while assembling the
      // writeLog argument would destroy the array before reconcileBudget was ever
      // called, leaking the reservation until its marker expires 960s later and
      // silently shrinking the agent's budget in the meantime.
      const released = reconcileBudget({
        agentId,
        reserveId,
        estimate,
        estimateMicrocents,
        actualTokens: usage.inputTokens + usage.outputTokens,
        actualMicrocents: cost,
      });

      const done = (async () => {
        // Signed here, inside waitUntil, so the hot path pays nothing for it.
        // signReceipt never throws — it returns null on any failure, including an
        // unconfigured deployment.
        const receipt = safeReceipt({
          receiptId: attemptReceiptId,
          ...receiptIdentity,
          agentId,
          provider: attemptProvider,
          model: attemptModel,
          method: req.method,
          path: path.join("/"),
          // The CLIENT's bytes, identical across attempts. That is exactly why a
          // shared req.dig is not a link between two receipts and `prev` is.
          rawBody: capturedBody,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          costMicrocents: cost,
          status,
          httpStatus,
          startedAt: started,
          latencyMs: Date.now() - started,
          owner: await currentOwner(),
          previousReceiptId: target.prev,
          failoverReason: target.why,
        });

        const tasks: Promise<unknown>[] = [
          released,
          writeLog({
            id: attemptReceiptId,
            receipt,
            agentId,
            userId,
            ...logIdentity,
            provider: attemptProvider,
            model: attemptModel,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            costMicrocents: cost,
            status,
            latencyMs: Date.now() - started,
            // The TARGET's verdict, not the request's. See AttemptTarget.
            ...(target.shadowWould ? { policyShadowWould: target.shadowWould } : {}),
          }),
        ];
        if (status === "ok") {
          tasks.push(mirrorSpend(agentId, usage.inputTokens + usage.outputTokens, cost));
        }
        return Promise.all(tasks);
      })();

      return { released, done };
    };

    const terminal = (response: Response, settle: Settlement): AttemptOutcome => {
      waitUntil(settle.done);
      return { kind: "response", response };
    };

    // ── 6. Resolve provider key (encrypted cache, else Vault RPC) ──────────────
    let providerKey: string | null = null;
    const cached = await getCachedKey(agentId, attemptProvider);
    if (cached) providerKey = await open(cached);
    if (!providerKey) {
      const { data: keyData } = await db.rpc("get_provider_key", {
        p_agent_id: agentId,
        p_provider: attemptProvider,
      });
      providerKey = typeof keyData === "string" ? keyData : null;
      if (providerKey) {
        // store ciphertext only
        waitUntil(
          seal(providerKey).then((s) => setCachedKey(agentId, attemptProvider, s, KEY_CACHE_TTL_S))
        );
      }
    }
    if (!providerKey) {
      // No usage; release the reservation by reconciling with the estimate as spend
      // would over-count, so release exactly the reserve and log zero usage.
      const settle = reconcile({ inputTokens: 0, outputTokens: 0 }, "no_provider_key", 409);
      // A fallback with no stored key is a fallback that cannot run. Release what
      // it took and move on rather than answering the client with its problem.
      if (!primary) {
        await settle.released;
        waitUntil(settle.done);
        return { kind: "skipped" };
      }
      return terminal(errR(409, "no_provider_key"), settle);
    }

    // ── 7. Inject + forward ────────────────────────────────────────────────────
    const targetUrl = `${upstreamBaseUrl(attemptProvider)}/${target.upstreamPath.join("/")}${new URL(req.url).search}`;
    const fwdHeaders = new Headers();
    fwdHeaders.set("content-type", "application/json");
    // Forward only a sanitized Accept (strip CR/LF/control chars to prevent header
    // injection, and bound the length). Everything else we set ourselves.
    const accept = req.headers.get("accept");
    if (accept) {
      const safeAccept = accept.replace(/[\r\n\x00-\x1f]/g, "").slice(0, 256);
      if (safeAccept) fwdHeaders.set("accept", safeAccept);
    }
    for (const [h, v] of Object.entries(authHeaders(attemptProvider, providerKey))) {
      fwdHeaders.set(h, v);
    }

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
          provider: attemptProvider,
          agentId,
          jti,
          code: "upstream_unreachable",
        })
      );
      const settle = reconcile({ inputTokens: 0, outputTokens: 0 }, "upstream_error", 502);
      return {
        kind: "retryable",
        // Cannot distinguish "never sent" from "sent, no answer came back", so
        // the next provider may be the second one to bill this request.
        why: "unreachable",
        receiptId: attemptReceiptId,
        response: errR(502, "upstream_unreachable"),
        settle,
      };
    }

    const contentType = upstream.headers.get("content-type") ?? "";
    const isStream = contentType.includes("text/event-stream");

    // Surface upstream errors verbatim (never leak the key); reconcile by releasing.
    //
    // One exception: a provider that answers "this account is out of credit" is
    // telling the agent something it can act on, and PassControl already knows
    // which OTHER providers that agent is scoped for and holds keys to. That case
    // gets a structured 402 naming them instead of an opaque provider error.
    //
    // Everything else must come through byte-for-byte as before, so the body is
    // read ONLY when this provider has a rule for this exact status and the body
    // is JSON. Reading turns a streamed response into a buffered one — on a
    // chunked or event-stream error body that changes what the client receives —
    // so the untouched path is left structurally untouched rather than merely
    // asserted-unchanged in a test with a simple mock body.
    if (!upstream.ok) {
      // The size gate only bites when the provider DECLARES a length. A chunked
      // JSON error carries no content-length and is still inspected: buffering it
      // is no worse than the success path below, which already calls
      // upstream.json() unbounded against the same six allowlisted hosts. A
      // malformed header is not a number and falls to pass-through — the safe
      // direction, chosen here rather than inherited from a NaN comparison.
      const declared = upstream.headers.get("content-length");
      const declaredLength = declared === null ? null : Number(declared);
      const withinSizeGate =
        declaredLength === null ||
        (Number.isFinite(declaredLength) && declaredLength <= MAX_ERROR_BODY_BYTES);
      // A 5xx is retryable without reading anything, so the body is read only
      // when the classifier could actually distinguish something — keeping the
      // streamed pass-through for every case that does not need inspecting.
      const inspectable =
        isClassifiableStatus(attemptProvider, upstream.status) &&
        contentType.includes("application/json") &&
        withinSizeGate;

      // Null only if the stream broke mid-read, in which case there is nothing
      // left to forward either way — the body cannot be re-streamed once consumed.
      const errorBody = inspectable ? await upstream.text().catch(() => null) : null;
      const why = failoverReasonFor(attemptProvider, upstream.status, errorBody ?? "");

      const passthrough = () =>
        new Response(inspectable ? errorBody : upstream.body, {
          status: upstream.status,
          headers: {
            "content-type": contentType || "application/json",
            "x-passcontrol-receipt-id": attemptReceiptId,
          },
        });

      // Not in the retry allowlist — a 400/401/403/404 says something about the
      // request or the key, not about the provider's availability, and a second
      // provider would get the same broken call.
      if (!why) {
        return terminal(
          passthrough(),
          reconcile({ inputTokens: 0, outputTokens: 0 }, "upstream_error", upstream.status)
        );
      }

      if (why === "credit_exhausted") {
        const settle = reconcile({ inputTokens: 0, outputTokens: 0 }, "provider_exhausted", 402);
        // Redis-cached and only reached on a call that has already failed, so it
        // costs an approved call nothing. Degrades to an empty list rather than
        // failing the response — see lib/providers/available.ts.
        const alternatives = buildAlternatives({
          scopes,
          providersWithKeys: await readProvidersWithKeys(db, userId),
          failing: attemptProvider,
          method: req.method,
          path,
        });
        // Distinct from `blocked_budget`, which is also a 402 but means
        // PassControl's own budget refused the call before it left the building.
        // An agent must be able to tell "my operator capped me" from "the
        // provider's account is dry". This is the answer when no fallback runs.
        const response = new Response(
          JSON.stringify({
            error: "provider_credit_exhausted",
            provider: attemptProvider,
            alternatives,
          }),
          {
            status: 402,
            headers: {
              "content-type": "application/json",
              "x-passcontrol-receipt-id": attemptReceiptId,
            },
          }
        );
        return { kind: "retryable", why, receiptId: attemptReceiptId, response, settle };
      }

      return {
        kind: "retryable",
        why,
        receiptId: attemptReceiptId,
        response: passthrough(),
        settle: reconcile({ inputTokens: 0, outputTokens: 0 }, "upstream_error", upstream.status),
      };
    }

    // ── 8/9. Stream tee + reconcile, OR buffered JSON path ─────────────────────
    //
    // Both are terminal. Once the provider has started answering there is nothing
    // left to fail over from — the failover trigger is a response, before the
    // first byte of a body reaches the client.
    if (isStream && upstream.body) {
      const { stream, usage } = createUsageTransform(attemptProvider);
      // The monitored transform resolves usage exactly once on normal close or client cancel.
      waitUntil(usage.then((u) => reconcile(u, "ok").done));
      return {
        kind: "response",
        response: new Response(upstream.body.pipeThrough(stream), {
          status: 200,
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
            // The id, not the receipt: on a stream the response headers are already
            // committed before usage resolves, so a usage-bound proof cannot ride
            // here. Same shape on the buffered path so callers have one rule.
            "x-passcontrol-receipt-id": attemptReceiptId,
          },
        }),
      };
    }

    // Non-streaming JSON: read, tally, forward.
    const json = await upstream.json().catch(() => ({}));
    const usage = usageFromJson(attemptProvider, json);
    // Discovery is bounded by the visa. `GET /v1/models` otherwise answers with
    // every model the PROVIDER KEY can reach — the tenant's whole account —
    // rather than the models THIS agent may call, so an SDK's model picker
    // offered choices guaranteed to 403 on first use. A narrowing of the
    // provider's own rows only: nothing is added and nothing is synthesised, and
    // an unrecognised body passes through untouched (see lib/providers/
    // model-listing.ts). Not applied to the single-model retrieve, which names a
    // model the caller already knows.
    const forwarded =
      req.method === "GET" && isModelListingIndex(path)
        ? filterModelListingToScope(json, attemptProvider, scopes)
        : json;
    return terminal(
      new Response(JSON.stringify(forwarded), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-passcontrol-receipt-id": attemptReceiptId,
        },
      }),
      reconcile(usage, "ok")
    );
  };

  // Whether a configured fallback may be used for THIS call, and — when it may —
  // what the shadow policy would have decided about it. A fallback can never
  // grant capability: it is re-checked against the same gate the primary passed,
  // and the candidate is re-checked on exactly the same inputs so its verdict
  // describes the attempt that actually happens.
  const qualifies = async (
    fallback: FallbackEntry
  ): Promise<{ verdict: "ok" | "skip" | "stop"; shadowWould?: string }> => {
    // Trust boundary #3 — revocation is instant. Failover puts a whole extra
    // upstream round-trip between the kill read at the top of this request and
    // the next call going out, so an operator who arms the switch mid-failover
    // must not have it go out. One Redis round-trip, on a call that has already
    // failed.
    const [freshKill, freshSuspended] = await Promise.all([
      readKillState(userId),
      isSuspended(agentId),
    ]);
    const revocation = evaluateGate({
      agentId,
      killState: freshKill,
      suspended: freshSuspended,
      provider: fallback.provider,
      method: req.method,
      path,
      model: "",
    });
    if (revocation.deniedBy === "kill" || revocation.deniedBy === "suspend") {
      return { verdict: "stop" };
    }

    // Built once and used for BOTH evaluations, so the candidate is judged on
    // the same kill state, the same scope and the same clock as enforcement.
    const fallbackBase: GateBaseInput = {
      agentId,
      killState: freshKill,
      suspended: freshSuspended,
      scopes,
      provider: fallback.provider,
      method: req.method,
      path,
      model: fallback.model,
      now: new Date(),
    };
    const gate = evaluateGate({
      ...fallbackBase,
      policy: currentPolicyGate.policy,
      policyFailClosed: process.env.POLICY_FAIL_CLOSED === "true",
      // Attempt 1's reading, threaded rather than taken again. rateLimit()
      // MUTATES, so re-running evaluateCurrentPolicyGate here would charge the
      // operator's max_requests_per_hour twice for one client request — silently
      // halving an allowance they wrote about the agent's behaviour, not about
      // the gateway's internal retries.
      ...(currentPolicyGate.policyRateLimit
        ? { policyRateLimit: currentPolicyGate.policyRateLimit }
        : {}),
    });
    // Covers scope, endpoint and policy in one evaluation. A deny rule names a
    // provider AND models, so this is what stops a fallback from silently
    // bypassing a rule the operator wrote.
    if (gate.deniedBy) return { verdict: "skip" };

    // Same threaded observation, for the same reason: measuring must not charge
    // the counter. shadowVerdict declines to answer rather than reusing a
    // reading taken for a different cap.
    const would = shadowVerdict(currentPolicyGate.shadow, fallbackBase, currentPolicyGate.hourly);
    return {
      verdict: "ok",
      ...(would === null
        ? {}
        : { shadowWould: stampShadowVerdict(would, currentPolicyGate.shadowRev) }),
    };
  };

  // ── The attempt loop ────────────────────────────────────────────────────────
  const primaryOutcome = await runAttempt(
    {
      provider,
      model,
      upstreamPath,
      receiptId,
      prev: null,
      why: null,
      ...(shadowWould ? { shadowWould } : {}),
    },
    { primary: true }
  );
  if (primaryOutcome.kind !== "retryable") {
    // `skipped` is only ever returned for a non-primary attempt.
    return (primaryOutcome as { kind: "response"; response: Response }).response;
  }

  let held = primaryOutcome;
  let heldSettled = false;
  // Settles the attempt whose response we are currently holding. Called before
  // the next reserve, never after — reconcileBudget DECRBYs `reserved` while the
  // reserve script INCRBYs it and compares the total against the cap, so a
  // deferred release lets the next attempt see a doubled reservation and get
  // refused for money it is not spending.
  const settleHeld = async () => {
    if (heldSettled) return;
    heldSettled = true;
    await held.settle.released;
    waitUntil(held.settle.done);
  };

  const fallbacks = await readCurrentAgentFallbacks(db, userId, agentId);
  let attemptsUsed = 1;
  for (const fallback of fallbacks) {
    if (attemptsUsed >= MAX_ATTEMPTS) break;
    const qualified = await qualifies(fallback);
    if (qualified.verdict === "stop") break;
    if (qualified.verdict === "skip") continue;

    const fallbackPath = canonicalEndpointPath(fallback.provider, req.method, path);
    if (!fallbackPath) continue;

    await settleHeld();
    attemptsUsed += 1;
    const next = await runAttempt(
      {
        provider: fallback.provider,
        model: fallback.model,
        upstreamPath: fallbackPath,
        receiptId: crypto.randomUUID(),
        prev: held.receiptId,
        why: held.why,
        ...(qualified.shadowWould ? { shadowWould: qualified.shadowWould } : {}),
      },
      { primary: false }
    );
    if (next.kind === "skipped") continue;
    if (next.kind === "response") return next.response;
    held = next;
    heldSettled = false;
  }

  await settleHeld();
  return held.response;
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
  // 1. Authenticate through the same two doors as the real provider path.
  const authentication = await authenticateGatewayRequest(req, "demo");
  if (!authentication.ok) return authentication.response;
  const { principal, db } = authentication;
  const agentId = principal.agentId;
  const userId = principal.userId;
  const scopes = principal.scopes;
  const credentialUseId = crypto.randomUUID();
  const jti = principal.kind === "passport" ? principal.visaJti : credentialUseId;
  const receiptIdentity =
    principal.kind === "passport"
      ? ({ passportId: principal.passportId, visaJti: principal.visaJti } as const)
      : ({
          authMethod: "direct_key",
          agentAccessKeyId: principal.keyId,
          credentialUseId,
        } as const);
  const logIdentity =
    principal.kind === "passport"
      ? ({ passportId: principal.passportId, jti: principal.visaJti } as const)
      : ({
          authMethod: "direct_key",
          agentAccessKeyId: principal.keyId,
          credentialUseId,
        } as const);
  const reserveId = crypto.randomUUID();
  // The demo signs receipts on the same terms as the real path. The synthesized
  // reply is the ONLY fake thing here: which agent called, which gate answered,
  // what it cost and when are all real, and those are the only things a receipt
  // ever claims. Withholding one would make the demo misrepresent the product in
  // the one direction that matters — it is the only surface reachable without a
  // key, so for most people it is the only receipt they will ever see.
  const receiptId = crypto.randomUUID();
  const capTokens: number | null = principal.budgetTokens;
  const capMicrocents: number | null =
    principal.budgetCents == null
      ? null
      : Math.round(Number(principal.budgetCents) * MICROCENTS_PER_CENT);
  const spentSnapshot: number = principal.spentTokens;
  const spentMicrocentsSnapshot: number = principal.spentMicrocents;

  // Created up here rather than at the policy step below, because the owner read
  // needs it and the first receipt can be written before policy is ever reached.
  // serviceClient() builds a client object; it opens nothing.
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

  // Set once the policy gate has run, and read by the log helpers below —
  // which are defined first, so this is a `let` rather than a parameter on every
  // one of them. Stays undefined when the agent has no shadow policy, and the
  // key is then omitted from the insert entirely (see lib/log.ts).
  let shadowWould: string | undefined;

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
            ...receiptIdentity,
            agentId,
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
          ...logIdentity,
          provider: "demo",
          model,
          status,
          latencyMs: Date.now() - started,
          ...(shadowWould ? { policyShadowWould: shadowWould } : {}),
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

  // Match the real provider path: emergency controls and the per-agent limiter
  // protect the shared beta ceiling rather than consuming it.
  const betaQuota = await consumeCloudBetaQuota(userId);
  if (!betaQuota.ok) {
    if (betaQuota.reason === "unavailable") {
      return quotaUnavailable(req, "demo", agentId, jti, "api.proxy.demo");
    }
    return err(429, "beta_quota_exceeded");
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
    scopes,
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
  shadowWould = currentPolicyGate.shadowWould;
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
        ...receiptIdentity,
        agentId,
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
          ...logIdentity,
          provider: "demo",
          model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          costMicrocents: cost,
          status: "ok",
          latencyMs: Date.now() - started,
          ...(shadowWould ? { policyShadowWould: shadowWould } : {}),
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
