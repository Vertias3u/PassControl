// Authentication for every data-plane route: the passport visa door and the
// Direct Agent Key door, sender-proof enforcement, and the helpers they share.
//
// Moved verbatim out of app/api/v1/[provider]/[...path]/route.ts so the service
// route (app/api/v1/svc/...) authenticates through exactly the same code rather
// than a second copy that could drift. Nothing here knows which destination a
// call is for: `provider` and `route` are used only for logging.
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
import { claimNonce, touchLastSeen, flagPassportSecretExposed } from "@/lib/state/redis";
import { passportIdIfSecret } from "@/lib/auth/passport-secret-detect";
import type { readCurrentAgentPolicyAndShadow } from "@/lib/state/policy";
import { serviceClient } from "@/lib/supabase";
import type { AuthMethod } from "@/lib/log";
import type { SenderProofObservation } from "@/lib/sender-constraint";
import { rateLimitFailClosed } from "@/lib/ratelimit";
import { captureError, captureSecurityEvent } from "@/lib/observability";
import { err, errMessage } from "@/lib/gateway/responses";

// This fires BEFORE a random pc_agent_ credential can cost a Supabase lookup.
// Unlike the passport challenge limiter, Redis failure closes this edge: its
// purpose is protecting the shared database from unauthenticated work.
const DIRECT_KEY_IP_LIMIT = Number(process.env.DIRECT_KEY_IP_LIMIT ?? "60");
const DIRECT_KEY_IP_WINDOW_S = Number(process.env.DIRECT_KEY_IP_WINDOW_S ?? "60");
// C2: FAILED visa authentications per client IP. Counted only on failure, so it
// never throttles valid traffic; it bounds the security events and the C1
// lookup an unauthenticated flood would otherwise buy.
const VISA_FAIL_IP_LIMIT = Number(process.env.VISA_FAIL_IP_LIMIT ?? "60");
const VISA_FAIL_IP_WINDOW_S = Number(process.env.VISA_FAIL_IP_WINDOW_S ?? "60");

type ServiceDatabase = ReturnType<typeof serviceClient>;

export type PassportPrincipal = {
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

export type GatewayPrincipal = PassportPrincipal | DirectKeyPrincipal;
export type VisaScope = { provider: string; models: string[] };

export type GatewayAuthentication =
  | { ok: true; principal: GatewayPrincipal; db: ServiceDatabase; credentialToken: string }
  | { ok: false; response: Response };

export type PassportAuthMethod = Exclude<AuthMethod, "direct_key">;

export type SenderConstraintResult =
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
export type SenderProofEvaluation =
  | { verdict: SenderProofObservation }
  | { verdict: "unavailable" };

export async function evaluateSenderProof(
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

export async function enforceSenderConstraint(
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

export function clientIp(req: Request): string {
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
export function stampLastSeen(agentId: string): void {
  try {
    waitUntil(Promise.resolve(touchLastSeen(agentId)).catch(() => undefined));
  } catch {
    // Deliberately empty — see above.
  }
}

/**
 * Whether the durable record says this agent is suspended.
 *
 * Only a Direct Agent Key carries it: its lookup reads `agents.status` on every
 * call. It is OR-ed with the Redis flag at every revocation read, so either
 * record of a suspension refuses on its own — Redis is the hot-path copy and can
 * be lost; the row is the one an operator's suspend always leaves behind.
 */
export function principalSuspended(principal: GatewayPrincipal): boolean {
  // Strictly boolean, never `undefined`: to `evaluateGate`, `suspended:
  // undefined` means "not read yet", which marks the chain pending and skips
  // scope, policy and budget — and a skipped chain has no `deniedBy`. A
  // principal that somehow lacked this field must not switch enforcement off.
  return principal.kind === "direct_key" && principal.suspended === true;
}

/**
 * The agent whose CURRENT passport key is `passportId`, or null — including on
 * any read failure, because this only decides between two 401 bodies. Current
 * keys are globally unique (0035), so more than one row is treated as none.
 */
export async function findAgentByPassportId(passportId: string): Promise<string | null> {
  try {
    const { data, error } = await serviceClient()
      .from("agents")
      .select("id")
      .eq("passport_pubkey", passportId)
      .limit(2);
    if (error || !Array.isArray(data) || data.length !== 1) return null;
    const id = (data[0] as { id?: unknown }).id;
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}

/** Authenticate either door without letting one format fall through to the other. */
export async function authenticateGatewayRequest(
  req: Request,
  provider: string,
  // The observability route label. Each data-plane route passes its own, so a
  // security event says which door it was raised at.
  route: string = "api.proxy",
  // Also read `Authorization: token <x>`, after Bearer and x-api-key. The
  // service route only: it is what GitHub's own clients send.
  options: { tokenScheme?: boolean } = {}
): Promise<GatewayAuthentication> {
  // extractVisaToken is intentionally still the one header-precedence source:
  // Authorization Bearer wins over x-api-key, including when they carry
  // different credential classes.
  const token = extractVisaToken(req.headers, { tokenScheme: options.tokenScheme === true });
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
          route,
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
            route,
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
          route,
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
    // C2. The Direct Agent Key door is limited before any work; this one only
    // after a verification FAILS, so a valid visa is never counted or throttled
    // here (it has its per-agent limit). What is bounded is the unauthenticated
    // work a failure triggers: a security event, and the C1 lookup below.
    // Fail closed, like the direct-key edge: an unreadable counter must not
    // license unbounded database work. The answer itself does not change — an
    // invalid visa is a 401 whether or not Redis is up.
    const failures = await rateLimitFailClosed(
      `visa-fail-ip:${clientIp(req)}`,
      VISA_FAIL_IP_LIMIT,
      VISA_FAIL_IP_WINDOW_S
    );
    if (!failures.success && !failures.unreadable) {
      return {
        ok: false,
        response: new Response(JSON.stringify({ error: "rate_limited" }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": String(VISA_FAIL_IP_WINDOW_S) },
        }),
      };
    }
    // C1. A Passport SECRET pasted into a client's API-key field arrives here.
    // Deriving its public key and finding it on an agent is proof, not a guess,
    // that this agent's private key was just transmitted. Never echo or log the
    // token; name the agent. Detection only — the key is already exposed.
    const exposedPassportId = failures.success ? passportIdIfSecret(credential.token) : null;
    if (exposedPassportId) {
      const exposed = await findAgentByPassportId(exposedPassportId);
      if (exposed) {
        waitUntil(
          Promise.all([
            captureSecurityEvent("proxy.passport_secret_presented", {
              route,
              method: req.method,
              status: 401,
              provider,
              agentId: exposed,
              code: "passport_secret_presented_as_bearer",
            }),
            // Deferred so even a synchronous throw (redis() constructing its
            // client) cannot turn this 401 into a 500 — same guard as stampLastSeen.
            Promise.resolve()
              .then(() => flagPassportSecretExposed(exposed, exposedPassportId))
              .catch(() => undefined),
          ])
        );
        return {
          ok: false,
          response: errMessage(
            401,
            "passport_secret_presented_as_bearer",
            "This token is an agent's PRIVATE passport key, not an API key. Treat it as exposed: rotate that agent's passport now. A client that can only send a static API key needs a Direct Agent Key, or the local passport sidecar."
          ),
        };
      }
    }
    waitUntil(
      captureSecurityEvent("proxy.invalid_visa", {
        route,
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
