// Flow B — challenge-response: an agent signs a canonical payload with its
// passport private key and receives a short-lived work visa.
//
// POST /api/auth/challenge
// body: { payload: base64url(JSON{passport_id, ts, nonce}), signature: base64url }
export const runtime = "edge";

import { NextResponse } from "next/server";
import { base64urlToBytes, bytesToUtf8 } from "@/lib/encoding";
import { verifySignature, passportIdToPublicKey } from "@/lib/crypto/ed25519";
import { claimNonce, touchLastSeen } from "@/lib/state/redis";
import { serviceClient } from "@/lib/supabase";
import { mintVisa, type ScopeEntry } from "@/lib/auth/visa";
import { rateLimit } from "@/lib/ratelimit";

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
  // 0. Rate limit by client IP before any work — cheapest possible rejection.
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";
  const rl = await rateLimit(`challenge:${ip}`, CHALLENGE_LIMIT, CHALLENGE_WINDOW_S);
  if (!rl.success) {
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
    return fail(413, "payload_too_large");
  }
  let body: { payload?: string; signature?: string };
  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) return fail(413, "payload_too_large");
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
  if (Math.abs(Date.now() - payload.ts) > SKEW_MS) return fail(401, "stale_timestamp");

  // 3. Burn the nonce (replay protection). Must precede expensive work.
  if (!(await claimNonce(payload.nonce, NONCE_TTL_S))) return fail(401, "replay_detected");

  // 4. Look up the agent by passport.
  const db = serviceClient();
  const { data: agent, error } = await db
    .from("agents")
    .select("id, user_id, status, allowed_scopes, budget_tokens, budget_cents, spent_tokens")
    .eq("passport_pubkey", payload.passport_id)
    .maybeSingle();
  if (error) return fail(500, "lookup_failed");
  if (!agent) return fail(401, "unknown_passport");
  if (agent.status !== "active") return fail(403, "agent_not_active");

  // 5. Verify the Ed25519 signature over the raw payload bytes.
  const pubkey = passportIdToPublicKey(payload.passport_id);
  if (!pubkey) return fail(400, "bad_passport_id");
  const ok = verifySignature(
    base64urlToBytes(body.signature),
    base64urlToBytes(body.payload),
    pubkey
  );
  if (!ok) return fail(401, "bad_signature");

  // 6. Mint the visa.
  const jti = crypto.randomUUID();
  const scope = (agent.allowed_scopes as ScopeEntry[]) ?? [];
  const { token, expSeconds } = await mintVisa({
    passportId: payload.passport_id,
    agentId: agent.id,
    userId: agent.user_id,
    jti,
    scope,
    budgetTokens: agent.budget_tokens == null ? null : Number(agent.budget_tokens),
    budgetCents: agent.budget_cents == null ? null : Number(agent.budget_cents),
    spentTokens: Number(agent.spent_tokens ?? 0),
  });

  // Coalesced last-seen (flushed to Postgres by the reconcile cron).
  await touchLastSeen(agent.id);

  return NextResponse.json({ visa: token, token_type: "Bearer", expires_in: expSeconds, jti });
}
