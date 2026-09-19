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
import {
  verifyVisa,
  verifySenderProof,
  extractVisaToken,
  SENDER_PROOF_HEADER,
  SENDER_PROOF_WINDOW_SECONDS,
} from "@/lib/auth/visa";
import {
  authenticateDirectAgentKey,
  classifyGatewayCredential,
  type DirectKeyPrincipal,
} from "@/lib/auth/direct-key";
import { readKillState } from "@/lib/state/killswitch";
import {
  isSuspended,
  getCachedEndpoint,
  getCachedKey,
  readCredentialFence,
  setCachedEndpoint,
  setCachedKey,
  touchLastSeen,
  claimNonce,
  purgeAgentPolicy,
} from "@/lib/state/redis";
import {
  openHold,
  settleKnown,
  settleUnknown,
  releaseUndispatched,
  consumeDispatchPermission,
  establishBudgetState,
  type SettleResult,
  type DispatchPermissionResult,
} from "@/lib/state/holds";
import { readCurrentAgentPolicyAndShadow } from "@/lib/state/policy";
import { seal, open } from "@/lib/crypto/aesgcm";
import { serviceClient } from "@/lib/supabase";
import {
  canonicalEndpointPath,
  isModelListingIndex,
  isOpenAiResponsesEndpoint,
} from "@/lib/scope";
import { filterModelListingToScope } from "@/lib/providers/model-listing";
import {
  POLICY_UNREADABLE,
  evaluateGate,
  type GateInput,
  type GatePolicyInput,
  type GateRateLimitInput,
} from "@/lib/gate";
import {
  costMicrocents,
  costMicrocentsForUsage,
  demoCostMicrocents,
  estimateTokenUsage,
  isPricedEndpoint,
  MICROCENTS_PER_CENT,
} from "@/lib/pricing";
import { createUsageTransform, usageFromJson, NO_USAGE, type Usage } from "@/lib/usage/parseStream";
import { writeLog, mirrorSpend, type AuthMethod } from "@/lib/log";
import { livePolicyRevision, shadowRevision, stampShadowVerdict } from "@/lib/policy-shadow";
import { signReceipt, type OwnerClaim } from "@/lib/receipt";
import { readCurrentOwner } from "@/lib/owner/current";
import { isProvider, upstreamBaseUrl, authHeaders, usesOpenAiUsageShape, type ProviderId } from "@/lib/providers";
import { classifyUpstreamFailure, isClassifiableStatus } from "@/lib/providers/exhaustion";
import { buildAlternatives } from "@/lib/providers/alternatives";
import { readProvidersWithKeys } from "@/lib/providers/available";
import {
  MAX_FALLBACKS,
  failoverReasonFor,
  mayHaveBeenBilled,
  type FailoverReason,
  type FallbackEntry,
} from "@/lib/providers/fallbacks";
import { readCurrentAgentFallbacks } from "@/lib/state/fallbacks";
import type { SenderProofObservation } from "@/lib/sender-constraint";
import {
  endpointPolicy,
  forwardableUpstreamSearch,
  isEndpointAllowed,
  joinUpstream,
  versionlessUpstreamPath,
} from "@/lib/providers/endpoint";
import { rateLimit, rateLimitFailClosed } from "@/lib/ratelimit";
import { readBoundedBody } from "@/lib/http/bounded-body";
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
// RESERVE_MARKER_TTL_S is deliberately GONE, not merely unused. It existed so a
// crashed reconcile would "self-heal" when its marker expired — and that
// mechanism was the bug: it released real money on a timer, for calls that had
// genuinely been billed. A hold now never expires while it is open. If you find
// yourself wanting a TTL back on the hot path, read lib/state/holds.ts first;
// tests/holds.redis.test.ts asserts `TTL == -1` on an open hold precisely so
// this cannot come back as hygiene.
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

