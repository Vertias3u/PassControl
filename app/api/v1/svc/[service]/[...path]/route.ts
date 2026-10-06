// Any-API — a governed call to a non-LLM API (GitHub REST; writes since phase 2).
//
// /api/v1/svc/:service/*   (Authorization: Bearer <visa> | x-api-key: <Direct Agent Key>)
//
// The same doors and the same order as the LLM route, reusing its code rather
// than copying it (lib/gateway/*):
//   1 authenticate + sender proof   2 kill switch / suspend   3 per-agent rate limit
//   4 catalog refusal (incl. the never list)   5 service rules (live, fail CLOSED)
//   6 per-service hourly cap   6b a write's body, read only now, bounded
//   6c "Ask me first": the owner's approval of exactly this request, when the
//      matched rule asks for it (lib/approvals/gate.ts), before any decrypt
//   7 resolve the tenant's token (the one decrypt path)   8 inject + forward
//   9 redact + audit row + signed receipt
//
// What is deliberately NOT here, each decided in plans/any-api-credentials.md §10:
//  - no budget hold: a service call spends nothing the dollar cap governs, so it
//    sits outside that cap and says so (`unp` on the receipt, `unpriced` on the
//    row). Its budget unit is calls: step 6.
//  - no LLM policy: `deny` rules, windows and the policy hourly counter are
//    model-shaped. The service rules ARE this call's scope.
//  - no fallbacks, no failover, no key cache: one attempt, one decrypt, one send.
//    Without a cache there is no invalidation to get wrong — a token replaced or
//    removed in Settings is what the very next call uses.
//
// Query-string limit (the `nxtP` trap in CLAUDE.md): Next deletes a client's
// own `?path=` and `?service=` before this handler runs, so those two GitHub
// query parameters (e.g. the commits endpoint's `path` filter) cannot pass
// through this route. Every other parameter does.
export const runtime = "edge";

import { waitUntil } from "@vercel/functions";
import {
  authenticateGatewayRequest,
  enforceSenderConstraint,
  principalSuspended,
  type PassportAuthMethod,
} from "@/lib/gateway/authenticate";
import { err, errMessage } from "@/lib/gateway/responses";
import { PROXY_RATE_LIMIT, PROXY_RATE_WINDOW_S } from "@/lib/gateway/limits";
import { readKillState } from "@/lib/state/killswitch";
import { isSuspended } from "@/lib/state/redis";
import { readCurrentAgentPolicyAndShadow } from "@/lib/state/policy";
import { evaluateGate } from "@/lib/gate";
import { rateLimit, rateLimitFailClosed } from "@/lib/ratelimit";
import { writeLog } from "@/lib/log";
import { signReceipt, type OwnerClaim } from "@/lib/receipt";
import { readCurrentOwner } from "@/lib/owner/current";
import { captureSecurityEvent } from "@/lib/observability";
import { forwardableUpstreamSearch } from "@/lib/providers/endpoint";
import { readBoundedBody } from "@/lib/http/bounded-body";
import { approvalFingerprint, approvalPreview } from "@/lib/approvals/fingerprint";
import { approvalWaitMs, awaitApproval } from "@/lib/approvals/gate";
import { APPROVAL_PREVIEW_MAX } from "@/lib/state/approvals";
import { redactSecretsInText, redactingStream, secretsToRedact } from "@/lib/providers/secret-redaction";
import type { SenderProofObservation } from "@/lib/sender-constraint";
import { SERVICE_CATALOG, isServiceId, serviceRefusal } from "@/lib/services/catalog";
import { SERVICE_DISPLAY } from "@/lib/services/display";
import { parseServicePath } from "@/lib/services/path";
import {
  matchServiceRule,
  parseServiceRules,
  serviceCallAsks,
  serviceRulesRevision,
  type ServiceRule,
} from "@/lib/services/rules";
import {
  filterRequestHeaders,
  filterResponseHeaders,
  rewriteLinkHeader,
  rewriteLocationHeader,
} from "@/lib/services/wire";

