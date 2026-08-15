// Signed call receipts — the artifact a third party can verify without us.
//
// Every proxied call can produce a detached EdDSA JWS binding: which passport
// made it, under which visa, to which provider and model, what the gateway
// decided, what it cost, and a SHA-256 digest of the request the client sent.
// A holder verifies it offline against the JWK published at
// /.well-known/jwks.json — no account here, no callback, and it still verifies
// after this deployment is gone.
//
// ── What a receipt does NOT claim ────────────────────────────────────────────
//
// 1. It binds the REQUEST, not the response. The digest covers the bytes the
//    client sent; nothing here attests to what came back. (Response digests are
//    a clean later addition — createUsageTransform already sees every chunk —
//    but "the response" on a cancelled SSE stream needs its own definition.)
//
// 2. The digest covers what the CLIENT sent, not what the gateway forwarded.
//    Those differ: the proxy injects stream_options.include_usage for
//    OpenAI-shaped streams and re-serialises. Digesting the client's bytes is
//    the deliberate choice — the verifier is the party holding those bytes.
//
// 3. The claim is ONE-DIRECTIONAL. A receipt proves a call happened; the
//    absence of one proves nothing. writeLog is best-effort by design: after
//    two failed inserts it gives up with a captureError (lib/log.ts), so a
//    database outage loses the row and the receipt with it.
import { sha256 } from "@noble/hashes/sha256";

import { bytesToBase64url, utf8ToBytes } from "./encoding";
import { instanceIssuer, loadInstanceSigner } from "./crypto/instanceKey";
import { RECEIPT_TYP, signCompactJws } from "./crypto/jws";
import type { LogEntry } from "./log";

/**
 * Additive-only. A verifier accepts `ver <= its own` and ignores claims it does
 * not recognise.
 *
 * Deliberately NOT the strict `ver !== VISA_VER` equality verifyVisa uses. That
 * is right for a visa: the same gateway mints and verifies it, so both sides
 * move together. A receipt is verified by third parties running code we do not
 * control and cannot upgrade — adding a claim must not invalidate every
 * verifier in the field.
 */
export const RECEIPT_VER = 2;

export interface OwnerClaim {
  kind: string;
  sub: string;
  tier: string;
  vat: string | null;
}

interface ReceiptInputBase {
  receiptId: string;
  agentId: string;
  provider: string;
  model?: string;
  method: string;
  path: string;
  // null when the gateway refused before it read the body — the revocation gate
  // runs first, deliberately. `req` is then omitted rather than reported as a
  // digest of "", which would read as "the client sent an empty body".
  rawBody: string | null;
  inputTokens: number;
  outputTokens: number;
  costMicrocents: number;
  status: LogEntry["status"];
  httpStatus: number;
  startedAt: number;
  // The WHOLE request, not the gateway's own overhead: every caller computes it
  // as `Date.now() - started` where `started` is the top of the handler, and the
  // success path evaluates it inside reconcile() — which runs in waitUntil,
  // after the response is already with the client. So it spans the pre-checks,
  // the provider call, and some post-response bookkeeping. On an approved call
  // the provider dominates it completely. Never render this as "gateway
  // latency"; that reads as overhead we added. tests/public-receipt-page pins it.
  latencyMs: number;
  owner?: OwnerClaim | null;
  /**
   * Set only on an attempt that followed a failed one. Two receipts, never one
   * compound object: a receipt binds ONE call to ONE provider decision, and an
   * attempt list would make it a compound artifact every verifier — SDK, CLI,
   * public page — has to learn to render.
   *
   * The link is explicit rather than inferred. Both attempts share a `req`
   * digest, because that digest covers the client's bytes and those do not
   * change between attempts — but matching two receipts by a shared digest is a
   * guess, not a link.
   */
  previousReceiptId?: string | null;
  /** Why the gateway moved on. Allowlisted; see FailoverReason. */
  failoverReason?: string | null;
}

