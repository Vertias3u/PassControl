// Bet D — a WORKER exchanges a signed delegation for a visa (plans/delegation-design.md
// §5, §13; owner-approved 2026-10-10).
//
// POST /api/auth/delegated
// body: { payload: base64url(JSON{passport_id, ts, nonce}), signature: base64url,
//         chain: string[] }
//
// `passport_id` in the challenge is the WORKER's key (the chain's leaf `sub`), and the
// signature is made by it: the delegation token alone does nothing. The chain is checked
// against the agent's passport and its CURRENT scope, revocation is read from Postgres
// and fails closed, each link's first exchange is recorded, and the visa (ver 3) can
// only narrow: capability grants are never applied here.
//
// A separate route rather than a branch of /api/auth/challenge, so that route, which
// every agent depends on, is untouched by this one.
export const runtime = "edge";

import { waitUntil } from "@vercel/functions";
import { NextResponse } from "next/server";
import { base64urlToBytes, bytesToUtf8 } from "@/lib/encoding";
import { passportIdToPublicKey, verifySignature } from "@/lib/crypto/ed25519";
import { claimNonce, touchLastSeen } from "@/lib/state/redis";
import { serviceClient } from "@/lib/supabase";
import { mintDelegatedVisa, type ScopeEntry } from "@/lib/auth/visa";
import { findAuthenticatablePassport } from "@/lib/auth/passport";
import { rateLimit } from "@/lib/ratelimit";
import { captureError, captureSecurityEvent, logFailOpen } from "@/lib/observability";
import { AUTH_HMAC_LABELS, authHmacKey } from "@/lib/crypto/derived-auth-hmac";
import { passportSourceFingerprint } from "@/lib/passport-source-observation";
import { instanceIssuer } from "@/lib/crypto/instanceKey";
import { DELEGATION_MAX_DEPTH, delegationRootHint, verifyDelegationChain } from "@/lib/delegation/chain";
import { delegationRecordRevokes, readDelegationRecord, recordFirstExchanges } from "@/lib/delegation/store";
import { createDelegationLedger } from "@/lib/state/holds";

const ROUTE = "api.auth.delegated";
// The challenge route's window and nonce lifetime, deliberately the same.
const SKEW_MS = 90_000;
const NONCE_TTL_S = 180;
// A challenge plus at most two links of at most 8 KiB each.
const MAX_BODY_BYTES = 24 * 1024;
const MAX_LINK_CHARS = 8192;
const EXCHANGE_LIMIT = 20;
const EXCHANGE_WINDOW_S = 60;

let rateLimitHmacKey: Promise<CryptoKey> | null = null;

