// Flow B — challenge-response: an agent signs a canonical payload with its
// passport private key and receives a short-lived work visa.
//
// POST /api/auth/challenge
// body: { payload: base64url(JSON{passport_id, ts, nonce}), signature: base64url }
export const runtime = "edge";

import { waitUntil } from "@vercel/functions";
import { NextResponse } from "next/server";
import { base64urlToBytes, bytesToUtf8 } from "@/lib/encoding";
import { verifySignature, passportIdToPublicKey } from "@/lib/crypto/ed25519";
import { claimNonce, touchLastSeen } from "@/lib/state/redis";
import { serviceClient } from "@/lib/supabase";
import { mintVisa, type ScopeEntry } from "@/lib/auth/visa";
import { findAuthenticatablePassport } from "@/lib/auth/passport";
import { readLiveGrant, unionScopes } from "@/lib/break-glass";
import { rateLimit } from "@/lib/ratelimit";
import { captureError, captureSecurityEvent } from "@/lib/observability";

const SKEW_MS = 90_000;
const NONCE_TTL_S = 180;
// The challenge payload (passport_id + ts + nonce + a signature) is tiny; cap the
// body hard so a giant request can't waste edge CPU/memory before validation.
const MAX_BODY_BYTES = 8 * 1024;
// Per-IP throttle on this unauthenticated endpoint (brute-force / cost-DoS guard).
// Generous for legit agents (visas last 5 min, so a fleet re-mints rarely); tune as needed.
const CHALLENGE_LIMIT = 20;
const CHALLENGE_WINDOW_S = 60;

interface ChallengePayload {
  passport_id: string;
  ts: number;
  nonce: string;
}