type PassportReceiptIdentity = {
  authMethod?: "passport";
  passportId: string;
  visaJti: string;
  agentAccessKeyId?: never;
  credentialUseId?: never;
};

type DirectKeyReceiptIdentity = {
  authMethod: "direct_key";
  passportId?: never;
  visaJti?: never;
  agentAccessKeyId: string;
  credentialUseId: string;
};

export type ReceiptInput = ReceiptInputBase &
  (PassportReceiptIdentity | DirectKeyReceiptIdentity);

export interface RequestDigest {
  alg: "sha-256";
  dig: string;
  len: number;
}

/** SHA-256 over the exact bytes the client sent. `len` is bytes, not characters. */
export function requestDigest(rawBody: string): RequestDigest {
  const bytes = utf8ToBytes(rawBody ?? "");
  return { alg: "sha-256", dig: bytesToBase64url(sha256(bytes)), len: bytes.length };
}

export function buildReceiptClaims(input: ReceiptInput): Record<string, unknown> {
  const claims: Record<string, unknown> = {
    iss: instanceIssuer(),
    sub: input.authMethod === "direct_key" ? input.agentId : input.passportId,
    jti: input.receiptId,
    iat: Math.floor(Date.now() / 1000),
    agid: input.agentId,
    prov: input.provider,
    mdl: input.model ?? null,
    mth: input.method,
    path: input.path,
    use: { in: input.inputTokens, out: input.outputTokens },
    cost: Math.round(input.costMicrocents),
    res: { status: input.status, http: input.httpStatus },
    t0: input.startedAt,
    lat: input.latencyMs,
    // Passport receipts remain version 1 and retain their exact identity
    // claims. Version 2 exists specifically to say that a bearer Direct Agent
    // Key — not a passport signature — authenticated this call.
    ver: input.authMethod === "direct_key" ? RECEIPT_VER : 1,
  };
  if (input.authMethod === "direct_key") {
    claims.auth = {
      kind: "direct_key",
      kid: input.agentAccessKeyId,
      use: input.credentialUseId,
    };
  } else {
    claims.vjti = input.visaJti;
  }
  // Omitted when the gateway refused before reading the body. Absent means
  // "never read"; a digest of "" would mean "the client sent nothing".
  if (input.rawBody !== null && input.rawBody !== undefined) {
    claims.req = requestDigest(input.rawBody);
  }
  // Present only once an owner is bound and published (Phase 2). Omitted rather
  // than null so a receipt from a deployment with no owner binding is not
  // mistaken for one that deliberately withheld it.
  if (input.owner) claims.own = input.owner;
  // Additive and optional, so `ver` stays 1: a verifier already in the field
  // ignores claims it does not recognise (sdk/verify.ts), and bumping the version
  // would invalidate every one of them for a feature they do not need to
  // understand. Omitted rather than null on a call that never failed over, so
  // their presence alone means "this attempt followed another".
  if (input.previousReceiptId) claims.prev = input.previousReceiptId;
  if (input.failoverReason) claims.why = input.failoverReason;
  return claims;
}

/**
 * Sign a receipt, or return null.
 *
 * NEVER THROWS. This is called inline while building the writeLog argument
 * inside the proxy's reconcile() — a throw there takes out the whole tasks
 * array, so the budget reservation is never reconciled and the audit row is
 * never written. A missing receipt is a degraded artifact; a missing reconcile
 * is a silently shrinking budget. tests/receipt.test.ts pins this.
 */
export function signReceipt(input: ReceiptInput): string | null {
  try {
    const signer = loadInstanceSigner();
    if (!signer) return null;
    // An unverifiable `iss` is worse than no receipt: it looks authoritative and
    // resolves to no key set.
    if (!instanceIssuer()) return null;
    return signCompactJws({
      typ: RECEIPT_TYP,
      kid: signer.kid,
      claims: buildReceiptClaims(input),
      seed: signer.seed,
    });
  } catch {
    return null;
  }
}