interface Ctx {
  params: Promise<{ service: string; path: string[] }>;
}

/** The per-service cap's window. Rules state their cap per hour. */
const SERVICE_CAP_WINDOW_S = 60 * 60;
/** A read from GitHub is quick; a hung socket must not hold an edge worker. */
const UPSTREAM_TIMEOUT_MS = 30_000;
/** Statuses that carry no body, and must be answered without one. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

type LogStatus = Parameters<typeof writeLog>[0]["status"];

// Every method is exported, not only the ones phase 1 admits. A write from a
// read-only agent (or a method no rule names) is exactly what an operator wants to see: it is refused by the
// rules, logged and receipted, rather than disappearing into Next's bare 405.
const handler = async (req: Request, ctx: Ctx) => handle(req, (await ctx.params).service);
export const GET = handler;
export const HEAD = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;

async function handle(req: Request, serviceRaw: string): Promise<Response> {
  const started = Date.now();

  // Refused before authentication, like an unknown provider: nothing about the
  // caller is needed to know this gateway serves no such service.
  if (!isServiceId(serviceRaw)) return err(404, "unknown_service");
  const service = serviceRaw;
  const entry = SERVICE_CATALOG[service];
  const provider = entry.credentialProvider;

  // From the PATHNAME, not Next's params: Next decodes `%2F` inside a param, so
  // `acme%2Fweb` arrives there as one segment `acme/web` (probed on a production
  // build, 2026-09-29). The pathname keeps the escape, and parseServicePath
  // refuses it. What is matched below is exactly what is sent.
  const requestUrl = new URL(req.url);
  const parsedPath = parseServicePath(requestUrl.pathname, service);
  if (!parsedPath.ok) return err(400, "invalid_path");
  const { segments, upstreamPath } = parsedPath;
  const method = req.method.toUpperCase();

  // ── 1. Authenticate: the same two doors as every LLM call ──────────────────
  // `token` too: Octokit's `auth` option and `gh` send the credential that way.
  const authentication = await authenticateGatewayRequest(req, provider, "api.svc", { tokenScheme: true });
  if (!authentication.ok) return authentication.response;
  const { principal, db, credentialToken } = authentication;
  const agentId = principal.agentId;
  const userId = principal.userId;
  const credentialUseId = crypto.randomUUID();
  const jti = principal.kind === "passport" ? principal.visaJti : credentialUseId;
  const receiptId = crypto.randomUUID();

  // A proof is authentication, so it is checked before anything spends the
  // agent's allowance. The policy read is taken ONLY for the sender-constraint
  // mode: nothing else in it decides a service call.
  let passportAuthMethod: PassportAuthMethod = "passport";
  let senderProofWould: SenderProofObservation | undefined;
  if (principal.kind === "passport") {
    const snapshot = await readCurrentAgentPolicyAndShadow(db, userId, agentId);
    const senderConstraint = await enforceSenderConstraint(req, credentialToken, principal, snapshot);
    if (!senderConstraint.ok) return senderConstraint.response;
    passportAuthMethod = senderConstraint.authMethod;
    senderProofWould = senderConstraint.would;
  }

  const receiptIdentity =
    principal.kind === "passport"
      ? ({
          authMethod: passportAuthMethod,
          passportId: principal.passportId,
          visaJti: principal.visaJti,
        } as const)
      : ({
          authMethod: "direct_key",
          agentAccessKeyId: principal.keyId,
          credentialUseId,
        } as const);
  const logIdentity =
    principal.kind === "passport"
      ? ({
          authMethod: passportAuthMethod,
          passportId: principal.passportId,
          jti: principal.visaJti,
        } as const)
      : ({
          authMethod: "direct_key",
          agentAccessKeyId: principal.keyId,
          credentialUseId,
        } as const);

  // Set as the call is decided, read by `record`.
  let policyRevision: string | undefined;
  let matched: ServiceRule | null = null;
  // A write's body, exactly as the agent sent it, once read (step 6b). Bound
  // into the receipt by digest; never logged.
  let capturedBody: string | null = null;

  let ownerRead: Promise<OwnerClaim | null> | null = null;
  const currentOwner = () => (ownerRead ??= readCurrentOwner(db, userId).catch(() => null));

  const safeReceipt = (input: Parameters<typeof signReceipt>[0]): string | null => {
    try {
      return signReceipt(input);
    } catch {
      return null;
    }
  };

  /**
   * The audit row and its receipt, for every decision the gateway made about
   * this call. `dispatched` marks a call that went (or may have gone) to the
   * service: only those are unpriced — a refused call had nothing to price.
   */
  const record = (status: LogStatus, httpStatus: number, dispatched = false) =>
    waitUntil(
      (async () =>
        writeLog({
          id: receiptId,
          receipt: safeReceipt({
            receiptId,
            ...receiptIdentity,
            agentId,
            provider,
            method,
            // The raw path, signed (T10): receipts are handed only to the tenant.
            path: upstreamPath.slice(1),
            // A read has no body. A write's is bound by digest, so the receipt
            // proves what was written without the log holding it.
            rawBody: capturedBody,
            inputTokens: 0,
            outputTokens: 0,
            costMicrocents: 0,
            ...(dispatched ? { unpriced: true } : {}),
            callClass: "svc",
            status,
            httpStatus,
            startedAt: started,
            latencyMs: Date.now() - started,
            ...(policyRevision ? { policyRevision } : {}),
            owner: await currentOwner(),
          }),
          agentId,
          userId,
          ...logIdentity,
          provider,
          status,
          latencyMs: Date.now() - started,
          callKind: "service",
          // The rule that admitted the call: METHOD plus its path template, or
          // CALL plus the method name for a service whose rules name methods.
          ...(matched ? { endpoint: `${matched.method === "CALL" ? "CALL" : method} ${matched.path}` } : {}),
          ...(dispatched ? { costMicrocents: null, unpriced: true } : {}),
          ...(senderProofWould ? { senderProofWould } : {}),
        }))()
    );

  const captureBlocked = (code: string, status: number) =>
    waitUntil(
      captureSecurityEvent(`svc.${code}`, {
        route: "api.svc",
        method,
        status,
        provider,
        agentId,
        jti,
        code,
      })
    );

  // A governed refusal names its receipt, exactly as the LLM route's does.
  const governed = (response: Response) => {
    response.headers.set("x-passcontrol-receipt-id", receiptId);
    return response;
  };

  // ── 2. Kill switch and suspension: the same evaluation as an LLM call ──────
  // The tenant's per-service kill rides in the same read ("stop all GitHub, keep
  // Claude"), so it shares the kill switch's fail posture exactly.
  const [kill, redisSuspended] = await Promise.all([
    readKillState(userId, { service }),
    isSuspended(agentId),
  ]);
  const revocation = evaluateGate({
    agentId,
    killState: kill,
    suspended: redisSuspended || principalSuspended(principal),
    provider,
    method,
    path: segments,
    model: "",
  });
  if (revocation.deniedBy === "kill" || revocation.deniedBy === "suspend" || kill.serviceKill === true) {
    // A per-service stop is a kill: `blocked_killed`, the status the tenant's
    // master kill records, with the same opaque body on the wire.
    const blocked =
      revocation.deniedBy === "suspend" && kill.serviceKill !== true ? "blocked_suspended" : "blocked_killed";
    record(blocked, 403);
    captureBlocked(blocked, 403);
    return governed(err(403, "blocked_suspended"));
  }

  // ── 3. The agent's gateway-wide request limit, shared with its LLM calls ───
  const rl = await rateLimit(`proxy:${agentId}`, PROXY_RATE_LIMIT, PROXY_RATE_WINDOW_S);
  if (!rl.success) {
    captureBlocked("rate_limited", 429);
    return new Response(JSON.stringify({ error: "rate_limited" }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": String(PROXY_RATE_WINDOW_S) },
    });
  }

  // ── 4. Endpoints the catalog refuses whatever the rules say (T3) ───────────
  const refusal = serviceRefusal(entry, method, segments);
  if (refusal) {
    record("blocked_endpoint", 403);
    captureBlocked("service_endpoint_refused", 403);
    return governed(errMessage(403, "service_endpoint_refused", refusal));
  }

  // ── 5. The agent's rules for this service: live, and FAIL CLOSED (T11) ─────
  //
  // Not the policy read's fallback ladder: every rung of that leans toward
  // "keep what shipped before", which for a destination rule set means "call
  // anything the tenant's token can reach". An answer we cannot read refuses,
  // whatever POLICY_FAIL_CLOSED says.
  let rawRules: unknown;
  // For the owner's approval prompt (6c): the name they gave the agent.
  let agentName = "an agent";
  try {
    const { data, error } = await db
      .from("agents")
      .select("service_rules, name")
      .eq("id", agentId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw error;
    // No row is an answer, not a failure: an agent that does not exist has no
    // rules, and is refused below like any agent without them.
    rawRules = (data as { service_rules?: unknown } | null)?.service_rules ?? null;
    const name = (data as { name?: unknown } | null)?.name;
    if (typeof name === "string" && name) agentName = name;
  } catch {
    record("blocked_scope", 503);
    captureBlocked("service_rules_unavailable", 503);
    return governed(err(503, "service_rules_unavailable"));
  }

  const read = parseServiceRules(rawRules, service);
  if (read.kind === "malformed") {
    record("blocked_scope", 403);
    captureBlocked("service_rules_invalid", 403);
    return governed(
      errMessage(
        403,
        "service_rules_invalid",
        `This agent's ${entry.label} rules are not valid, so every ${entry.label} call is refused until they are fixed.`
      )
    );
  }
  const rules = read.kind === "rules" ? read.rules : null;
  policyRevision = serviceRulesRevision(service, rules);
  matched = rules ? matchServiceRule(rules, method, segments) : null;
  if (!rules || !matched) {
    record("blocked_scope", 403);
    captureBlocked("service_call_not_allowed", 403);
    return governed(
      errMessage(
        403,
        "service_call_not_allowed",
        // Ends with where the owner grants it, because a new owner who stored a
        // token did not know each agent needs rules too (2026-10-05). The link
        // is this deployment's own dashboard and this agent's own panel.
        `${
          entry.ruleShape === "call"
            ? `This agent may not call ${segments.join("/")} on ${entry.label}. ${entry.label} access is granted per agent, one method name at a time.`
            : `This agent may not call ${method} /${segments.join("/")} on ${entry.label}. ${entry.label} access is granted per agent, by method and path.`
        } The owner can grant it at ${requestUrl.origin}/dashboard/agents/${encodeURIComponent(agentId)}#${SERVICE_DISPLAY[service].sectionId}`
      )
    );
  }

  // ── 6. The per-service hourly cap: fail CLOSED, it has no second backstop ──
  const cap = await rateLimitFailClosed(
    `svc-cap:${agentId}:${service}`,
    rules.maxRequestsPerHour,
    SERVICE_CAP_WINDOW_S
  );
  if (!cap.success) {
    if (cap.unreadable) {
      record("blocked_policy", 503);
      captureBlocked("service_rate_limit_unavailable", 503);
      return governed(err(503, "service_rate_limit_unavailable"));
    }
    record("blocked_policy", 429);
    captureBlocked("service_rate_limited", 429);
    const limited = errMessage(
      429,
      "service_rate_limited",
      `This agent has made its ${rules.maxRequestsPerHour} ${entry.label} calls for this hour.`
    );
    limited.headers.set("retry-after", String(SERVICE_CAP_WINDOW_S));
    return governed(limited);
  }

  // ── 6b. A write's body: read only now, once the call is admitted ───────────
  // A refused write never has its bytes read. The bound is applied while the
  // bytes arrive (readBoundedBody), not after draining an unknown-length upload.
  const isWrite = method !== "GET" && method !== "HEAD";
  if (isWrite) {
    const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
    if (contentType && !entry.bodyTypes.some((type) => contentType.includes(type))) {
      record("blocked_endpoint", 415);
      return governed(err(415, "unsupported_media_type"));
    }
    const bounded = await readBoundedBody(req, entry.maxBodyBytes);
    if (!bounded.ok) {
      record("blocked_endpoint", 413);
      return governed(err(413, "payload_too_large"));
    }
    capturedBody = bounded.text;
  }

  // What will be forwarded, settled before the approval step so that an
  // approval names exactly it: the client's query MINUS this route's own
  // params, which Next re-appends to req.url as ordinary parameters (see
  // forwardableUpstreamSearch), and only the headers this service is sent.
  let search: string;
  try {
    search = forwardableUpstreamSearch(req.url, ["service", "path"]);
  } catch {
    record("blocked_endpoint", 400);
    return governed(err(400, "invalid_query"));
  }
  const headers = filterRequestHeaders(entry, req.headers);

  // ── 6c. "Ask me first": the owner's yes to exactly this request ────────────
  // Before the decrypt: a call nobody approved never has the token in memory.
  // Each pending retry has already counted against the hourly cap (step 6).
  // Any admitting rule that asks holds the call, not only the first match.
  if (serviceCallAsks(rules, method, segments)) {
    const forwardedBody = isWrite ? (capturedBody ?? "") : null;
    const preview = approvalPreview(forwardedBody, search);
    // The owner approves what they can read, so a request too large to show
    // in full is not asked about at all: approving the start of a body would
    // admit whatever follows it.
    if (preview.length > APPROVAL_PREVIEW_MAX) {
      record("blocked_policy", 413);
      captureBlocked("approval_body_too_large", 413);
      return governed(
        errMessage(
          413,
          "approval_body_too_large",
          `This ${entry.label} call needs the owner's approval, and is too large for them to read in full (over ${APPROVAL_PREVIEW_MAX / 1024} KB of query and body). Send a smaller request.`
        )
      );
    }
    const fingerprint = await approvalFingerprint({
      userId,
      agentId,
      service,
      method,
      upstreamPath,
      search,
      headers,
      body: forwardedBody,
    });
    const approval = await awaitApproval({
      request: { userId, agentId, service, method, path: upstreamPath, preview, fingerprint },
      prompt: {
        agentName,
        serviceLabel: entry.label,
        method,
        path: upstreamPath,
        preview,
        dashboardUrl: `${requestUrl.origin}/dashboard/approvals`,
      },
      waitMs: approvalWaitMs(),
    });
    if (approval.state !== "approved") {
      // Its own security-event codes, and never the workspace's "refused"
      // alert: the owner was just asked, and a second ping says nothing new.
      captureBlocked(`approval_${approval.state}`, 403);
      if (approval.state === "unavailable") {
        record("blocked_policy", 503);
        return governed(
          errMessage(503, "approval_unavailable", "This call needs the owner's approval, which could not be checked. Try again shortly.")
        );
      }
      if (approval.state === "full") {
        record("blocked_policy", 429);
        const full = errMessage(
          429,
          "approval_queue_full",
          "This workspace already has too many requests waiting for the owner's approval. Try again after they answer."
        );
        full.headers.set("retry-after", "60");
        return governed(full);
      }
      if (approval.state === "denied") {
        record("blocked_policy", 403);
        return governed(
          errMessage(403, "approval_denied", `The owner denied this ${entry.label} request. Do not send it again unchanged.`)
        );
      }
      record("blocked_policy", 409);
      const held = errMessage(
        409,
        "approval_pending",
        `This ${entry.label} call needs the owner's approval, and they have been asked. Send the same request again in a little while: once they approve, it goes through once. An approval lasts 10 minutes; an unanswered request expires after 15.`
      );
      held.headers.set("retry-after", "15");
      return governed(held);
    }
  }

  // ── 7. The tenant's token: get_provider_key, the only decrypt path ─────────
  let token: string | null;
  try {
    const { data, error } = await db.rpc("get_provider_key", {
      p_agent_id: agentId,
      p_provider: provider,
    });
    if (error) throw error;
    token = typeof data === "string" && data ? data : null;
  } catch {
    // Not "no token": a read that failed says nothing about what is stored, and
    // telling an operator to add a token that is already there sends them the
    // wrong way. The service never saw this call.
    record("endpoint_unavailable", 503);
    return governed(err(503, "credential_unavailable"));
  }
  if (!token) {
    record("no_provider_key", 409);
    return governed(
      errMessage(
        409,
        "no_service_credential",
        `No ${entry.label} token is stored for this workspace. Add one in Settings, under Services.`
      )
    );
  }


  // ── 8. Inject + forward ────────────────────────────────────────────────────
  // Built by the catalog: for Telegram the token is IN this URL, so the URL is
  // a secret from here on — it is never logged, captured or returned. A stored
  // token that cannot be put into a URL safely refuses the call.
  const targetUrl = entry.upstreamUrl(token, upstreamPath, search);
  if (!targetUrl) {
    record("no_provider_key", 409);
    return governed(
      errMessage(
        409,
        "service_credential_invalid",
        `The stored ${entry.label} token is not in the shape ${entry.label} issues, so it was not used. Replace it in Settings, under Services.`
      )
    );
  }
  for (const [name, value] of Object.entries(entry.authHeaders(token))) headers.set(name, value);

  const secrets = secretsToRedact(token);
  let reflectionReported = false;
  const reportReflection = () => {
    if (reflectionReported) return;
    reflectionReported = true;
    waitUntil(
      captureSecurityEvent("svc.service_token_reflected", {
        route: "api.svc",
        method,
        provider,
        agentId,
        jti,
        code: "service_token_reflected",
      })
    );
  };
  const redactHeader = (value: string) => {
    const out = redactSecretsInText(value, secrets);
    if (out.redacted) reportReflection();
    return out.text;
  };

  let upstream: Response;
  try {
    upstream = await fetch(targetUrl, {
      method,
      headers,
      // Exactly the bytes the receipt binds. An empty write body is sent as
      // empty (a zero Content-Length, which some GitHub PUTs require).
      ...(isWrite ? { body: capturedBody ?? "" } : {}),
      // Never followed: a redirect is handed to the agent (T6), so the token
      // goes to the catalog origin and nowhere else.
      redirect: "manual",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    // May or may not have reached the service; recorded as dispatched.
    record("upstream_error", 502, true);
    return governed(err(502, "upstream_unreachable"));
  }

  // ── 9. Answer: allowlisted headers, rewritten URLs, redacted body ──────────
  const out = filterResponseHeaders(entry, upstream.headers);
  // Only where the service's URLs carry no credential. Telegram's would carry
  // the bot token, so for it both headers are dropped, not rewritten.
  if (entry.rewritesUrls) {
    const gatewayBase = `${requestUrl.origin}/api/v1/svc/${service}`;
    const link = upstream.headers.get("link");
    if (link) {
      const rewritten = rewriteLinkHeader(link, gatewayBase, upstreamPath, entry.origin);
      if (rewritten) out.set("link", redactHeader(rewritten));
    }
    const location = upstream.headers.get("location");
    if (location) {
      const rewritten = rewriteLocationHeader(location, gatewayBase, entry.origin);
      if (rewritten) out.set("location", redactHeader(rewritten));
    }
  }
  out.set("x-passcontrol-receipt-id", receiptId);

  const body =
    method === "HEAD" || NULL_BODY_STATUSES.has(upstream.status) || !upstream.body
      ? null
      : secrets.length
        ? upstream.body.pipeThrough(redactingStream(secrets, reportReflection))
        : upstream.body;

  record(upstream.status < 400 ? "ok" : "upstream_error", upstream.status, true);
  return new Response(body, { status: upstream.status, headers: out });
}