function fail(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

function securityFail(status: number, error: string, detail: { agentId?: string; reason?: string } = {}) {
  waitUntil(
    captureSecurityEvent(`delegated.${detail.reason ?? error}`, {
      route: ROUTE,
      method: "POST",
      status,
      code: error,
      agentId: detail.agentId,
    })
  );
  return fail(status, error);
}

export async function POST(req: Request) {
  try {
    return await handlePost(req);
  } catch (error) {
    waitUntil(captureError(error, { route: ROUTE, method: "POST", status: 500, code: "internal_error" }));
    return fail(500, "internal_error");
  }
}

async function handlePost(req: Request) {
  // 0. Per-IP limit before any work, keyed by a keyed hash as the challenge's is.
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
  let fingerprint: string | null = null;
  try {
    rateLimitHmacKey ??= authHmacKey(AUTH_HMAC_LABELS.challengeRateLimit);
    fingerprint = await passportSourceFingerprint("delegated-rate-limit", ip, await rateLimitHmacKey);
  } catch {
    logFailOpen("ratelimit");
  }
  const rl = fingerprint
    ? await rateLimit(`delegated:${fingerprint}`, EXCHANGE_LIMIT, EXCHANGE_WINDOW_S)
    : { success: true, remaining: EXCHANGE_LIMIT };
  if (!rl.success) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "retry-after": String(EXCHANGE_WINDOW_S) } });
  }

  // 1. Bounded JSON before anything is parsed or verified.
  if (!(req.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
    return fail(415, "unsupported_media_type");
  }
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return fail(413, "payload_too_large");
  let body: { payload?: unknown; signature?: unknown; chain?: unknown };
  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) return fail(413, "payload_too_large");
    body = JSON.parse(raw);
  } catch {
    return fail(400, "invalid_json");
  }
  if (typeof body.payload !== "string" || typeof body.signature !== "string") return fail(400, "missing_fields");
  const chain = body.chain;
  if (
    !Array.isArray(chain) ||
    chain.length < 1 ||
    chain.length > DELEGATION_MAX_DEPTH ||
    !chain.every((c) => typeof c === "string" && c.length <= MAX_LINK_CHARS)
  ) {
    return fail(400, "invalid_delegation");
  }

  let payload: { passport_id?: unknown; ts?: unknown; nonce?: unknown };
  try {
    payload = JSON.parse(bytesToUtf8(base64urlToBytes(body.payload)));
  } catch {
    return fail(400, "invalid_payload");
  }
  if (typeof payload.passport_id !== "string" || typeof payload.nonce !== "string" || typeof payload.ts !== "number") {
    return fail(400, "invalid_payload");
  }
  const workerKey = payload.passport_id;

  // 2–3. Clock, then the nonce, before any database work.
  if (Math.abs(Date.now() - payload.ts) > SKEW_MS) return securityFail(401, "stale_timestamp");
  if (!(await claimNonce(payload.nonce, NONCE_TTL_S))) return securityFail(401, "replay_detected");

  // 4. The worker's proof of its key: the challenge signed by the key it names. The
  // token alone does nothing (design §2: a thief of the token only).
  const workerPublicKey = passportIdToPublicKey(workerKey);
  let signed = false;
  try {
    signed = Boolean(workerPublicKey) && verifySignature(base64urlToBytes(body.signature), base64urlToBytes(body.payload), workerPublicKey!);
  } catch {
    signed = false;
  }
  if (!signed) return securityFail(401, "invalid_delegation", { reason: "worker_signature" });

  // 5. This instance's issuer is every link's audience. Without one, no chain can be
  // checked, so delegation is simply unavailable here.
  const audience = instanceIssuer();
  if (!audience) return fail(503, "delegation_unavailable");

  // 6. The agent, by link 1's issuer, through the challenge's own lookup: status,
  // expiry and the rotated-key grace window. A link signed by a retired key dies when
  // that key's grace closes. Only a passport agent can be found this way, so a Direct
  // Agent Key agent cannot delegate.
  const rootId = delegationRootHint(chain);
  if (!rootId) return securityFail(401, "invalid_delegation", { reason: "root" });
  const db = serviceClient();
  const found = await findAuthenticatablePassport(
    db,
    rootId,
    "id, user_id, status, allowed_scopes, budget_tokens, budget_cents, spent_tokens, spent_microcents"
  );
  if (!found.ok) {
    if (found.code === "lookup_failed") return fail(500, "lookup_failed");
    return securityFail(found.status, found.code, { agentId: found.agentId });
  }
  const agent = found.agent;

  // 7. The chain, against the agent as it stands NOW. Checking it against the current
  // scope is what makes the visa's scope the leaf's ∩ the agent's: every link may only
  // narrow, so the leaf is inside the current scope or the chain is refused.
  const currentScope = Array.isArray(agent.allowed_scopes) ? (agent.allowed_scopes as ScopeEntry[]) : [];
  const expiresAt = typeof agent.expires_at === "string" ? Date.parse(agent.expires_at) : NaN;
  const verdict = verifyDelegationChain({
    chain,
    root: {
      passportId: rootId,
      scope: currentScope,
      expiresAtSeconds: Number.isFinite(expiresAt) ? Math.floor(expiresAt / 1000) : null,
    },
    audience,
    nowSeconds: Math.floor(Date.now() / 1000),
  });
  if (!verdict.ok) return securityFail(401, "invalid_delegation", { agentId: agent.id, reason: verdict.reason });
  if (verdict.leaf.sub !== workerKey) return securityFail(401, "invalid_delegation", { agentId: agent.id, reason: "leaf_key" });

  // 8. Revocation, from the record (P2.3: fails closed).
  const links = verdict.links;
  try {
    const record = await readDelegationRecord(db, agent.id, links.map((l) => l.jti));
    if (delegationRecordRevokes(record, links)) return securityFail(403, "delegation_revoked", { agentId: agent.id });
  } catch {
    waitUntil(captureError(new Error("delegation record unreadable"), { route: ROUTE, method: "POST", status: 503, code: "delegation_state_unavailable", agentId: agent.id }));
    return fail(503, "delegation_state_unavailable");
  }

  // 9. First exchange of each link, then its ledger, ONLY for the rows this call
  // created. A failure in between leaves a recorded link with no ledger, which the
  // proxy refuses until the link expires: closed, never a ledger reset to zero.
  try {
    const created = await recordFirstExchanges(
      db,
      links.map((l, i) => ({
        userId: agent.user_id as string,
        agentId: agent.id,
        jti: l.jti,
        depth: l.dep,
        parentJti: i === 0 ? null : links[i - 1]!.jti,
        workerKey: l.sub,
        capMicrocents: l.cap,
        scope: l.scope,
        iat: l.iat,
        exp: l.exp,
      }))
    );
    for (const l of links) {
      if (created.includes(l.jti)) await createDelegationLedger(agent.id, l.jti, l.exp);
    }
  } catch {
    waitUntil(captureError(new Error("delegation exchange record failed"), { route: ROUTE, method: "POST", status: 503, code: "delegation_state_unavailable", agentId: agent.id }));
    return fail(503, "delegation_state_unavailable");
  }

  // 10. The visa: the leaf's scope only, the parent's budgets (they still apply to the
  // whole tree), every link's cap, never outliving the leaf.
  const jti = crypto.randomUUID();
  const { token, expSeconds } = await mintDelegatedVisa({
    passportId: rootId,
    agentId: agent.id,
    userId: agent.user_id as string,
    jti,
    scope: verdict.leaf.scope,
    budgetTokens: agent.budget_tokens == null ? null : Number(agent.budget_tokens),
    budgetCents: agent.budget_cents == null ? null : Number(agent.budget_cents),
    spentTokens: Number(agent.spent_tokens ?? 0),
    spentMicrocents: Number(agent.spent_microcents ?? 0),
    actor: workerKey,
    delegationJti: verdict.leaf.jti,
    depth: verdict.leaf.dep,
    chainHash: verdict.chainHash,
    links: links.map((l) => ({ dlg: l.jti, cap: l.cap, iat: l.iat, exp: l.exp })),
  });
  await touchLastSeen(agent.id);

  return NextResponse.json({
    visa: token,
    token_type: "Bearer",
    expires_in: expSeconds,
    jti,
    delegation: { jti: verdict.leaf.jti, cap_microcents: verdict.leaf.cap, expires_at: verdict.leaf.exp },
  });
}
