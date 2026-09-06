// Presenting a signed spend statement to someone who does not work here.
//
// The counterpart of receipt-view.ts, and deliberately much smaller: a statement
// has no failover chain, no owner block and no verdict — it has a window, a
// commitment, a chain link, and an honest account of what it could not cover.
//
// ── The sentence this whole file exists to get right ────────────────────────
//
// A valid statement proves the issuer committed to a fixed set of receipts at a
// fixed time and cannot change it now. It does NOT independently confirm the
// totals: recomputing the root needs every receipt in the window, which the
// person reading a statement does not have. Every string below is written so a
// reader cannot come away believing the stronger thing, because the stronger
// thing is what they will want to believe.
import { MICROCENTS_PER_USD } from "@/lib/pricing";
import type { StatementClaims, VerifyFailure, VerifyStepName } from "@/sdk/verify";

import {
  describeFailure,
  isFetchableIssuer,
  type FailurePresentation,
} from "@/lib/verify/receipt-view";

/**
 * What the reader pasted, read locally before any network call.
 *
 * Deliberately separate from receipt-view's `peekArtifact`, which classifies for
 * a page that wants receipts. This one only has to answer "is this a statement",
 * and telling a reader they pasted a RECEIPT into the statement page is a more
 * useful error than "wrong type".
 */
export type StatementPeekKind = "statement" | "receipt" | "other_jws" | "not_jws";

export interface StatementPeek {
  kind: StatementPeekKind;
  /** The issuer the artifact CLAIMS. Nothing is checked yet — never present it as fact. */
  issuer: string | null;
  algorithm: string | null;
}

const NOT_JWS: StatementPeek = { kind: "not_jws", issuer: null, algorithm: null };

function decodeSegment(segment: string): Record<string, unknown> | null {
  try {
    const b64 = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const parsed: unknown = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)))
    );
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function peekStatement(input: string): StatementPeek {
  const parts = input.trim().split(".");
  if (parts.length !== 3) return NOT_JWS;
  const [headerPart, payloadPart] = parts as [string, string, string];
  if (!headerPart || !payloadPart) return NOT_JWS;

  const header = decodeSegment(headerPart);
  if (!header) return NOT_JWS;

  const payload = decodeSegment(payloadPart);
  const issuer = typeof payload?.iss === "string" ? payload.iss : null;
  const algorithm = typeof header.alg === "string" ? header.alg : null;
  const typ = typeof header.typ === "string" ? header.typ : null;

  const kind: StatementPeekKind =
    typ === "passcontrol-statement+jws"
      ? "statement"
      : typ === "passcontrol-receipt+jwt"
        ? "receipt"
        : "other_jws";
  return { kind, issuer, algorithm };
}

/**
 * The checks that can be settled before touching the network, in the verifier's
 * own gate order — so the page fails at the row that really refused it rather
 * than showing eight green ticks and then an error.
 */
export function statementPreflight(
  input: string
): { step: VerifyStepName; reason: VerifyFailure } | null {
  const peek = peekStatement(input);
  if (peek.kind === "not_jws") return { step: "parse", reason: "malformed" };
  if (peek.algorithm !== "EdDSA") return { step: "algorithm", reason: "bad_signature" };
  if (peek.kind !== "statement") return { step: "type", reason: "wrong_type" };
  if (!isFetchableIssuer(peek.issuer)) return { step: "issuer", reason: "untrusted_issuer" };
  return null;
}

// ── Why a check refused ────────────────────────────────────────────────────

/**
 * Statement-specific failure copy.
 *
 * receipt-view's `describeFailure` covers the same reasons, and reusing it was
 * the first draft — it renders "This receipt has been altered." on the statement
 * page, which a browser check caught and no unit test would have. The reasons
 * are shared; the noun and the advice are not.
 *
 * Only the reasons a statement can actually produce are overridden. Anything
 * else falls through to the receipt copy, which is generic enough to be right.
 */
const STATEMENT_FAILURES: Partial<Record<VerifyFailure, FailurePresentation>> = {
  bad_signature: {
    kind: "forged",
    title: "This statement has been altered.",
    body:
      "The signature does not match the contents. Either something in the statement was changed after it was signed, or it was never signed by the issuer it names. Do not rely on any figure in it.",
  },
  malformed: {
    kind: "forged",
    title: "This is not a spend statement.",
    body:
      "The text pasted is not a signed PassControl statement. Check you copied the whole thing — it is one long line with exactly two dots in it, and no spaces.",
  },
  wrong_type: {
    kind: "forged",
    title: "This is a different kind of artifact.",
    body:
      "It is signed by PassControl, but it is not a spend statement — a single call receipt is the most likely thing to land here by mistake, and there is a separate page for those. The type is part of what gets signed, so it cannot be changed to make it fit.",
  },
  untrusted_issuer: {
    kind: "forged",
    title: "This statement names no issuer we could check.",
    body:
      "A statement has to say who issued it, as a plain https address. This one does not, so there is nowhere to fetch a key from.",
  },
  unknown_key: {
    kind: "forged",
    title: "The issuer does not publish this signing key.",
    body:
      "The statement names a key that this issuer does not list as one of theirs. A genuine statement is always signed by a key its issuer publishes, including old keys kept for exactly this reason.",
  },
  // Deliberately NOT "forged". We are behind; the statement is not wrong.
  unsupported_version: {
    kind: "unchecked",
    title: "This statement is newer than this page.",
    body:
      "It was signed by a newer version of PassControl than this page understands, so it is not checked rather than checked wrongly. Verify it with an up-to-date copy of the passcontrol command-line tool.",
  },
  jwks_unreachable: {
    kind: "unchecked",
    title: "The issuer's key list could not be reached.",
    body:
      "We could not fetch the public keys from the address this statement names, so the signature has not been checked either way. This says nothing about the statement itself — the issuer's site may simply be down.",
  },
};

