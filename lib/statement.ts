/**
 * Signed spend statements — the artifact that makes the receipt log complete.
 *
 * A receipt proves ONE call happened. A statement commits to the whole SET of
 * calls in a window: a Merkle root over every receipt in it, the counts and cost
 * that set adds up to, and the digest of the previous statement in this tenant's
 * chain. Signed with the same instance Ed25519 key as receipts and the
 * revocation list, and published at no URL — see the exposure note below.
 *
 * WHAT THIS PROVES, EXACTLY. An outsider holding one statement and one receipt
 * can check that we committed to a fixed set at time T, that their receipt is
 * inside it, and that no statement was removed or reordered. They CANNOT
 * recompute the root: that needs every receipt JWS in the window, which they do
 * not have. So the guarantee is tamper-evidence over a commitment we already
 * signed — not independent verification of the totals. The public copy in
 * plans/updates-pending.md says exactly that and no more; a tamper-evidence
 * feature that overstates itself is worse than none.
 *
 * WHY IT IS NOT AT A /.well-known URL, unlike the revocation list. Revocations
 * are safe to publish — an entry is never withdrawn and naming a dead passport
 * harms nobody. A statement is spend and call volume, which is tenant business
 * data. It is served authenticated, and the tenant decides who sees it; the
 * artifact verifies against the public JWKS wherever it lands, so distribution
 * costs them nothing.
 */
import { sha256 } from "@noble/hashes/sha256";

import { bytesToBase64url, utf8ToBytes } from "@/lib/encoding";

export const STATEMENT_FORMAT = "passcontrol.statement";
export const STATEMENT_VERSION = 1;

/**
 * The JWS `typ`. One signing key covers receipts, revocation lists and
 * statements, so `typ` is the only thing stopping a verifier accepting one where
 * another was meant — the same separation `RECEIPT_TYP` and `REVOCATION_LIST_TYP`
 * already provide, and it is asserted in both directions in the tests.
 */
export const STATEMENT_TYP = "passcontrol-statement+jws";

/**
 * Per-agent subtotal inside a statement.
 *
 * `agid` is null for calls whose agent has since been deleted: `agent_logs`
 * carries `agent_id` as FK ON DELETE SET NULL, so the call survives its agent on
 * purpose — deleting an agent must not erase what it spent. Those calls get
 * their own bucket rather than being dropped, so the subtotals still sum to the
 * statement's own `n` and `cost`. A bucket that silently vanished would make the
 * two disagree, and an auditor checking the arithmetic would find a hole we put
 * there.
 */
export interface StatementAgentSubtotal {
  agid: string | null;
  n: number;
  cost: number;
}

export interface StatementClaims {
  iss: string;
  sub: string;
  jti: string;
  iat: number;
  fmt: typeof STATEMENT_FORMAT;
  v: typeof STATEMENT_VERSION;
  seq: number;
  /** Half-open window `[from, to)`, epoch seconds. */
  per: { from: number; to: number };
  /**
   * `n` is what the root covers — rows carrying a receipt. `nr` is every row in
   * the window and may be larger: a row has no receipt when the deployment
   * configures no INSTANCE_SIGNING_KEY, or when signing failed on that call.
   *
   * Two numbers rather than one, on purpose. Reporting only `n` would let an
   * uncommitted call vanish from the account silently; reporting only `nr` would
   * imply the root covers rows it does not. The same three-state honesty as
   * lib/audit-history.ts and the `unp` claim on receipts: never present a number
   * as meaningful when it is not.
   */
  n: number;
  nr: number;
  cost: number;
  /**
   * Pricing certainty over the covered set, in three states — because a missing
   * cost has more than one cause and they are not interchangeable.
   *
   * `unp` counts calls KNOWN to be unpriceable: they went to a custom endpoint,
   * which may mark up, re-route, alias onto a local model, or be free
   * (`isPricedEndpoint` in lib/pricing.ts). The gateway tried and could not.
   *
   * `unk` counts covered calls with NO recorded cost that were not flagged that
   * way — a call the gateway refused before there was anything to price, or a
   * row written before `agent_logs.unpriced` existed. Its cost is unknown and so
   * is the reason.
   *
   * Everything else is priced, and `cost` is the sum over those. A statement
   * that folded `unp` or `unk` into "0" would assert those calls were free,
   * which is the defect the unknown-cost work fixed on receipts — this is the
   * same fix on the artifact handed to an auditor. Same discipline as
   * lib/audit-history.ts: recorded / never-recorded / unreadable.
   */
  unp: number;
  unk: number;
  /** base64url SHA-256 Merkle root, or null when `n` is 0. */
  root: string | null;
  /** Digest of the previous statement's compact JWS; null at the head of a chain. */
  pst: string | null;
  by: StatementAgentSubtotal[];
}

export interface StatementInput {
  issuer: string;
  statementId: string;
  userId: string;
  seq: number;
  periodStart: number;
  periodEnd: number;
  root: Uint8Array | null;
  coveredCount: number;
  rowCount: number;
  costMicrocents: number;
  unpricedCount: number;
  unknownPricingCount: number;
  previousDigest: string | null;
  byAgent: { agentId: string | null; n: number; cost: number }[];
  generatedAt?: number;
}

/**
 * The link between one statement and the one before it: SHA-256 over the
 * previous statement's compact JWS bytes.
 *
 * Over the JWS rather than over its claims, because the signature is what we are
 * committing to having produced. Re-signing the same claims with a different key
 * or at a different time yields a different artifact, and the chain should
 * notice.
 */
export function statementDigest(jws: string): string {
  return bytesToBase64url(sha256(utf8ToBytes(jws)));
}

export function buildStatementClaims(input: StatementInput): StatementClaims {
  return {
    iss: input.issuer,
    sub: input.userId,
    jti: input.statementId,
    iat: Math.floor((input.generatedAt ?? Date.now()) / 1000),
    fmt: STATEMENT_FORMAT,
    v: STATEMENT_VERSION,
    seq: input.seq,
    per: { from: input.periodStart, to: input.periodEnd },
    n: input.coveredCount,
    nr: input.rowCount,
    cost: Math.round(input.costMicrocents),
    unp: input.unpricedCount,
    unk: input.unknownPricingCount,
    root: input.root ? bytesToBase64url(input.root) : null,
    pst: input.previousDigest,
    // Agent ids only. A statement is made to be handed to an outsider, so
    // nothing here names a person, a model, or a workload — a test asserts the
    // serialised claims contain no such string.
    by: input.byAgent.map((row) => ({
      agid: row.agentId,
      n: row.n,
      cost: Math.round(row.cost),
    })),
  };
}
