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

import { RECEIPT_PROTOCOL } from "@/cli/protocols.mjs";
import { bytesToBase64url, utf8ToBytes } from "./encoding";
import { instanceIssuer, loadInstanceSigner } from "./crypto/instanceKey";
import { RECEIPT_TYP, signCompactJws } from "./crypto/jws";
import type { LogEntry } from "./log";

/**
 * Additive-only. A verifier accepts `ver <= its own` and ignores claims it does
 * not recognise.
 *
 * Visa verification accepts only the current version and one explicitly named
 * migration predecessor; older versions remain invalid. A receipt is verified
 * by third parties running code we do not control and cannot upgrade, so its
 * additive range rule is deliberately broader.
 */
export const RECEIPT_VER = RECEIPT_PROTOCOL.maximum;

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
  /**
   * Prompt-cache traffic, when the provider reported any.
   *
   * `inputTokens` above stays exactly the provider's OWN `input_tokens` — the
   * uncached remainder — so a reader reconciling this receipt against an
   * Anthropic invoice finds the same number in both. These two name the rest of
   * the prompt, which is billed at different rates, so the whole input is
   * `inputTokens + cacheReadTokens + cacheWriteTokens` and `cost` already
   * accounts for all three.
   *
   * Note this convention differs on purpose from `agent_logs.input_tokens`,
   * which folds all three into one figure because the spend checkpoint sums that
   * column. Neither should be changed to match the other — see the fold comment
   * in the proxy's reconcile().
   */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costMicrocents: number;
  /**
   * True when nobody could price this call — it went to a custom endpoint, which
   * may mark up, re-route, alias onto a local model, or be free. `costMicrocents`
   * is then 0 because the type requires a number, and that 0 means NOTHING.
   * See `isPricedEndpoint` in lib/pricing.ts, which is where the decision is made.
   */
  unpriced?: boolean;
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
  /**
   * Revision of the effective live authorization rules evaluated for this
   * call: policy document, scopes, token/cost caps and unreadable-policy
   * posture. Optional only so callers can still parse and verify historical
   * receipts issued before this additive claim existed.
   */
  policyRevision?: string;
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
  authMethod?: "passport" | "passport_proof_per_request";
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
    // `cr` / `cw` are added only when the provider reported cache traffic, so a
    // receipt for an uncached call is byte-identical to one issued before these
    // existed. `ver` deliberately does NOT move for them: the SDK verifier
    // refuses an artifact NEWER than it understands but ignores unknown claims
    // within a supported version, which is exactly the mechanism that lets a
    // field be added without invalidating verifiers already in the field.
    // Bumping the version would reject every new receipt on an older verifier.
    use: {
      in: input.inputTokens,
      out: input.outputTokens,
      ...(input.cacheReadTokens ? { cr: input.cacheReadTokens } : {}),
      ...(input.cacheWriteTokens ? { cw: input.cacheWriteTokens } : {}),
    },
    cost: Math.round(input.costMicrocents),
    // Optional, exactly like `cr` / `cw` above and for the same compatibility
    // reason: present only on the calls it describes, so a receipt for a priced
    // call is byte-identical to one issued before this existed and every
    // verifier already in the field keeps working. `ver` does not move.
    //
    // `cost` stays a number rather than being omitted — sdk/verify.ts types it
    // as required, so dropping it would break published verifiers. The claim is
    // that the number is not meaningful, and this is what says so.
    ...(input.unpriced ? { unp: true } : {}),
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
    // Additive and absent from historical/bearer passport receipts. Keeping
    // version 1 is deliberate: existing verifiers ignore this new field, while
    // updated ones can distinguish proof enforced for THIS request.
    if (input.authMethod === "passport_proof_per_request") {
      claims.auth = { kind: "passport_proof_per_request" };
    }
  }
  // Additive and optional for historical inputs. New governed calls always
  // supply it from the policy snapshot they actually evaluated; keeping `ver`
  // unchanged is what lets existing receipt consumers ignore the new field.
  if (input.policyRevision) claims.pol = input.policyRevision;
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