function errMessage(status: number, code: string, message: string) {
  return new Response(JSON.stringify({ error: code, message }), {
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
  | { ok: true; principal: GatewayPrincipal; db: ServiceDatabase; credentialToken: string }
  | { ok: false; response: Response };

type PassportAuthMethod = Exclude<AuthMethod, "direct_key">;

type SenderConstraintResult =
  | { ok: true; authMethod: PassportAuthMethod; would?: SenderProofObservation }
  | { ok: false; response: Response };

/**
 * Evaluate the proof once, and let the caller decide what it costs.
 *
 * ── Why this is one function and not two ────────────────────────────────────
 *
 * `observe` only predicts `required` if it runs the identical check in the
 * identical order — the same verification, the same replay claim, the same key
 * and TTL. Two functions that happen to agree today are two functions that can
 * disagree after one edit, and then the mode an operator used to decide is not
 * the mode they switched on. The challenge route had exactly this shape: two
 * inline copies of one Ed25519 verification, folded into a single helper because
 * "two verifications of the same signature that can disagree" is the failure.
 *
 * So the verdict is computed here and nothing else. Whether a verdict blocks the
 * request is the caller's business, which is the only thing the two modes
 * actually differ on.
 *
 * `unavailable` is separate from every other verdict because it is not a
 * statement about the proof at all — the replay store could not answer. Under
 * enforcement that fails closed; under observation it is simply not recorded.
 */
type SenderProofEvaluation =
  | { verdict: SenderProofObservation }
  | { verdict: "unavailable" };

async function evaluateSenderProof(
  req: Request,
  credentialToken: string,
  principal: PassportPrincipal
): Promise<SenderProofEvaluation> {
  const proof = verifySenderProof({
    proof: req.headers.get(SENDER_PROOF_HEADER),
    method: req.method,
    url: req.url,
    visa: credentialToken,
    passportId: principal.passportId,
  });
  if (!proof.ok) {
    if (proof.reason === "missing") return { verdict: "missing" };
    if (proof.reason === "clock_skew") return { verdict: "clock_skew" };
    return { verdict: "invalid" };
  }

  try {
    // A future-dated proof accepted at one edge of the skew window remains
    // time-valid until the opposite edge, hence 2x window plus one second.
    const claimed = await claimNonce(
      `sender-proof:${proof.jti}`,
      SENDER_PROOF_WINDOW_SECONDS * 2 + 1
    );
    return { verdict: claimed ? "pass" : "replayed" };
  } catch {
    return { verdict: "unavailable" };
  }
}

async function enforceSenderConstraint(
  req: Request,
  credentialToken: string,
  principal: PassportPrincipal,
  policy: Awaited<ReturnType<typeof readCurrentAgentPolicyAndShadow>>
): Promise<SenderConstraintResult> {
  const mode = policy.senderConstraintMode;
  if (mode === null) {
    return { ok: false, response: err(503, "sender_constraint_state_unavailable") };
  }
  // Anything that is not one of the two proof modes takes the bearer path, and
  // the test is written that way round on purpose: drift resolves DOWN here, as
  // it does in toSenderConstraintMode. A value this build does not recognise
  // must not become enforcement, because enforcement refuses every call for an
  // agent whose operator configured something we have not shipped yet.
  if (mode !== "observe" && mode !== "required") {
    // An unsolicited proof is not inspected on this path. Recording the
    // configured mode (or mere header presence) as enforcement would turn a
    // receipt into a false assurance claim.
    return { ok: true, authMethod: "passport" };
  }

  const { verdict } = await evaluateSenderProof(req, credentialToken, principal);

  if (mode === "observe") {
    // Admitted whatever the verdict, and `authMethod` stays `passport`: the
    // credential that actually authenticated this call was a bearer visa, and a
    // receipt goes to third parties. `unavailable` records nothing rather than
    // guessing — there is no authentication to fail here, so a replay-store blip
    // must not become a diagnostic that looks like a real failure.
    return verdict === "unavailable"
      ? { ok: true, authMethod: "passport" }
      : { ok: true, authMethod: "passport", would: verdict };
  }

  switch (verdict) {
    case "pass":
      return { ok: true, authMethod: "passport_proof_per_request" };
    case "missing":
      return { ok: false, response: err(401, "missing_sender_proof") };
    case "clock_skew":
      return {
        ok: false,
        response: errMessage(
          401,
          "sender_proof_clock_skew",
          `The sender proof is outside the ${SENDER_PROOF_WINDOW_SECONDS}-second window. Check the agent clock and NTP synchronization.`
        ),
      };
    case "replayed":
      return { ok: false, response: err(401, "sender_proof_replayed") };
    case "unavailable":
      // Replay protection is part of authentication, unlike the fail-open kill
      // switch. An unreadable nonce store cannot admit a proof as single-use.
      return { ok: false, response: err(503, "sender_proof_replay_check_unavailable") };
    default:
      return { ok: false, response: err(401, "invalid_sender_proof") };
  }
}

/**
 * The custom endpoint for this (agent, provider), or null for the built-in host.
 *
 * Three properties worth stating, because each is a decision.
 *
 * IT IS RE-VALIDATED, NOT TRUSTED. A row written while `PROVIDER_ENDPOINT_MODE`
 * allowed something must not be reached after the operator narrowed it, and a
 * value stored under an older rule must not be honoured by a newer one. Validate
 * on write AND on read, and let them agree.
 *
 * IT SHORT-CIRCUITS WHEN THE GATE IS OFF. That is the default, so on a
 * deployment that has not opted in this costs no Redis read and no database read
 * at all — the feature is absent rather than merely disabled.
 *
 * ITS CACHE IS UNSEALED. An endpoint is an address, not secret material, so it
 * does not go through lib/crypto/aesgcm.ts, and the empty string is a real
 * cached value meaning "this credential has none" — caching that absence is what
 * keeps the common case off the database.
 */
type EndpointResolution =
  /**
   * A real answer: the endpoint to use (null meaning the provider's own host),
   * and WHICH credential said so. That id is what step 6 fetches the secret for,
   * so the key and the address cannot come from two different rows. It is null
   * when the gate is off (no read happened) or when the tenant has no credential
   * for this provider at all.
   */
  | {
      known: true;
      endpoint: string | null;
      credentialId: string | null;
      /**
       * The credential invalidation fence as it stood when this resolution
       * began. Two jobs: it conditions the cache fill, and step 6 re-reads it
       * before dispatch so a rotation landing between the address and the secret
       * refuses the call instead of pairing them. Null when the gate is off,
       * where there is no second address for a secret to reach.
       */
      fence: string | null;
    }
  /** No answer at all. NOT the same thing as "no endpoint", and must not become it. */
  | { known: false };

/**
 * The sealed secret inside a credential-bound cache bundle, or null.
 *
 * Null on anything unexpected — a different credential, an unparseable value, a
 * bare string left by a build that did not bind them. Every one of those is a
 * cache MISS, which costs one RPC. The alternative is using key material whose
 * origin cannot be established, next to an address that names a specific server.
 */
function unbindCachedKey(raw: string, credentialId: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { c?: unknown; k?: unknown };
    if (parsed?.c !== credentialId) return null;
    return typeof parsed.k === "string" ? parsed.k : null;
  } catch {
    return null;
  }
}

async function resolveEndpoint(
  db: ServiceDatabase,
  userId: string,
  agentId: string,
  provider: string
): Promise<EndpointResolution> {
  const policy = endpointPolicy();
  if (policy.kind === "off") {
    return { known: true, endpoint: null, credentialId: null, fence: null };
  }

  // Read FIRST, before the cache and before the row, because this value has to
  // predate everything it will later be compared against. Taken on the hit path
  // as well as the miss path: step 6 uses it to prove the address and the secret
  // belong to the same generation, and an address served from cache is exactly
  // the case where they can have drifted apart.
  //
  // One Redis GET, paid only by deployments that turned custom endpoints on.
  let fence: string | null = null;
  try {
    fence = await readCredentialFence(agentId, provider);
  } catch {
    fence = null;
  }

  const admit = (value: string | null, credentialId: string | null): EndpointResolution => ({
    known: true,
    endpoint: value && isEndpointAllowed(value, policy) ? value : null,
    credentialId,
    fence,
  });

  try {
    const cached = await getCachedEndpoint(agentId, provider);
    // A cached endpoint carries the credential it came from, after `|`. An entry
    // without one is from a build that did not bind them and is treated as a
    // miss: re-reading costs one query, and pairing a secret with an address
    // whose origin is unknown is the defect this is here to prevent.
    if (cached !== null && cached.includes("|")) {
      const [id, ...rest] = cached.split("|");
      return admit(rest.join("|") || null, id || null);
    }
  } catch {
    // A cache read failure falls through to the source of truth.
  }

  let stored: string | null = null;
  let credentialId: string | null = null;
  try {
    // `error` is read, and that is the whole point of this block.
    //
    // supabase-js reports a query failure by RETURNING `{ data: null, error }`,
    // not by throwing — so the catch below never sees one, and destructuring
    // only `data` made a failed read indistinguishable from a credential that
    // has no endpoint. The consequence of that guess was to send a real provider
    // credential to the built-in provider host: for a key provisioned for
    // someone else's server (LiteLLM, vLLM, an internal gateway) that is the
    // wrong destination, not a safe default. It also CACHED the guess, so one
    // transient blip pinned the wrong host for the whole TTL.
    // Scoped by the credential's OWN tenant column, and no embed.
    //
    // This read used to select `endpoint_base_url, agents!inner(id)` and filter
    // `agents.id`, which PostgREST cannot plan: `provider_credentials` and
    // `agents` have no foreign key between them — each references `users`. Real
    // PostgREST answers PGRST200 / HTTP 400, the `error` branch below correctly
    // reads that as "unknown", and the caller correctly refuses. All three of
    // those behaved as designed; the query was simply impossible, so with the
    // gate ON every call 502'd, for every provider, custom endpoint or not. The
    // endpoint cache could never mask it either: setCachedEndpoint has exactly
    // one call site, at the tail of this function, so a warm entry required a
    // read that never once succeeded.
    //
    // `userId` is the agent's owner, re-derived from the agents row at issuance
    // (mintVisa takes `agent.user_id`) or read live by the direct-key RPC — the
    // same identity kill state, policy and allowance are already read with in
    // this handler. `get_provider_key` re-derives ownership independently, so
    // the key and this address are chosen by two different readings of the same
    // fact; see S-01 in daybreakblue-1 for why that pairing is not yet bound.
    //
    // `.maybeSingle()` is a guarantee, not an assumption: 0027's partial unique
    // index on `(user_id, provider) where is_active` allows at most one active
    // credential per tenant per provider.
    const { data, error } = await db
      .from("provider_credentials")
      .select("id, endpoint_base_url")
      .eq("user_id", userId)
      .eq("provider", provider)
      // The SAME selection rule get_provider_key uses — the chosen credential,
      // else the legacy oldest-first pick. This used to filter `is_active = true`
      // instead, which disagrees with the decrypt path for a tenant that has
      // never marked one active: the key came from the oldest row while this read
      // found nothing and reported "no custom endpoint", sending that key to the
      // provider's own host. One rule, or they drift apart again.
      .order("is_active", { ascending: false })
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    const row = data as { id?: unknown; endpoint_base_url?: unknown } | null;
    stored = typeof row?.endpoint_base_url === "string" ? row.endpoint_base_url : null;
    credentialId = typeof row?.id === "string" ? row.id : null;
  } catch {
    // Not knowing where a credential goes is a reason to refuse the call, and
    // the caller does exactly that. Deliberately NOT cached: caching an unknown
    // as an absence is how one blip outlives itself by a minute.
    //
    // This is the same direction as the direct-key rule in CLAUDE.md invariant
    // 3 — an unreadable credential was not authenticated — and the opposite of
    // the kill switch, which fails open because Redis suspend is its backstop.
    // There is no backstop for a destination.
    return { known: false };
  }

  // An empty result with no error IS an answer: this credential has no endpoint.
  // Caching that absence is what keeps the common case off the database.
  waitUntil(
    setCachedEndpoint(
      agentId,
      provider,
      `${credentialId ?? ""}|${stored ?? ""}`,
      KEY_CACHE_TTL_S,
      fence
    )
  );
  return admit(stored, credentialId);
}

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

/**
 * Coalesced last-seen, the direct-key half of it.
 *
 * The passport path stamps this at the challenge and again at the visa mint; a
 * direct key reaches neither, so `lastseen:<agid>` was never written for a
 * direct-key agent, the reconcile cron had nothing to flush, and
 * `agents.last_seen_at` stayed NULL however many calls the agent made — the
 * fleet table read "never" for an agent whose last call was minutes old.
 *
 * Swallows everything, in both directions. This is a presentation stamp sitting
 * on the money path: it must not add latency to the gate, and it must never be
 * able to refuse, delay or 500 a call. A rejected write is swallowed, and so is
 * a SYNCHRONOUS throw — `redis()` constructs its client on first use and can
 * throw outright on a misconfigured instance, which without the guard would
 * surface to the caller as `authentication_unavailable` on a call whose
 * credential was in fact perfectly good. A missed stamp costs one stale cell.
 */
function stampLastSeen(agentId: string): void {
  try {
    waitUntil(Promise.resolve(touchLastSeen(agentId)).catch(() => undefined));
  } catch {
    // Deliberately empty — see above.
  }
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
      // Stamped the moment the credential is accepted, which keeps the meaning
      // the passport path already gives it: last *seen*, not last *cleared*. A
      // suspended or over-budget agent presenting a valid key was still seen,
      // and that is precisely when an operator wants to know it is still live.
      stampLastSeen(principal.agentId);
      return { ok: true, principal, db, credentialToken: credential.token };
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
    credentialToken: credential.token,
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
  base: GateBaseInput,
  budget: { tokens: number | null; microcents: number | null },
  current?: Awaited<ReturnType<typeof readCurrentAgentPolicyAndShadow>>,
  policyFailClosed = process.env.POLICY_FAIL_CLOSED === "true"
): Promise<{
  gate: ReturnType<typeof evaluateGate>;
  policy: GatePolicyInput;
  policyRateLimit?: GateRateLimitInput;
  /** The candidate document itself, so each fallback can be judged by it too. */
  shadow: unknown;
  /** Which candidate it is. Stamped onto every verdict; see lib/policy-shadow.ts. */
  shadowRev: string | null;
  /** Which complete live rule set this call evaluated. Signed into its receipt. */
  liveRev: string;
  /** The live counter question and its answer, for shadowVerdict's rule 3. */
  hourly: HourlyObservation;
  shadowWould?: string;
  /**
   * What Postgres knows about this agent's budget counters, carried out of the
   * read that already happened. Rides to the open script as an argument so the
   * loss check costs no extra round trip and is evaluated inside the same
   * atomic script that moves the money.
   */
  budgetState: { epoch: string | null; established: boolean };
}> {
  const { policy: currentPolicy, shadow, budgetState } =
    current ?? (await readCurrentAgentPolicyAndShadow(db, userId, agentId));
  const policy: GatePolicyInput =
    currentPolicy === POLICY_UNREADABLE
      ? { kind: POLICY_UNREADABLE }
      : { kind: "value", value: currentPolicy };
  const liveRev = effectiveLivePolicyRevision(
    currentPolicy,
    base.scopes ?? [],
    budget,
    policyFailClosed
  );

  if (currentPolicy === POLICY_UNREADABLE) {
    logFailOpen("policy_read");
  }

  let gate = evaluateGate({
    ...base,
    policy,
    policyFailClosed,
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
      policyFailClosed,
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
    liveRev,
    hourly,
    budgetState,
    ...(shadowWould ? { shadowWould } : {}),
  };
}

function effectiveLivePolicyRevision(
  policy: unknown,
  scopes: readonly VisaScope[],
  budget: { tokens: number | null; microcents: number | null },
  policyFailClosed: boolean
): string {
  return livePolicyRevision({
    policy:
      policy === POLICY_UNREADABLE
        ? { state: "unreadable" }
        : { state: "value", value: policy },
    scopes,
    budget,
    policyFailClosed,
  });
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
  const { principal, db, credentialToken } = authentication;
  const agentId = principal.agentId;
  const userId = principal.userId;
  const scopes = principal.scopes;
  // Observability already calls this field `jti`; for a direct call it carries
  // the per-call credential-use id, never a fabricated visa id.
  const credentialUseId = crypto.randomUUID();
  const jti = principal.kind === "passport" ? principal.visaJti : credentialUseId;
  // Named here so the id can travel in a response header before the log row —
  // and the signed receipt inside it — exists. The proof is built and signed
  // later, in waitUntil; the hot path costs one uuid and one header.
  const receiptId = crypto.randomUUID();
  // The caps AS THE CREDENTIAL CARRIES THEM. For a passport visa these are `bt`
  // and `bc`, minted when the visa was issued and authenticated ever since — so
  // on their own they are a snapshot up to a full visa lifetime old. They are
  // the fallback below, not the answer: see S3-04.
  const visaCapTokens: number | null = principal.budgetTokens;
  const visaCapMicrocents: number | null =
    principal.budgetCents == null
      ? null
      : Math.round(Number(principal.budgetCents) * MICROCENTS_PER_CENT);
  // `principal.spentTokens` / `.spentMicrocents` — the visa's `st`/`sc` claims —
  // are deliberately READ BY NOTHING NOW. They used to seed the hot-path spend
  // counters, and that seed was a way to create capacity: the claims are minted
  // from `agents.spent_*`, a best-effort mirror lib/log.ts drops silently on RPC
  // failure, so a cold instance re-seeded from an older, lower number.
  //
  // The claims stay IN the visa — removing them is a visa-shape change and out
  // of scope here — they simply stop deciding anything. Authoritative spend now
  // comes from Redis, which is rebuilt from `agent_logs` when it has to be.

  // A proof is authentication, so validate it before a stolen bearer can spend
  // the legitimate agent's request-rate allowance. Direct keys keep their old
  // ordering and remain bearer credentials.
  let currentPolicySnapshot:
    | Awaited<ReturnType<typeof readCurrentAgentPolicyAndShadow>>
    | null = null;
  let passportAuthMethod: PassportAuthMethod = "passport";
  // Only ever set by observe mode. Rides to the audit row and stops there.
  let senderProofWould: SenderProofObservation | undefined;
  if (principal.kind === "passport") {
    currentPolicySnapshot = await readCurrentAgentPolicyAndShadow(db, userId, agentId);
    const senderConstraint = await enforceSenderConstraint(
      req,
      credentialToken,
      principal,
      currentPolicySnapshot
    );
    if (!senderConstraint.ok) return senderConstraint.response;
    passportAuthMethod = senderConstraint.authMethod;
    senderProofWould = senderConstraint.would;
  }

  // Built from the result of the authentication path, never from the flag.
  // This value is carried unchanged into both the signed receipt and audit row.
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

  // The passport path began this snapshot before the rate limiter because the
  // sender proof is authentication. Direct keys retain the previous ordering.
  const policyFailClosed = process.env.POLICY_FAIL_CLOSED === "true";
  currentPolicySnapshot ??= await readCurrentAgentPolicyAndShadow(db, userId, agentId);

  // ── The caps that actually gate this call ──────────────────────────────────
  //
  // The live row wins over the credential's snapshot. Lowering a budget used to
  // do nothing to an outstanding passport visa for up to 15 minutes: `verifyVisa`
  // authenticated the stale `bt` perfectly, the proxy passed it straight to
  // `openHold`, and the atomic Lua enforced it exactly — atomicity protecting
  // the wrong number. Direct Agent Keys never had this, because their
  // authentication RPC returns the current row on every request.
  //
  // It rides the policy read that already happens on every call, so it costs no
  // round trip; the same read's cache is invalidated by `updateAgentBudgets`, so
  // the delay is bounded by that purge rather than by a visa lifetime.
  //
  // `known: false` — an older schema, an entry written before this field, a
  // failed read — keeps the credential's claim, which is exactly what shipped
  // before. An unknown must not become a new denial path, and must not become
  // "no cap" either.
  const liveBudget = currentPolicySnapshot.budget;
  const capTokens: number | null = liveBudget.known ? liveBudget.tokens : visaCapTokens;
  const capMicrocents: number | null = liveBudget.known
    ? liveBudget.cents == null
      ? null
      : Math.round(Number(liveBudget.cents) * MICROCENTS_PER_CENT)
    : visaCapMicrocents;
  const policyRevision = effectiveLivePolicyRevision(
    currentPolicySnapshot.policy,
    scopes,
    { tokens: capTokens, microcents: capMicrocents },
    policyFailClosed
  );

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
            policyRevision,
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
          ...(senderProofWould ? { senderProofWould } : {}),
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

  // ── 3. Per-agent request-rate limit (call-volume DoS / abuse guard) ─────────
  //
  // AFTER the revocation gate, and that order is the control. `rateLimit`
  // MUTATES a fixed-window counter — RATE_LIMIT_LUA increments and then decides
  // — so taking it first meant every call from a killed tenant or a suspended
  // agent spent the legitimate agent's allowance on its way to a 403. An
  // attacker holding a stopped credential could hold the counter above its
  // threshold for the length of an incident, so the moment the operator disarmed
  // the kill switch the honest traffic met 429s, and continued attacker traffic
  // kept it there. A kill switch you cannot cleanly come back from is not one.
  //
  // What must stay ABOVE it: the unauthenticated IP limiter (it protects the
  // database lookup itself) and sender-proof verification (an unproven sender
  // must not reach a counter keyed by the identity it has not proven).
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
    // No receipt id: the rate limit writes no row, so there would be nothing for
    // the id to name. (It no longer runs before every gate — revocation is
    // above it now — but it still records nothing of its own.)
    return new Response(JSON.stringify({ error: "rate_limited" }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": String(PROXY_RATE_WINDOW_S) },
    });
  }

  // ── Read body once (small); extract model + stream; mutate for usage ─────────
  // POST bodies must be JSON (the proxy parses + re-serializes them); reject other
  // declared content types rather than silently parsing.
  if (req.method !== "GET") {
    const ct = (req.headers.get("content-type") ?? "").toLowerCase();
    if (ct && !ct.includes("application/json")) return err(415, "unsupported_media_type");
  }
  let bodyObj: any = {};
  // A real byte bound, applied while the bytes arrive (CP-02). The old shape —
  // `await req.text()` then a `.length` check — drained an unknown-length upload
  // in full before refusing it, and counted UTF-16 code units rather than bytes,
  // so multi-byte JSON went through several megabytes over the cap.
  const bounded = await readBoundedBody(req, MAX_BODY_BYTES);
  if (!bounded.ok) return err(413, "payload_too_large");
  const rawBody = bounded.text;
  // From here a receipt can bind what the client actually sent. Note this is
  // rawBody, never forwardBody: the proxy injects stream_options.include_usage
  // below and re-serialises, and the verifier holds the client's bytes.
  capturedBody = rawBody;
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
  const currentPolicyGate = await evaluateCurrentPolicyGate(
    db,
    userId,
    agentId,
    gateBase,
    { tokens: capTokens, microcents: capMicrocents },
    currentPolicySnapshot,
    policyFailClosed
  );
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
  // `seedSpent` USED TO BE HERE, and its deletion is the point.
  //
  // It NX-seeded `spent:` from the visa's `st` claim, which is minted from
  // `agents.spent_tokens` — a best-effort mirror that lib/log.ts drops silently
  // on RPC failure. So after a Redis flush it re-initialised the counter from an
  // older, LOWER number and handed the difference back as spendable capacity,
  // on a schedule nobody could see.
  //
  // Nothing seeds from a mirror any more. Either Postgres has never recorded
  // budget state for this agent — in which case enforcement starts at zero,
  // deliberately, because enforcement begins when the budget does — or it has,
  // and a disagreeing epoch means loss, which is refused rather than guessed at.
  // The check rides into the open script as an argument, so it costs no extra
  // round trip and cannot race a concurrent flush.
  const budgeted = capTokens != null || capMicrocents != null;
  const budgetState = budgeted ? currentPolicyGate.budgetState : undefined;


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

    /**
     * What the failure net needs to know about an attempt in flight.
     *
     * Between opening a hold and settling it there are roughly eight places that
     * can throw — a receipt helper, a JSON parse, an unexpected null. Every one
     * of them used to leave the reservation open, and before this work that
     * merely meant waiting 960s for a marker to expire. Now an open hold NEVER
     * expires, so a leak here would consume the agent's budget until a human
     * resolved it by hand. The net has to be structural.
     */
  interface AttemptGuard {
    attemptId: string;
    /** Set the moment a settlement is started, so the net never double-settles. */
    settled: boolean;
    /**
     * Set IMMEDIATELY before the `fetch` call and nowhere else.
     *
     * The boundary is the opposite way round from the obvious reading: `fetch`
     * THROWING is `usage_unknown`, not `not_dispatched`, because the request may
     * have arrived and been served before the connection died. So this flips
     * before the call, not after it, and the ordinary network-failure catch
     * below keeps owning that case explicitly.
     */
    dispatched: boolean;
  }

  const runAttempt = async (
    target: AttemptTarget,
    opts: { primary: boolean }
  ): Promise<AttemptOutcome> => {
    // Per ATTEMPT, not per request. A failover makes two attempts under one
    // visa and they are two separate holds against the same budget, so an id
    // shared between them would make the second settle read as a replay of the
    // first and silently skip a real charge.
    const guard: AttemptGuard = {
      attemptId: crypto.randomUUID(),
      settled: false,
      dispatched: false,
    };
    try {
      return await attemptWithHold(target, opts, guard);
    } catch (error) {
      // THE HOLD CLOSES EVEN WHEN NOTHING ELSE WORKED. Deliberately not routed
      // through `reconcile`: that also writes an audit row and signs a receipt,
      // and this is the path where something in exactly that machinery just
      // threw. Settling directly keeps the money correct without depending on
      // the code that failed.
      //
      // Settling an attempt whose hold was never opened is a no-op that moves
      // nothing (the script refuses to guess), so this is safe to run
      // unconditionally on the un-settled path.
      if (!guard.settled) {
        waitUntil(
          guard.dispatched
            ? // It may have been sent and billed. Charge the estimate; the
              // script keeps the greater of that and the zero passed here.
              settleUnknown({ agentId, attemptId: guard.attemptId, tokens: 0, microcents: 0 })
            : releaseUndispatched({ agentId, attemptId: guard.attemptId })
        );
      }
      throw error;
    }
  };

  const attemptWithHold = async (
    target: AttemptTarget,
    { primary }: { primary: boolean },
    guard: AttemptGuard
  ): Promise<AttemptOutcome> => {
    const attemptProvider = target.provider;
    const attemptModel = target.model;
    const attemptReceiptId = target.receiptId;
    const attemptId = guard.attemptId;
    const usageProtocol = isOpenAiResponsesEndpoint(attemptProvider, target.upstreamPath)
      ? "responses"
      : "provider";

    // S5: ensure OpenAI-compatible streams report usage. Re-derived per attempt —
    // the flag is provider-shaped and the model in the body changes. A copy, not
    // a mutation of bodyObj, so one attempt cannot contaminate the next. The
    // model key is only set when the client sent one, so a model-listing GET
    // keeps the body it had.
    const attemptBody: Record<string, unknown> = model
      ? { ...bodyObj, model: attemptModel }
      : { ...bodyObj };
    if (usesOpenAiUsageShape(attemptProvider) && wantsStream && usageProtocol !== "responses") {
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

    // ── 5. Open the attempt's hold (atomic) ────────────────────────────────────
    const reserve = await openHold({
      agentId,
      attemptId,
      estimate,
      estimateMicrocents,
      capTokens,
      capMicrocents,
      // Recorded ON THE HOLD, read by nothing that moves money. It is the only
      // thing that identifies an abandoned attempt to the operator who has to
      // decide it: that attempt wrote no agent_logs row, so there is no receipt
      // and no other place the attempt id appears. Provider + model + started-at
      // is what makes the line findable on the provider's own billing page.
      provider: attemptProvider,
      ...(attemptModel ? { model: attemptModel } : {}),
      ...(budgetState ? { budgetState } : {}),
    });

    // First budgeted call of this agent's life: Redis minted an epoch and
    // Postgres has to learn it, or the loss check can never fire. Purging the
    // policy cache alongside is NOT optional — it is what bounds the window in
    // which a flush would go undetected to this one call rather than to a full
    // cache TTL, because every read until then would keep reporting
    // `established: false` and skip the check entirely.
    if (reserve.epochToPersist) {
      const epoch = reserve.epochToPersist;
      // AWAITED, NOT SCHEDULED. This used to run inside `waitUntil`, which calls
      // it before the send but does not wait for it — so a call could be
      // forwarded and billed with the marker still unwritten.
      //
      // That window is not a small one. `open` refuses a lost epoch only for an
      // agent Postgres says was established; until this row lands it says the
      // opposite. A Redis flush inside the window is therefore undetectable
      // FOREVER: the next call mints a fresh epoch, seeds both counters at zero,
      // and the agent's entire spend history is gone with its budget restored.
      // One database write on the first budgeted call of an agent's life is a
      // small price for the loss check being able to fire at all.
      //
      // Writing the SAME value again is the intended behaviour on a lost reply —
      // `epochToPersist` is the epoch Redis already holds, never a fresh mint —
      // so a retry converges rather than bricking the agent on a mismatch.
      try {
        await establishBudgetState(agentId, epoch);
      } catch (error) {
        // Cannot confirm the generation ⇒ nothing is forwarded. The contract is
        // two-sided: a matching durable generation, or no upstream call.
        //
        // The hold this attempt just opened is released FIRST, and before the
        // failover branch so both exits release exactly once. Nothing has been
        // dispatched — this returns above the send — so the one full release in
        // the system is the honest ending, and without it every transient
        // database error would strand a reservation that only an operator can
        // clear. Scheduled, not awaited: a failed release leaves an open hold,
        // which is recoverable, while a slower 503 is not better than a fast one.
        waitUntil(releaseUndispatched({ agentId, attemptId }));
        if (!primary) return { kind: "skipped" };
        waitUntil(
          captureError(error, {
            route: "api.proxy",
            method: req.method,
            status: 503,
            provider: attemptProvider,
            agentId,
            jti,
            code: "blocked_budget_state",
          })
        );
        logBlocked("blocked_budget_state", attemptModel, 503);
        captureBlocked("blocked_budget_state", 503);
        return { kind: "response", response: errR(503, "blocked_budget_state") };
      }
      // The purge stays scheduled: it bounds how long a stale `established:
      // false` can be read from cache, but the request does not depend on it
      // and a failed purge must not refuse a call whose epoch is durable.
      waitUntil(purgeAgentPolicy(userId, agentId));
    }

    // A LOST-STATE REFUSAL IS NOT A CAP DENIAL, and it returns before the gate
    // so that it cannot become one. `evaluateGate` answers `deniedBy: "budget"`
    // with 402 `blocked_budget`, which an agent reads as "I am out of money" and
    // stops retrying for. This is an operator-recoverable infrastructure fault:
    // 503, retryable, fixed by a rebuild and not by raising a cap. Keeping it
    // out of the gate also keeps the gate's budget contract exactly "a cap
    // denied this" rather than widening it to a third meaning — so only
    // `tokens` / `cost` are ever passed in below.
    if (!reserve.ok && reserve.reason === "state") {
      // A fallback cannot rescue this: the counters are lost for the AGENT, not
      // for one provider, so every attempt would be refused identically.
      if (!primary) return { kind: "skipped" };
      waitUntil(
        captureError(new Error("budget state unavailable"), {
          route: "api.proxy",
          method: req.method,
          status: 503,
          provider: attemptProvider,
          agentId,
          jti,
          code: "blocked_budget_state",
        })
      );
      logBlocked("blocked_budget_state", attemptModel, 503);
      captureBlocked("blocked_budget_state", 503);
      return { kind: "response", response: errR(503, "blocked_budget_state") };
    }

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
        // ONLY CAP REASONS REACH THE GATE. `state` was answered above with a
        // 503 and returned; narrowing here rather than widening the gate's
        // budget contract is deliberate, so `deniedBy === "budget"` keeps
        // meaning exactly "a cap denied this". If this union grows again,
        // narrow it here too rather than teaching lib/gate.ts a third meaning.
        ...(reserve.reason === "tokens" || reserve.reason === "cost"
          ? { reason: reserve.reason }
          : {}),
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
    // Where this attempt's credential goes, resolved BEFORE `reconcile` because
    // that closure prices the call and a custom endpoint is unpriced. Declaring
    // it at the injection point instead put it in the temporal dead zone of a
    // closure TypeScript cannot order-prove, which the failover suite caught as
    // a 500 where a 402 belonged.
    //
    // `resolveEndpoint` returns null for every deployment that has not opted in,
    // which is the default — so on Cloud today this is one short-circuit and no
    // reads at all. It re-validates rather than trusting the row: a value stored
    // while the gate was wider must not be reached after an operator narrowed it.
    const resolvedEndpoint = await resolveEndpoint(db, userId, agentId, attemptProvider);
    // Null both when there is genuinely no endpoint and when the read failed —
    // the failure is refused below, and pricing an unsent call is moot either way.
    const custom = resolvedEndpoint.known ? resolvedEndpoint.endpoint : null;

    /**
     * Close this attempt's hold and write its audit row.
     *
     * `outcome` IS REQUIRED AND HAS NO DEFAULT. That is the entire point of the
     * argument: TypeScript then forces an explicit decision at every one of the
     * call sites below, and a new exit path cannot inherit a settlement policy
     * by accident. It is deliberately the THIRD parameter, ahead of the optional
     * `httpStatus`, so every existing call fails to compile rather than
     * silently keeping its old behaviour.
     *
     *   complete       — the provider gave a definitive answer. Charge what was
     *                    observed; that may be nothing.
     *   usage_unknown  — it was dispatched and may have been billed, and nobody
     *                    can say for how much. Charges max(observed, estimate).
     *   not_dispatched — provably never sent. The only full release.
     */
    const reconcile = (
      usage: Usage,
      status: Parameters<typeof writeLog>[0]["status"],
      outcome: "complete" | "usage_unknown" | "not_dispatched",
      httpStatus = 200
    ): Settlement => {
      // Before anything that could throw. The net above must never fire for an
      // attempt whose settlement has already been decided here.
      guard.settled = true;
      // Unpriced when it did not go to the provider's own host: a proxy may mark
      // up, re-route or alias, so a matching model name is not a matching price.
      //
      // `cost` is 0 in that case, and 0 IS NOT THE ANSWER — it is the absence of
      // one. Carry the distinction rather than letting the zero travel alone:
      // the audit row records null (unknown), the receipt carries `unp`, and the
      // spend mirror takes the 0 because unknown money cannot be added to a
      // total. Every one of those three used to receive a bare zero and present
      // it as "this call was free".
      const cost = costMicrocentsForUsage(usage, attemptModel, attemptProvider, custom);
      const priced = isPricedEndpoint(custom);

      // Every token the provider processed for this call, which is what a token
      // budget is a limit on. Anthropic reports a cached prompt across three
      // fields and `input_tokens` is only the UNCACHED remainder, so summing just
      // input+output charged a steady-state cached agent for ~12 tokens of an
      // ~18,000-token prompt — a cap set in the dashboard that the agent could
      // run straight through. Cache reads are cheap, not free, and they are not
      // absent.
      const billedTokens =
        usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;

      // WHAT THE COST DIMENSION IS CHARGED, which is not always the price.
      //
      // For an unpriced endpoint `cost` is 0 — not because the call was free but
      // because nobody could price it. Settling the cost dimension at that zero
      // released the whole cost reservation, so a cost cap NEVER ADVANCED on an
      // agent using a custom endpoint: it could run forever against a limit that
      // could not move. The reservation stands instead. The audit row still
      // records `cost_microcents: null` + `unpriced: true`, because what was
      // enforced and what was priced are different questions.
      const chargeMicrocents = priced ? cost : estimateMicrocents;
      // What the ROW will say was observed, in the terms the spend view reads it
      // in: `coalesce(enforced_microcents, coalesce(cost_microcents, 0))`. An
      // unpriced row contributes 0 there, so this is 0 for one.
      const observedMicrocentsForRow = priced ? cost : 0;

      // Close the hold FIRST and hold its promise. Everything after this line —
      // receipt signing included — is then structurally unable to prevent it.
      // Built inline in the tasks array instead, a throw while assembling the
      // writeLog argument would destroy the array before the hold was ever
      // settled, leaving the reservation open and silently shrinking the
      // agent's budget until an operator resolved it by hand.
      //
      // The caller passes only OBSERVED figures. The script computes the release
      // from the estimate IT stored, so settlement can no longer be handed an
      // estimate that disagrees with what was actually reserved — and a replay
      // of any of these is a no-op that returns the first call's answer.
      const settlement: Promise<SettleResult> =
        outcome === "not_dispatched"
          ? releaseUndispatched({ agentId, attemptId })
          : outcome === "usage_unknown"
            ? settleUnknown({
                agentId,
                attemptId,
                tokens: billedTokens,
                microcents: chargeMicrocents,
              })
            : settleKnown({
                agentId,
                attemptId,
                tokens: billedTokens,
                microcents: chargeMicrocents,
              });
      const released: Promise<unknown> = settlement;

      const done = (async () => {
        // What the hold ACTUALLY applied, read back from the script rather than
        // recomputed here. Recomputing would reintroduce the whole defect class:
        // two places deciding what an attempt cost, disagreeing, and the
        // disagreement showing up as an agent refused at a cap the dashboard
        // says it is nowhere near.
        //
        // Resolved ALONGSIDE the receipt rather than before it. Serialising the
        // two would put a Redis round trip in front of the audit row for no
        // reason — the receipt does not depend on the settlement — and it is the
        // audit row that has to survive.
        //
        // `.catch(() => null)` because a settle that FAILED must not also cost
        // the audit row. We then simply do not know what was applied, so the
        // enforced columns are omitted (absence already means "the observed
        // figure was what was enforced", which is the least-wrong reading) and
        // the spend mirror is skipped rather than fed a guess.
        const [applied, receipt] = await Promise.all([
          settlement.catch(() => null),
          // Signed here, inside waitUntil, so the hot path pays nothing for it.
          // signReceipt never throws — it returns null on any failure, including
          // an unconfigured deployment.
          (async () =>
            safeReceipt({
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
          // THE RECEIPT SPLITS, THE LOG ROW FOLDS. Deliberate, and the two must
          // not be "made consistent" with each other:
          //
          //   here          — `in` is the provider's own `input_tokens`, with the
          //                   cache traffic named separately as `cr`/`cw`. A
          //                   stranger checking this receipt against the
          //                   provider's invoice finds matching numbers, and the
          //                   discounted portions are visible rather than buried.
          //   writeLog below — one folded total, because `reconcile_agent_spend`
          //                   sums `input_tokens + output_tokens` and there is no
          //                   cache column for it to read. Splitting there would
          //                   drop the cache tokens out of authoritative spend at
          //                   the next cron, re-opening the bug this closes.
          //
          // Both describe the same call; `cost` is identical and already includes
          // all three dimensions either way.
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          ...(usage.cacheReadTokens ? { cacheReadTokens: usage.cacheReadTokens } : {}),
          ...(usage.cacheWriteTokens ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
          costMicrocents: cost,
          ...(priced ? {} : { unpriced: true }),
          status,
          httpStatus,
          startedAt: started,
          latencyMs: Date.now() - started,
          policyRevision: currentPolicyGate.liveRev,
          owner: await currentOwner(),
          previousReceiptId: target.prev,
          failoverReason: target.why,
            }))(),
        ]);

        const tasks: Promise<unknown>[] = [
          released,
          writeLog({
            id: attemptReceiptId,
            receipt,
            agentId,
            userId,
            // The link that makes this row and an operator's later recovery of
            // the same attempt mutually exclusive. See migration 0056: without
            // it, an attempt the proxy already recorded could be charged a
            // second time by the hold-resolve route.
            attemptId,
            ...logIdentity,
            provider: attemptProvider,
            model: attemptModel,
            // The FOLDED total — see the receipt comment above for why this is
            // not the provider's `input_tokens`. No migration is involved, which
            // is the point: naming a cache column that a deployment has not
            // migrated yet would make PostgREST reject the whole insert and this
            // call would write no audit row at all.
            inputTokens:
              usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
            outputTokens: usage.outputTokens,
            costMicrocents: priced ? cost : null,
            // Says WHY the cost above is null, which the null alone cannot: a
            // blocked call has no recorded cost either and was not unpriceable.
            // Written only when true — see the note on LogEntryBase.unpriced,
            // and db/migrations/0053 for why the negative is never sent.
            ...(priced ? {} : { unpriced: true }),
            status,
            // WHAT WAS ENFORCED, when that differs from what was observed above.
            // Not a correction of the observed figures — both are true and they
            // answer different questions. Omitted when they agree, which keeps
            // an ordinary row byte-identical to what this wrote before 0055 and
            // keeps a pre-0055 deployment writing audit rows at all.
            //
            // A REFUSED OR MISSING SETTLE CANNOT CERTIFY A FREE CALL. `conflict`
            // and `anomaly` both return zeros while moving nothing, and this
            // condition used to be "differs from observed" alone — so an
            // attempt whose settle was refused wrote `enforced_tokens: 0`, and
            // `agent_log_spend_rows` reads COALESCE(enforced, observed), which
            // made a provider call that really happened count as free. Those
            // two outcomes leave the cost UNDECIDED and the hold open; absence
            // is the honest answer, and it falls back to what was observed.
            // A replay is not in that set: its figures are the first
            // resolution's, and they really were enforced.
            ...(applied && !applied.conflict && !applied.anomaly
              ? {
                  ...(applied.appliedTokens !== billedTokens
                    ? { enforcedTokens: applied.appliedTokens }
                    : {}),
                  ...(applied.appliedMicrocents !== observedMicrocentsForRow
                    ? { enforcedMicrocents: applied.appliedMicrocents }
                    : {}),
                }
              : {}),
            latencyMs: Date.now() - started,
            // The TARGET's verdict, not the request's. See AttemptTarget.
            ...(target.shadowWould ? { policyShadowWould: target.shadowWould } : {}),
            // And here the two diverge. A shadow verdict is per ATTEMPT — the
            // draft is re-evaluated against each provider, and two attempts can
            // legitimately disagree. A sender proof is per REQUEST: it is
            // checked once, at authentication, before any provider is chosen.
            // So it rides the primary attempt's row and no other, which keeps a
            // failed-over call from contributing two identical observations and
            // silently doubling every count built on them.
            ...(primary && senderProofWould ? { senderProofWould } : {}),
          }),
        ];
        // Mirrored for `usage_unknown` TOO, not only `ok`, and with the ENFORCED
        // figures rather than the observed ones.
        //
        // Both halves matter. The checkpoint now folds
        // `coalesce(enforced_*, observed)` over both statuses (0055), so a
        // mirror that skipped `usage_unknown`, or that passed the observed
        // figures, would under-count what the checkpoint counts — and this
        // mirror is what lib/dashboard-attention.ts, lib/control-graph.ts,
        // the passport page and the decision trace all read. The visible
        // symptom is an operator seeing "40 tokens" on an agent that is being
        // refused at its cap.
        //
        // NOT mirrored on a replay. `increment_agent_spend` is an INCREMENT, so
        // mirroring a settle that applied nothing would add the delta a second
        // time — the same replay-creates-a-delta bug this work exists to remove,
        // just pointed at the mirror instead of the counter.
        if (applied?.applied && (status === "ok" || status === "usage_unknown")) {
          tasks.push(mirrorSpend(agentId, applied.appliedTokens, applied.appliedMicrocents));
        }
        return Promise.all(tasks);
      })();

      return { released, done };
    };

    const terminal = (response: Response, settle: Settlement): AttemptOutcome => {
      waitUntil(settle.done);
      return { kind: "response", response };
    };

    // The endpoint read gave no answer. Refuse HERE — before step 6 fetches the
    // credential — because if we do not know where a key is going there is no
    // reason to go and get it, and `get_provider_key` is the only decrypt path
    // in the product (trust boundary 5). The reservation taken above is released
    // by `reconcile` on this path like every other exit.
    //
    // Terminal, not retryable: failing over would hand the same call to the next
    // credential while the same database is still not answering.
    if (!resolvedEndpoint.known) {
      waitUntil(
        captureError(new Error("endpoint resolution failed"), {
          route: "api.proxy",
          method: req.method,
          status: 502,
          provider: attemptProvider,
          agentId,
          jti,
          code: "endpoint_unavailable",
        })
      );
      return terminal(
        errR(502, "endpoint_unavailable"),
        // Refused before step 6 even fetches the credential, so nothing was
        // sent and nothing can have been billed. A full release.
        reconcile(NO_USAGE, "endpoint_unavailable", "not_dispatched", 502)
      );
    }

    // ── 5b. A dollar cap cannot be enforced against a price nobody knows ───────
    //
    // S3-03, and a DELIBERATE BEHAVIOUR CHANGE rather than a repair — this call
    // used to be allowed. `estimateMicrocents` above is computed before the
    // endpoint is resolved, so `costMicrocents` receives no endpoint and returns
    // the BUILT-IN PROVIDER'S RETAIL price; `reconcile` then charges that
    // estimate, because settling an unpriced call at zero released the whole
    // reservation and a cost cap could never advance.
    //
    // Each half was deliberate and each is defensible alone. Together they
    // enforce a dollar limit with a number that has nothing to do with the bill:
    // a gateway you run may mark up, re-route, or answer to `gpt-4o-mini` with
    // something far more expensive, and the agent keeps being admitted against
    // the cheap retail figure long after the real spend passed the cap. The
    // audit row said `null` and `unpriced` throughout — the reporting half was
    // honest and the enforcing half was not, about the same money.
    //
    // So the unknown stays unknown at the enforcement boundary, which is the
    // rule everywhere else in this file. The operator has two real answers:
    // remove the dollar cap, or route this agent somewhere PassControl prices.
    //
    // TOKEN caps are untouched. The provider reports token counts and they are
    // real wherever the call went; only the money is unknowable.
    //
    // Refused here rather than before the reserve, because the endpoint cannot
    // be known any earlier without moving `resolveEndpoint` above `openHold` —
    // and that ordering is load-bearing elsewhere. `not_dispatched` releases the
    // reservation in full, so the momentary hold costs the agent nothing.
    if (custom && capMicrocents != null) {
      return terminal(
        errR(409, "unpriced_endpoint"),
        reconcile(NO_USAGE, "blocked_unpriced_endpoint", "not_dispatched", 409)
      );
    }

    // ── 6. Resolve provider key (encrypted cache, else Vault RPC) ──────────────
    //
    // The endpoint was resolved just above, AFTER the budget reserve of step 5
    // and before `reconcile` runs — that closure prices the call and a custom
    // endpoint is unpriced. (An earlier version of this comment said "before the
    // budget reserve", which was simply wrong about its own file: `openHold` is
    // step 5 and `resolveEndpoint` comes after it. The real constraint is
    // reconcile, from 0050's temporal-dead-zone fix.) The secret is resolved
    // here, later still, because the check order puts the decrypt last — a call
    // about to be refused is never decrypted for. Those two reads are separated
    // in TIME on purpose and that is not the defect.
    //
    // The defect (S-01) was that they were separated in IDENTITY: neither value
    // named the credential it came from, so an activation or rotation landing in
    // the gap sent secret B to endpoint A — a real provider key delivered to a
    // server that was never selected to receive it. So when a credential id came
    // back with the address, the secret is fetched FOR THAT ID, and 0069 returns
    // nothing if it is no longer the agent's selected credential. That refusal is
    // the fix; there is deliberately no fallback to the unbound read, because a
    // fallback is just the old pairing with an extra step.
    //
    // With the endpoint gate off there is no id, no second address to disagree
    // with, and nothing to bind — so that path stays byte-for-byte what it was.
    let providerKey: string | null = null;
    const boundCredentialId = resolvedEndpoint.known ? resolvedEndpoint.credentialId : null;
    const cached = await getCachedKey(agentId, attemptProvider, boundCredentialId ?? undefined);
    if (cached) {
      const sealed = boundCredentialId ? unbindCachedKey(cached, boundCredentialId) : cached;
      if (sealed) providerKey = await open(sealed);
    }
    if (!providerKey) {
      // The fence for the FILL, read immediately before the authoritative
      // decrypt so it predates the value it will publish. Deliberately a fresh
      // read rather than the endpoint resolution's: that one is older, and the
      // `key:` namespace is filled on deployments where the endpoint gate is off
      // and no resolution fence was ever taken. Quoting a null there would make
      // every fill fail the moment any credential mutation had ever rotated this
      // fence — correct, and a permanent cache outage.
      let fillFence: string | null = null;
      try {
        fillFence = await readCredentialFence(agentId, attemptProvider);
      } catch {
        // A synchronous throw is possible here, not merely a rejected promise:
        // `Redis.fromEnv()` raises when the environment is incomplete. A bare
        // `.catch()` would not see it.
        fillFence = null;
      }
      const { data: keyData } = boundCredentialId
        ? await db.rpc("get_provider_key_for_credential", {
            p_agent_id: agentId,
            p_provider: attemptProvider,
            p_credential_id: boundCredentialId,
          })
        : await db.rpc("get_provider_key", {
            p_agent_id: agentId,
            p_provider: attemptProvider,
          });
      providerKey = typeof keyData === "string" ? keyData : null;
      if (providerKey) {
        // store ciphertext only, and — when bound — the id it belongs to
        const key = providerKey;
        waitUntil(
          seal(key).then((s) =>
            setCachedKey(
              agentId,
              attemptProvider,
              boundCredentialId ? JSON.stringify({ c: boundCredentialId, k: s }) : s,
              KEY_CACHE_TTL_S,
              boundCredentialId ?? undefined,
              fillFence
            )
          )
        );
      }
    }
    if (!providerKey) {
      // No usage; release the reservation by reconciling with the estimate as spend
      // would over-count, so release exactly the reserve and log zero usage.
      // There was no credential to inject, so the request never left the
       // building.
      const settle = reconcile(NO_USAGE, "no_provider_key", "not_dispatched", 409);
      // A fallback with no stored key is a fallback that cannot run. Release what
      // it took and move on rather than answering the client with its problem.
      if (!primary) {
        await settle.released;
        waitUntil(settle.done);
        return { kind: "skipped" };
      }
      return terminal(errR(409, "no_provider_key"), settle);
    }

    // ── 6b. The address and the secret must belong to one generation ───────────
    //
    // 0069 bound them by credential ID, which stops one credential's key reaching
    // another credential's address. It cannot stop a change BEHIND the same id:
    // rotation replaces the Vault secret in place and an endpoint edit rewrites
    // the same row, so a resolution that read the old address and a decrypt that
    // returned the new secret both name the same credential and pair anyway.
    //
    // The fence closes that window, because every one of those mutations rotates
    // it. If it has moved since the address was resolved, this attempt is holding
    // two halves of different generations and must not send. Nothing is guessed
    // and nothing is re-resolved mid-flight: refuse, and the client's retry gets
    // a coherent pair.
    //
    // Only for a real custom address. With none there is no second destination a
    // secret could be misdelivered to, and a rotation mid-request is then
    // indistinguishable from one that landed a millisecond after dispatch —
    // which no gateway can prevent and this must not pretend to.
    if (custom) {
      // Unreadable means unproven. This is the destination path, which fails
      // CLOSED — the same rule `resolveEndpoint` states for itself, and the
      // opposite of the kill switch, which has Redis suspend as its backstop.
      // There is no backstop for a credential going to the wrong host.
      //
      // THREE outcomes, not two (T4-04). The refusal is the same for the last
      // two and the STATEMENT is not: `credential_changed` is a claim that an
      // operator rotated something, and it is logged, rendered in seven places
      // and signed into a receipt. Emitting it for a read that never completed
      // invents a configuration event out of a Redis fault and sends whoever
      // reads the receipt to look for a rotation that did not happen.
      let observed: string | null;
      try {
        observed = await readCredentialFence(agentId, attemptProvider);
      } catch {
        observed = undefined as never;
      }
      // `null` is not a third kind of match. `rotateFence` SETs a new token
      // rather than deleting the key, so a rotation always shows up as a
      // DIFFERENT non-null value; null after a non-null read is the 24h TTL
      // expiring or an eviction — no observation either way. It refuses for the
      // same reason a throw does, and says the same true thing about why.
      const unreadable = observed === undefined || (observed === null && resolvedEndpoint.fence !== null);
      if (unreadable) {
        return terminal(
          errR(503, "credential_state_unavailable"),
          reconcile(NO_USAGE, "credential_state_unavailable", "not_dispatched", 503)
        );
      }
      if (observed !== resolvedEndpoint.fence) {
        return terminal(
          errR(409, "credential_changed"),
          // Refused before injection: nothing was sent and nothing can have been
          // billed, so this is a full release.
          reconcile(NO_USAGE, "credential_changed", "not_dispatched", 409)
        );
      }
    }

    // ── 7. Inject + forward ────────────────────────────────────────────────────
    //
    const upstreamBase = custom ?? upstreamBaseUrl(attemptProvider);
    let targetUrl: string;
    try {
      // One canonical join. `new URL` silently discards part of an operator's
      // base path — see lib/providers/endpoint.ts — and a gateway that drops
      // `/openai/v1` sends a real credential to a path nobody named.
      //
      // A custom base owns its own version segment, so the canonical path
      // contributes everything after it. Without this the documented
      // `http://vllm.internal:8000/v1` composed to `/v1/v1/chat/completions`
      // and the upstream 404'd — the feature's own example could not work.
      const upstreamSuffix = custom
        ? versionlessUpstreamPath(target.upstreamPath)
        : target.upstreamPath;
      // The client's query string, MINUS this route's own routing parameters.
      // Next re-appends `[provider]` and `[...path]` to `req.url` as ordinary
      // query parameters before a handler runs, so forwarding `req.url`'s search
      // verbatim sent our router's internals to the provider — see
      // forwardableUpstreamSearch. The names come from the params object, so a
      // renamed route segment cannot leave a stale one behind. Inside the try
      // deliberately: a query string that cannot even be parsed refuses the call
      // with nothing dispatched, rather than travelling with a provider key.
      const forwardedSearch = forwardableUpstreamSearch(req.url, Object.keys(params));
      targetUrl = `${joinUpstream(upstreamBase, upstreamSuffix)}${forwardedSearch}`;
    } catch {
      // The upstream URL could not even be constructed. Nothing was sent.
      const settle = reconcile(NO_USAGE, "blocked_endpoint", "not_dispatched", 400);
      if (!primary) {
        await settle.released;
        waitUntil(settle.done);
        return { kind: "skipped" };
      }
      return terminal(errR(400, "blocked_endpoint"), settle);
    }
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


    // ── THE DISPATCH BOUNDARY ────────────────────────────────────────────────
    //
    // ONE ATTEMPT, ONE SEND. `openHold` wrote this attempt at `pre_dispatch`;
    // this is the only transition to `dispatch_may_have_happened`, and it is
    // the last thing that happens before the credential goes anywhere.
    //
    // It buys almost nothing on THIS path — a freshly minted attempt id is
    // always granted — and that is exactly why it went unwired for so long.
    // What it buys is truthful state for the RECOVERY path. Once this has run,
    // SETTLE_LUA's `not_dispatched` guard refuses to release this hold, so an
    // operator resolving an abandoned hold cannot record a request that really
    // was sent as one that never happened. Until this call existed here the
    // phase never moved, that guard could not fire, and `not_spent` on
    // POST /holds/{attemptId}/resolve was a full refund of spent money.
    //
    // A refusal is NEVER a licence to send anyway: whoever won the permission
    // may be inside `fetch` right now with its answer already lost.
    let permitted: DispatchPermissionResult;
    try {
      permitted = await consumeDispatchPermission({ agentId, attemptId });
    } catch (error) {
      // UNREADABLE PERMISSION IS NOT GRANTED PERMISSION. Deliberately the
      // opposite posture to the kill switch, which fails open because Redis
      // suspend is its backstop. There is no backstop here: an unreachable
      // Redis between the reserve and the send means a concurrent dispatch
      // cannot be ruled out, so this one does not happen.
      waitUntil(
        captureError(error, {
          route: "api.proxy",
          method: req.method,
          status: 503,
          provider: attemptProvider,
          agentId,
          jti,
          code: "dispatch_unavailable",
        })
      );
      permitted = { granted: false, reason: "missing" };
    }
    if (!permitted.granted) {
      // A fallback cannot rescue this, for the same reason a lost-state refusal
      // cannot: what is ambiguous is our own accounting for this attempt, not
      // the health of one provider.
      //
      // NOTHING IS SETTLED HERE. The hold stays exactly as it is — open, its
      // reserve intact, visible to the operator through the holds list. If
      // another handler won the permission, that handler owns the settlement;
      // releasing here would hand back capacity for a call that may be in
      // flight. If the hold was already terminal or missing, a settle would
      // move nothing anyway.
      if (!primary) return { kind: "skipped" };
      logBlocked("dispatch_unavailable", attemptModel, 503);
      captureBlocked("dispatch_unavailable", 503);
      return { kind: "response", response: errR(503, "dispatch_unavailable") };
    }
    guard.dispatched = true;

    let upstream: Response;
    try {
      upstream = await fetch(targetUrl, {
        method: req.method,
        headers: fwdHeaders,
        body: req.method === "GET" ? undefined : forwardBody,
        signal: req.signal,
        // THE CREDENTIAL DOES NOT FOLLOW REDIRECTS. Left at the `follow`
        // default, the destination stops being ours: the Fetch algorithm
        // deletes only `Authorization`, `Cookie` and `Proxy-Authorization`
        // across a cross-origin hop, and Anthropic's credential rides
        // `x-api-key` (lib/providers.ts) — so it survives, and the real Vault
        // key reaches a host no operator listed. Measured in both undici and
        // the Next-compiled Edge runtime, 2026-09-01.
        //
        // `isEndpointAllowed` decides where this request is AIMED; without
        // this line the runtime decides where it LANDS, and the allowlist in
        // `endpointPolicy()` stops being a control after one 302. Every other
        // provider was protected only by the accident of using a bearer token.
        //
        // A 307/308 replays the body too, so this also stops the agent's
        // prompt being forwarded onward.
        //
        // lib/owner/{domain,github,company}.ts already do this, on fetches
        // that carry no credential at all.
        redirect: "manual",
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
      // DISPATCHED, NO ANSWER — and this is the case the plan's table is most
      // easily read backwards. `fetch` THROWING is not "never sent": the
      // request may have reached the provider and been served in full before
      // the connection died. We cannot tell, so the estimate is charged and the
      // hold is closed rather than released. The comment below already said the
      // next provider may be the second to bill this request; the accounting
      // now says so too.
      const settle = reconcile(NO_USAGE, "usage_unknown", "usage_unknown", 502);
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

    // With `redirect: "manual"` a 3xx arrives here as an ordinary response
    // instead of being followed. It is refused, not passed through: a bare 3xx
    // with its `Location` stripped is a confusing answer, and one WITH the
    // Location would hand the caller an address — possibly an internal one —
    // that the gateway reached on its behalf.
    //
    // Terminal rather than retryable. Unreachable-upstream fails over because
    // it is an availability problem; a redirect is a deliberate answer from a
    // provider that is up, and the next credential aimed at the same endpoint
    // would be told the same thing.
    if (upstream.status >= 300 && upstream.status < 400) {
      waitUntil(
        captureError(new Error("upstream answered with a redirect"), {
          route: "api.proxy",
          method: req.method,
          status: 502,
          provider: attemptProvider,
          agentId,
          jti,
          // Deliberately not the Location: the point is that it does not travel.
          code: "upstream_redirect",
        })
      );
      return terminal(
        errR(502, "upstream_redirect"),
        // The provider gave a definitive answer — a 3xx — and did no work for
        // it. Nothing to charge.
        reconcile(NO_USAGE, "upstream_error", "complete", 502)
      );
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
          // A 400/401/403/404 is the provider declining the request, definitively
          // and without doing the work. Complete, at zero.
          reconcile(NO_USAGE, "upstream_error", "complete", upstream.status)
        );
      }

      if (why === "credit_exhausted") {
        // The provider refused for credit BEFORE doing any work — mayHaveBeenBilled
        // says exactly this about `credit_exhausted`. Nothing to charge.
        const settle = reconcile(NO_USAGE, "provider_exhausted", "complete", 402);
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
        // SPLIT ON THE EXISTING mayHaveBeenBilled, which already draws exactly
        // this line and is the reason it is reused rather than re-derived:
        // `upstream_5xx` may have been served and billed before it failed, so
        // the estimate stands; `rate_limited` and `credit_exhausted` are the
        // provider declining before doing work, so there is nothing to charge.
        settle: mayHaveBeenBilled(why)
          ? reconcile(NO_USAGE, "usage_unknown", "usage_unknown", upstream.status)
          : reconcile(NO_USAGE, "upstream_error", "complete", upstream.status),
      };
    }

    // ── 8/9. Stream tee + reconcile, OR buffered JSON path ─────────────────────
    //
    // Both are terminal. Once the provider has started answering there is nothing
    // left to fail over from — the failover trigger is a response, before the
    // first byte of a body reaches the client.
    if (isStream && upstream.body) {
      const { stream, settled } = createUsageTransform(attemptProvider, usageProtocol);
      // The monitored transform settles exactly once on every ending — normal
      // close, client cancel, and a break in the provider's own stream.
      //
      // THE CLASSIFICATION KEYS ON AUTHORITATIVE TERMINAL USAGE, not merely a
      // usage-shaped event or clean EOF. Partial usage remains useful evidence,
      // but never turns a dispatched inference into a confirmed debit.
      //
      // What that fixes. This used to settle a broken stream with the partial
      // tally and log it `upstream_error` — and the authoritative checkpoint
      // counted only `ok` rows, so those tokens dropped straight back out of the
      // cap at the next cron. A stream that broke after delivering real content
      // was, in the end, free. Worse, a stream that closed PERFECTLY CLEANLY and
      // never reported usage at all — an OpenAI-shaped response whose client body
      // lacked `stream: true`, so `include_usage` was never injected, while the
      // streaming branch is chosen from the RESPONSE content-type — settled at
      // zero and logged `ok`. Neither is a measurement; both are absence of one.
      //
      // The zeros are the trap: a call that genuinely consumed nothing and a call
      // whose usage never reached us produce identical numbers. `sawUsage` is the
      // only thing that separates them, which is why it is carried out of the
      // parser rather than inferred here.
      //
      // AND THIS RETIRES A RACE. The status used to depend on `req.signal.aborted`
      // because one client disconnect fires two endings from the same event — the
      // platform cancels the body we returned (→ `cancel`) while req.signal aborts
      // the upstream fetch, whose body then errors under the reader (→ `error`) —
      // and first-to-settle won, so the same disconnect logged `ok` or
      // `upstream_error` depending on timing. Both endings now classify
      // identically, so there is no longer a race to lose: neither is a clean
      // close, so neither is a confirmed accounting, whichever arrives first.
      waitUntil(
        settled.then(({ usage, complete }) => {
          const confirmed = complete;
          return reconcile(
            usage,
            confirmed ? "ok" : "usage_unknown",
            confirmed ? "complete" : "usage_unknown"
          ).done;
        })
      );
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
    // WHETHER THE BODY WAS READ AT ALL is the question here — NOT whether it
    // contained usage. The two look similar and behave very differently.
    //
    // Buffered inference JSON is not complete merely because it parsed: absent
    // or malformed usage is unknown. `GET /v1/models` is the explicit zero-use
    // discovery exception, not a blanket JSON-zero rule.
    //
    // A stream is the opposite case, and that is why it classifies on
    // `sawUsage`: there, absence is confounded with truncation, and a stream cut
    // off before its usage event looks exactly like one that never had any.
    //
    // What IS uncertain here is a body we could not read. `upstream.json()`
    // falls back to `{}`, which then parses as zero usage and would settle at
    // nothing — for a 200 the provider has already done the work behind.
    let bodyReadable = true;
    const json = await upstream.json().catch(() => {
      bodyReadable = false;
      return {};
    });
    const usage = usageFromJson(attemptProvider, json, usageProtocol);
    const discovery = req.method === "GET" && isModelListingIndex(path);
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
      reconcile(
        usage,
        bodyReadable && (discovery || usage.complete) ? "ok" : "usage_unknown",
        bodyReadable && (discovery || usage.complete) ? "complete" : "usage_unknown"
      )
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
  // the next reserve, never after — settling DECRBYs `reserved` while the open
  // script INCRBYs it and compares the total against the cap, so a deferred
  // release lets the next attempt see a doubled reservation and get refused for
  // money it is not spending.
  //
  // THE ORDERING INVARIANT IS UNCHANGED BY THE OUTCOME SPLIT, and both branches
  // still depend on it. Say that plainly, because the split makes a NEW and
  // legitimate refusal look exactly like the old bug: after an `upstream_5xx` or
  // an `unreachable`, the failed attempt's estimate is now CHARGED rather than
  // released, so a tight budget can correctly refuse the fallback. That is the
  // system working — the first attempt may really have been billed — and the fix
  // is not to defer the settle or to delete this ordering. The test that pins
  // the ordering was mutation-tested precisely because asserting invocation
  // order alone still passes with the bug live (tests/proxy-failover.test.ts).
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
  const { principal, db, credentialToken } = authentication;
  const agentId = principal.agentId;
  const userId = principal.userId;
  const scopes = principal.scopes;
  const credentialUseId = crypto.randomUUID();
  const jti = principal.kind === "passport" ? principal.visaJti : credentialUseId;
  const reserveId = crypto.randomUUID();
  // The demo signs receipts on the same terms as the real path. The synthesized
  // reply is the ONLY fake thing here: which agent called, which gate answered,
  // what it cost and when are all real, and those are the only things a receipt
  // ever claims. Withholding one would make the demo misrepresent the product in
  // the one direction that matters — it is the only surface reachable without a
  // key, so for most people it is the only receipt they will ever see.
  const receiptId = crypto.randomUUID();
  // The caps AS THE CREDENTIAL CARRIES THEM. For a passport visa these are `bt`
  // and `bc`, minted when the visa was issued and authenticated ever since — so
  // on their own they are a snapshot up to a full visa lifetime old. They are
  // the fallback below, not the answer: see S3-04.
  const visaCapTokens: number | null = principal.budgetTokens;
  const visaCapMicrocents: number | null =
    principal.budgetCents == null
      ? null
      : Math.round(Number(principal.budgetCents) * MICROCENTS_PER_CENT);
  // `principal.spentTokens` / `.spentMicrocents` — the visa's `st`/`sc` claims —
  // are deliberately READ BY NOTHING NOW. They used to seed the hot-path spend
  // counters, and that seed was a way to create capacity: the claims are minted
  // from `agents.spent_*`, a best-effort mirror lib/log.ts drops silently on RPC
  // failure, so a cold instance re-seeded from an older, lower number.
  //
  // The claims stay IN the visa — removing them is a visa-shape change and out
  // of scope here — they simply stop deciding anything. Authoritative spend now
  // comes from Redis, which is rebuilt from `agent_logs` when it has to be.

  let currentPolicySnapshot:
    | Awaited<ReturnType<typeof readCurrentAgentPolicyAndShadow>>
    | null = null;
  let passportAuthMethod: PassportAuthMethod = "passport";
  // Only ever set by observe mode. Rides to the audit row and stops there.
  let senderProofWould: SenderProofObservation | undefined;
  if (principal.kind === "passport") {
    currentPolicySnapshot = await readCurrentAgentPolicyAndShadow(db, userId, agentId);
    const senderConstraint = await enforceSenderConstraint(
      req,
      credentialToken,
      principal,
      currentPolicySnapshot
    );
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

  const policyFailClosed = process.env.POLICY_FAIL_CLOSED === "true";

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
  let policyRevision: string | undefined;

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
            policyRevision,
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
          ...(senderProofWould ? { senderProofWould } : {}),
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

  // 2. Kill switch (platform + tenant + denylist; per-agent suspend).
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

  // 3. Per-agent request-rate limit — AFTER the revocation gate, for the reason
  // spelt out on the real path: this counter mutates, so a refused call must not
  // spend the allowance the agent needs once the control is lifted.
  const rl = await rateLimit(`proxy:${agentId}`, PROXY_RATE_LIMIT, PROXY_RATE_WINDOW_S);
  if (!rl.success) {
    return new Response(JSON.stringify({ error: "rate_limited" }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": String(PROXY_RATE_WINDOW_S) },
    });
  }
  // Direct keys reach the policy read only after their unchanged rate limiter.
  currentPolicySnapshot ??= await readCurrentAgentPolicyAndShadow(db, userId, agentId);

  // ── The caps that actually gate this call ──────────────────────────────────
  //
  // The live row wins over the credential's snapshot. Lowering a budget used to
  // do nothing to an outstanding passport visa for up to 15 minutes: `verifyVisa`
  // authenticated the stale `bt` perfectly, the proxy passed it straight to
  // `openHold`, and the atomic Lua enforced it exactly — atomicity protecting
  // the wrong number. Direct Agent Keys never had this, because their
  // authentication RPC returns the current row on every request.
  //
  // It rides the policy read that already happens on every call, so it costs no
  // round trip; the same read's cache is invalidated by `updateAgentBudgets`, so
  // the delay is bounded by that purge rather than by a visa lifetime.
  //
  // `known: false` — an older schema, an entry written before this field, a
  // failed read — keeps the credential's claim, which is exactly what shipped
  // before. An unknown must not become a new denial path, and must not become
  // "no cap" either.
  const liveBudget = currentPolicySnapshot.budget;
  const capTokens: number | null = liveBudget.known ? liveBudget.tokens : visaCapTokens;
  const capMicrocents: number | null = liveBudget.known
    ? liveBudget.cents == null
      ? null
      : Math.round(Number(liveBudget.cents) * MICROCENTS_PER_CENT)
    : visaCapMicrocents;
  policyRevision = effectiveLivePolicyRevision(
    currentPolicySnapshot.policy,
    scopes,
    { tokens: capTokens, microcents: capMicrocents },
    policyFailClosed
  );

  // Parse body (model + stream).
  // Same bound as the real path, and for the same reasons (CP-02). The demo is
  // keyless and synthesised, so there is no credential at stake here — but it is
  // the most reachable endpoint in the product, and an unbounded read is an
  // unbounded read.
  const bounded = await readBoundedBody(req, MAX_BODY_BYTES);
  if (!bounded.ok) return err(413, "payload_too_large");
  let bodyObj: any = {};
  const rawBody = bounded.text;
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
  const currentPolicyGate = await evaluateCurrentPolicyGate(
    db,
    userId,
    agentId,
    gateBase,
    { tokens: capTokens, microcents: capMicrocents },
    currentPolicySnapshot,
    policyFailClosed
  );
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
  const estimateMicrocents = demoCostMicrocents(estimate);
  // The demo goes through the SAME primitives as the real path — that is what
  // makes the budget and kill demos honest — so it opens a real hold and settles
  // it, rather than keeping a second, simpler accounting that could drift from
  // the one under test.
  const attemptId = crypto.randomUUID();
  const demoBudgetState =
    capTokens != null || capMicrocents != null ? currentPolicyGate.budgetState : undefined;
  const reserve = await openHold({
    agentId,
    attemptId,
    estimate,
    estimateMicrocents,
    capTokens,
    capMicrocents,
    provider: "demo",
    ...(model ? { model } : {}),
    ...(demoBudgetState ? { budgetState: demoBudgetState } : {}),
  });
  if (reserve.epochToPersist) {
    const epoch = reserve.epochToPersist;
    // THE SAME TWO-SIDED CONTRACT AS THE BILLED PATH: a matching durable
    // generation, or no answer. This used to capture-and-continue, on the
    // argument that the demo forwards to no provider and spends no money — true
    // of the provider bill, and beside the point. The demo opens and settles a
    // REAL hold against the SAME counters, deliberately, because that is what
    // makes the budget and kill demos honest. Those counters are fenced by this
    // generation: answer without it, lose Redis later, and Postgres still says
    // "never established", so the next call seeds at zero and the agent's whole
    // spend is gone with its budget restored.
    //
    // It was survivable only while a demo-scoped agent could not also hold a
    // real provider scope — and that was true only because the control plane
    // rejected the pair outright, which is the bug that broke `passcontrol
    // login` for nine days. Now that it accepts them, one `budget_epoch` fences
    // demo calls and billed calls alike, and the laxer path would be the one an
    // attacker picks: it is the call that costs them nothing to make.
    //
    // The availability objection is weaker than it looks. This path already
    // returns 503 `blocked_budget_state` on the sibling condition below, and it
    // already blocks on database reads for the policy gate — a gateway that
    // cannot write cannot honestly demo governance either. One write, on the
    // first budgeted call of an agent's life.
    try {
      await establishBudgetState(agentId, epoch);
    } catch (error) {
      // Nothing was synthesized — this returns above the response — so the one
      // full release is the honest ending. Scheduled, not awaited: a failed
      // release leaves an open hold, which an operator can resolve, while a
      // slower 503 is not better than a fast one.
      waitUntil(releaseUndispatched({ agentId, attemptId }));
      waitUntil(
        captureError(error, {
          route: "api.demo",
          method: req.method,
          status: 503,
          agentId,
          code: "blocked_budget_state",
        })
      );
      logBlocked("blocked_budget_state", model, 503);
      return errR(503, "blocked_budget_state");
    }
    // Stays scheduled: it bounds how long a stale `established: false` can be
    // read from cache, but the answer does not depend on it and a failed purge
    // must not refuse a call whose epoch is already durable.
    waitUntil(purgeAgentPolicy(userId, agentId));
  }
  if (!reserve.ok && reserve.reason === "state") {
    logBlocked("blocked_budget_state", model, 503);
    return errR(503, "blocked_budget_state");
  }
  const finalGate = evaluateGate({
    ...gateBase,
    policy: currentPolicyGate.policy,
    policyFailClosed: process.env.POLICY_FAIL_CLOSED === "true",
    ...(currentPolicyGate.policyRateLimit
      ? { policyRateLimit: currentPolicyGate.policyRateLimit }
      : {}),
    budget: {
      ok: reserve.ok,
      // Cap reasons only; `state` was answered above. Same narrowing as the real
      // path, for the same reason.
      ...(reserve.reason === "tokens" || reserve.reason === "cost"
        ? { reason: reserve.reason }
        : {}),
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
  const cost = demoCostMicrocents(totalTokens);

  waitUntil(
    (async () => {
      // Settle the hold FIRST and keep its promise — the same ordering rule as
      // reconcile() on the real path. Built inline in the array below, a throw
      // while assembling the writeLog argument would destroy the array before
      // the hold was ever settled, leaving the reservation open indefinitely and
      // quietly shrinking the agent's budget until someone resolved it by hand.
      //
      // `settleKnown`, because the demo response is synthesised HERE: its usage
      // is not a report from anywhere that could have gone missing. This is the
      // one place in the product where a complete accounting is certain by
      // construction.
      const budget = settleKnown({
        agentId,
        attemptId,
        tokens: totalTokens,
        microcents: cost,
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
        policyRevision: currentPolicyGate.liveRev,
        owner: await currentOwner(),
      });

      return Promise.all([
        budget,
        writeLog({
          id: receiptId,
          receipt,
          agentId,
          userId,
          // Carried for the same reason as the real path, even though a demo
          // attempt is settled synchronously here and does not leave open holds
          // today. An unlinked row is one the dedup cannot see.
          attemptId,
          ...logIdentity,
          provider: "demo",
          model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          costMicrocents: cost,
          status: "ok",
          latencyMs: Date.now() - started,
          ...(shadowWould ? { policyShadowWould: shadowWould } : {}),
          ...(senderProofWould ? { senderProofWould } : {}),
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
