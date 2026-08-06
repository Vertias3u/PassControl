// Agent-to-agent authentication — an agent proving who it is to someone who is
// not this gateway.
//
// POST /api/auth/agent-token
// body: { payload: base64url(JSON{passport_id, ts, nonce, aud, ttl?}), signature }
//
// ── Why this is not the visa ────────────────────────────────────────────────
//
// A work-visa is useless here for two independent reasons. It is HS256 over
// VISA_SECRET, so the only party who can verify one is a party who can also
// FORGE one; and its `aud` is the fixed constant "llm-proxy", because the proxy
// is its only intended audience. This mints an EdDSA token instead, signed by
// the deployment's instance key, verifiable OFFLINE by anyone holding the JWKS
// at /.well-known/jwks.json — no callback here, no shared secret, no account.
//
// ── Why a separate endpoint ─────────────────────────────────────────────────
//
// /api/auth/challenge's response shape is pinned by the SDK, the CLI, the
// examples and the tests; it is the drop-in contract and is not worth
// overloading. And the nonce burns before signature verification there (a
// deliberate ordering), so an agent wanting both artifacts signs twice over two
// nonces regardless — there is no round trip to save by merging them.
export const runtime = "edge";

import { waitUntil } from "@vercel/functions";
import { NextResponse } from "next/server";

import { base64urlToBytes, bytesToUtf8 } from "@/lib/encoding";
import { verifySignature, passportIdToPublicKey } from "@/lib/crypto/ed25519";
import { claimNonce, touchLastSeen } from "@/lib/state/redis";
import { serviceClient } from "@/lib/supabase";
import { instanceIssuer, loadInstanceSigner } from "@/lib/crypto/instanceKey";
import { AGENT_TOKEN_TYP, AGENT_TOKEN_VER, signCompactJws } from "@/lib/crypto/jws";
import { readCurrentOwner } from "@/lib/owner/current";
import { rateLimit } from "@/lib/ratelimit";
import { captureError, captureSecurityEvent } from "@/lib/observability";

const SKEW_MS = 90_000;
const NONCE_TTL_S = 180;
const MAX_BODY_BYTES = 8 * 1024;
const TOKEN_LIMIT = 20;
const TOKEN_WINDOW_S = 60;

/** Short by default. With offline verification, TTL is the primary revocation. */
const DEFAULT_TTL_S = 300;
const MIN_TTL_S = 60;
const MAX_TTL_S = 900;

const AUD_MAX = 256;
const AUD_RE = /^[A-Za-z0-9:/._-]+$/;

interface AgentTokenPayload {
  passport_id: string;
  ts: number;
  nonce: string;
  aud: string;
  ttl?: number;
}

function fail(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

function securityFail(status: number, error: string, context: { agentId?: string } = {}) {
  waitUntil(
    captureSecurityEvent(`agent_token.${error}`, {
      route: "api.auth.agent_token",
      method: "POST",
      status,
      code: error,
      agentId: context.agentId,
    })
  );
  return fail(status, error);
}

export async function POST(req: Request) {
  try {
    return await handlePost(req);
  } catch (error) {
    waitUntil(
      captureError(error, {
        route: "api.auth.agent_token",
        method: "POST",
        status: 500,
        code: "internal_error",
      })
    );
    return fail(500, "internal_error");
  }
}

async function handlePost(req: Request) {
  // Mirrors the challenge route's ordering exactly: IP limit → content-type →
  // body cap → parse → skew → burn nonce → agent → signature → mint.
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";
  const rl = await rateLimit(`agent-token:${ip}`, TOKEN_LIMIT, TOKEN_WINDOW_S);
  if (!rl.success) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "retry-after": String(TOKEN_WINDOW_S) } }
    );
  }

  if (!(req.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
    return fail(415, "unsupported_media_type");
  }
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

  let payload: AgentTokenPayload;
  try {
    payload = JSON.parse(bytesToUtf8(base64urlToBytes(body.payload)));
  } catch {
    return fail(400, "invalid_payload");
  }
  if (!payload.passport_id || !payload.nonce || typeof payload.ts !== "number") {
    return fail(400, "invalid_payload");
  }

  // The audience lives INSIDE the signed payload. This is the security-critical
  // shape: the agent cryptographically authorises which audience it is minting
  // for. An `aud` passed as a sibling of the signature could be swapped in
  // transit, turning a token meant for one counterparty into one for another.
  //
  // It is deliberately NOT checked against any allowlist. The gateway has no
  // business knowing, or approving, who an agent talks to.
  if (typeof payload.aud !== "string" || !payload.aud || payload.aud.length > AUD_MAX) {
    return fail(400, "invalid_audience");
  }
  if (!AUD_RE.test(payload.aud)) return fail(400, "invalid_audience");

  if (Math.abs(Date.now() - payload.ts) > SKEW_MS) return securityFail(401, "stale_timestamp");
  if (!(await claimNonce(payload.nonce, NONCE_TTL_S))) return securityFail(401, "replay_detected");

  // Checked after the nonce burn so a misconfigured deployment cannot be probed
  // more cheaply than a correctly configured one.
  const signer = loadInstanceSigner();
  const issuer = instanceIssuer();
  if (!signer || !issuer) return fail(501, "signing_not_configured");

  const db = serviceClient();
  const { data: agent, error } = await db
    .from("agents")
    .select("id, user_id, status")
    .eq("passport_pubkey", payload.passport_id)
    .maybeSingle();
  if (error) return fail(500, "lookup_failed");
  if (!agent) return securityFail(401, "unknown_passport");
  if (agent.status !== "active") {
    return securityFail(403, "agent_not_active", { agentId: agent.id });
  }

  const pubkey = passportIdToPublicKey(payload.passport_id);
  if (!pubkey) return securityFail(400, "bad_passport_id");
  const verified = verifySignature(
    base64urlToBytes(body.signature),
    base64urlToBytes(body.payload),
    pubkey
  );
  if (!verified) return securityFail(401, "bad_signature", { agentId: agent.id });

  const ttl = clampTtl(payload.ttl);
  const now = Math.floor(Date.now() / 1000);
  const jti = crypto.randomUUID();

  // Deliberately absent: uid, scope, budgets. Those are facts about this agent's
  // relationship with THIS proxy, and are nobody else's business. The token says
  // one thing: this agent, from this issuer, to this audience, right now, owned
  // by this party.
  const token = signCompactJws({
    typ: AGENT_TOKEN_TYP,
    kid: signer.kid,
    seed: signer.seed,
    claims: {
      iss: issuer,
      sub: payload.passport_id,
      aud: payload.aud,
      jti,
      iat: now,
      exp: now + ttl,
      agid: agent.id,
      own: await readCurrentOwner(db, agent.user_id),
      ver: AGENT_TOKEN_VER,
    },
  });

  await touchLastSeen(agent.id);

  return NextResponse.json({
    token,
    token_type: "Bearer",
    expires_in: ttl,
    jti,
    kid: signer.kid,
  });
}

function clampTtl(value: unknown): number {
  const raw = Number(value ?? DEFAULT_TTL_S);
  if (!Number.isFinite(raw)) return DEFAULT_TTL_S;
  return Math.min(MAX_TTL_S, Math.max(MIN_TTL_S, Math.floor(raw)));
}