export function describeStatementFailure(
  reason: VerifyFailure,
  step?: VerifyStepName
): FailurePresentation {
  return STATEMENT_FAILURES[reason] ?? describeFailure(reason, step);
}

// ── Presenting the claims ──────────────────────────────────────────────────

export function formatWindow(per: StatementClaims["per"]): string {
  const from = new Date(per.from * 1000);
  const to = new Date(per.to * 1000);
  const day = (d: Date) => d.toISOString().slice(0, 10);
  // A whole UTC day is the normal case and reads better as one date than as a
  // range whose end is the next morning at midnight.
  return to.getTime() - from.getTime() === 86_400_000
    ? `${day(from)} (UTC)`
    : `${from.toISOString()} → ${to.toISOString()}`;
}

/**
 * The one place a statement total becomes money, for the public verifier and
 * the operator's own chain table alike. `claims.cost` is micro-cents: the
 * issuer sums the stored per-call cost and lib/statement.ts signs that number
 * into the leaf. So the divisor is MICROCENTS_PER_USD, not the cents constant
 * sitting next to it in lib/pricing.ts.
 */
export function formatStatementCost(microcents: number): string {
  return `$${(microcents / MICROCENTS_PER_USD).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  })}`;
}

export interface CoverageNote {
  /** Machine-readable for `data-state`; the suite asserts on these. */
  state: "complete" | "partial";
  headline: string;
  notes: string[];
}

/**
 * What the statement covered, and what it says it could not.
 *
 * `nr > n`, `unp` and `unk` are rendered as prose rather than dropped, because
 * they are the statement's own account of its limits. A page that showed `n` and
 * `cost` alone would turn "we cannot say" into "zero" — precisely the defect the
 * unknown-cost work fixed on receipts, arriving one layer up on the artifact an
 * auditor is most likely to read.
 */
export function describeCoverage(claims: StatementClaims): CoverageNote {
  const uncovered = Math.max(0, claims.nr - claims.n);
  const notes: string[] = [];

  if (uncovered > 0) {
    notes.push(
      `${uncovered} logged call${uncovered === 1 ? "" : "s"} carried no receipt, so ${uncovered === 1 ? "it is" : "they are"} not covered by this commitment.`
    );
  }
  if (claims.unp > 0) {
    notes.push(
      `${claims.unp} call${claims.unp === 1 ? "" : "s"} went somewhere nobody could price. That cost is unknown, not zero, and is not in the total.`
    );
  }
  if (claims.unk > 0) {
    notes.push(
      `${claims.unk} call${claims.unk === 1 ? "" : "s"} have no recorded cost and no recorded reason.`
    );
  }

  return {
    state: notes.length === 0 ? "complete" : "partial",
    headline: `Commits to ${claims.n} of ${claims.nr} logged call${claims.nr === 1 ? "" : "s"}, totalling ${formatStatementCost(claims.cost)}.`,
    notes,
  };
}

export interface ChainNote {
  state: "head" | "linked";
  text: string;
}

export function describeChain(claims: StatementClaims): ChainNote {
  if (!claims.pst) {
    return {
      state: "head",
      text: `This is statement #${claims.seq} and the first in its chain, so there is no earlier one for it to point back to.`,
    };
  }
  return {
    state: "linked",
    text: `This is statement #${claims.seq}, and it carries the fingerprint of the statement before it. Remove or edit that earlier statement and this link stops matching — which is what makes a whole missing day detectable.`,
  };
}

/**
 * The limits, stated in the reader's language.
 *
 * Kept as data rather than baked into JSX so the wording is testable, and so the
 * page cannot quietly grow a fifth reassuring bullet that nobody reviewed.
 */
export const STATEMENT_LIMITS: readonly { claim: string; body: string }[] = [
  {
    claim: "It says",
    body:
      "this statement was signed by the issuer it names, using a key that issuer publishes, and that the set of calls it commits to was fixed at that moment and cannot be changed now.",
  },
  {
    claim: "It does not say",
    body:
      "that the totals are correct. Recomputing the commitment needs every receipt in the window, which you do not have. A valid signature means the issuer cannot revise what it committed to — not that it added up right.",
  },
  {
    claim: "It does not say",
    body:
      "that the issuer is trustworthy. Anyone can run PassControl and sign statements about their own agents. The signature proves the record is intact; it does not vouch for whoever made it.",
  },
  {
    claim: "To check one call",
    body:
      "you also need that call's receipt and an inclusion proof from the issuer's control API. Without a proof, a statement tells you about a set, not about a specific call.",
  },
];