function fail(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

export async function POST(req: Request) {
  try {
    return await handlePost(req);
  } catch (error) {
    waitUntil(
      captureError(error, {
        route: "api.auth.challenge",
        method: "POST",
        status: 500,
        code: "internal_error",
      })
    );
    return fail(500, "internal_error");
  }
}

function securityFail(status: number, error: string, context: { agentId?: string } = {}) {
  waitUntil(
    captureSecurityEvent(`challenge.${error}`, {
      route: "api.auth.challenge",
      method: "POST",
      status,
      code: error,
      agentId: context.agentId,
    })
  );
  return fail(status, error);
}

async function handlePost(req: Request) {
  // 0. Rate limit by client IP before any work — cheapest possible rejection.
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";
  const rl = await rateLimit(`challenge:${ip}`, CHALLENGE_LIMIT, CHALLENGE_WINDOW_S);
  if (!rl.success) {
    waitUntil(
      captureSecurityEvent("challenge.rate_limited", {
        route: "api.auth.challenge",
        method: "POST",
        status: 429,
        code: "rate_limited",
      })
    );
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "retry-after": String(CHALLENGE_WINDOW_S) } }
    );
  }

  // Require JSON: reject anything that doesn't declare application/json rather
  // than parsing whatever arrives.
  if (!(req.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
    return fail(415, "unsupported_media_type");
  }
  // Enforce a body-size cap (Content-Length, then the actual bytes — a client can
  // lie about Content-Length).
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return securityFail(413, "payload_too_large");
  }
  let body: { payload?: string; signature?: string };
  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) return securityFail(413, "payload_too_large");
    body = JSON.parse(raw);
  } catch {
    return fail(400, "invalid_json");
  }
  if (!body.payload || !body.signature) return fail(400, "missing_fields");

  // 1. Decode + parse the canonical payload.
  let payload: ChallengePayload;
  try {
    payload = JSON.parse(bytesToUtf8(base64urlToBytes(body.payload)));
  } catch {
    return fail(400, "invalid_payload");
  }
  if (!payload.passport_id || !payload.nonce || typeof payload.ts !== "number") {
    return fail(400, "invalid_payload");
  }

  // 2. Clock-skew window.
  if (Math.abs(Date.now() - payload.ts) > SKEW_MS) return securityFail(401, "stale_timestamp");

  // 3. Burn the nonce (replay protection). Must precede expensive work.
  if (!(await claimNonce(payload.nonce, NONCE_TTL_S))) return securityFail(401, "replay_detected");

  // 4. Look up the agent by passport, and decide whether it may authenticate at
  // all — status, expiry, and (after a rotation) the retired key's deadline.
  // Shared with /api/auth/agent-token so the two doors cannot drift; see
  // lib/auth/passport.ts for why the two columns are matched sequentially and
  // why the stored key is deliberately not selected.
  const db = serviceClient();
  const found = await findAuthenticatablePassport(
    db,
    payload.passport_id,
    "id, user_id, status, allowed_scopes, budget_tokens, budget_cents, spent_tokens, spent_microcents"
  );
  if (!found.ok) {
    if (found.code === "lookup_failed") {
      waitUntil(
        captureError(new Error("challenge lookup failed"), {
          route: "api.auth.challenge",
          method: "POST",
          status: 500,
          code: "lookup_failed",
        })
      );
      return fail(500, "lookup_failed");
    }
    return securityFail(found.status, found.code, { agentId: found.agentId });
  }
  const agent = found.agent;

  // 5. Verify the Ed25519 signature over the raw payload bytes.
  //
  // Against the key the CALLER PRESENTED, which is the key the lookup matched
  // on — never against a field of the row. After a rotation both the current
  // and the retired key can match, and deriving from the row would accept the
  // old key forever or reject the new one. The helper cannot return the stored
  // key, so this stays true by construction.
  const pubkey = passportIdToPublicKey(payload.passport_id);
  if (!pubkey) return securityFail(400, "bad_passport_id");
  const ok = verifySignature(
    base64urlToBytes(body.signature),
    base64urlToBytes(body.payload),
    pubkey
  );
  if (!ok) return securityFail(401, "bad_signature", { agentId: agent.id });

  // 6. Mint the visa.
  //
  // The scope snapshot is the agent's stored capability UNION any live
  // break-glass grant. Three things about where this lives:
  //
  //  * It is HERE, not in findAuthenticatablePassport. /api/auth/agent-token
  //    shares that helper and deliberately carries no scope at all — an
  //    elevation must never leak into an identity assertion handed to a third
  //    party, who has no way to know it was temporary.
  //  * A failed read means NO ELEVATION, never an error and never an assumed
  //    one. readLiveGrant returns null on every failure path: an unreachable
  //    grants table must not be an outage for every agent, and a database blip
  //    must not be a privilege escalation.
  //  * It widens SCOPE only. The kill switch, suspend, policy and budget are all
  //    checked later, on a path that does not know this feature exists.
  //
  // Both paths run through unionScopes, including the no-grant one, so the claim
  // has ONE shape regardless of whether an elevation happened to be live. It is
  // an identity on a well-formed distinct-provider scope and cannot change what
  // the visa permits (scopeRuleMatch honours any matching row) — but
  // validateScopes allows `[openai:[a], openai:[b]]`, and a consumer reading one
  // row per provider (buildAlternatives takes models from the first match) would
  // otherwise see a narrower list on the common path than under an elevation.
  //
  // Array.isArray, not `?? []`: allowed_scopes is jsonb with no CHECK that it is
  // an array and the service-role client bypasses RLS. `?? []` catches null and
  // nothing else, so a non-array value used to mint a non-array claim that
  // verifyVisa then rejected on every call — while the grant path threw inside
  // unionScopes and 500'd the challenge. Same guard lib/fleet.ts applies at the
  // grant door.
  const jti = crypto.randomUUID();
  const stored = Array.isArray(agent.allowed_scopes) ? (agent.allowed_scopes as ScopeEntry[]) : [];
  const grant = await readLiveGrant(db, agent.user_id as string, agent.id);
  const scope = unionScopes(stored, grant?.scopes ?? []);
  if (grant) {
    // Every mint under an elevation is recorded. A grant is taken once; the
    // visas it produces are what actually reach the provider, and an incident
    // review needs to see how many there were.
    waitUntil(
      captureSecurityEvent("challenge.break_glass_minted", {
        route: "api.auth.challenge",
        method: "POST",
        status: 200,
        code: "break_glass_minted",
        agentId: agent.id,
      })
    );
  }
  const { token, expSeconds } = await mintVisa({
    // The key that actually authenticated, not the agent's current one. During
    // a grace window that may be the retired key, and the audit trail should
    // record which key was used — a retired key still in heavy use is exactly
    // what an operator needs to see to know the rotation has not landed.
    passportId: payload.passport_id,
    agentId: agent.id,
    userId: agent.user_id as string,
    jti,
    scope,
    budgetTokens: agent.budget_tokens == null ? null : Number(agent.budget_tokens),
    budgetCents: agent.budget_cents == null ? null : Number(agent.budget_cents),
    spentTokens: Number(agent.spent_tokens ?? 0),
    spentMicrocents: Number(agent.spent_microcents ?? 0),
  });

  // Coalesced last-seen (flushed to Postgres by the reconcile cron).
  await touchLastSeen(agent.id);

  return NextResponse.json({ visa: token, token_type: "Bearer", expires_in: expSeconds, jti });
}
