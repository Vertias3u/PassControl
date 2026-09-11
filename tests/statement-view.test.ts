import { describe, it, expect } from "vitest";

import { ALL_FAILURES, describeFailure } from "@/lib/verify/receipt-view";
import {
  STATEMENT_LIMITS,
  describeChain,
  describeCoverage,
  describeStatementFailure,
  formatStatementCost,
  formatWindow,
  peekStatement,
  statementPreflight,
} from "@/lib/verify/statement-view";
import type { StatementClaims } from "@/sdk/verify";

const CLAIMS = (over: Partial<StatementClaims> = {}): StatementClaims => ({
  iss: "https://gw.example.com",
  sub: "tenant-1",
  jti: "statement-1",
  iat: 1_788_549_365,
  fmt: "passcontrol.statement",
  v: 1,
  seq: 2,
  per: { from: Date.UTC(2026, 8, 3) / 1000, to: Date.UTC(2026, 8, 4) / 1000 },
  n: 4,
  nr: 5,
  cost: 15_000,
  unp: 1,
  unk: 0,
  root: "cm9vdA",
  pst: "cHJldg",
  by: [{ agid: "agent-1", n: 4, cost: 15_000 }],
  ...over,
});

describe("the failure copy on the statement page", () => {
  // THIS IS THE TEST FOR A BUG A BROWSER FOUND AND THE SUITE DID NOT. The first
  // draft reused receipt-view's describeFailure, so a tampered statement
  // rendered "This receipt has been altered." on the statement page. Nothing
  // failed. These pin the fix so it cannot quietly come back.

  it("never calls a statement a receipt", () => {
    for (const reason of ALL_FAILURES) {
      const presented = describeStatementFailure(reason);
      // `wrong_type` mentions receipts ON PURPOSE — pasting a call receipt into
      // this page is the most likely mistake, and naming it is the helpful
      // answer. Every other reason must be about the artifact at hand.
      if (reason === "wrong_type") {
        expect(presented.body.toLowerCase()).toContain("receipt");
        continue;
      }
      expect(presented.title.toLowerCase(), reason).not.toContain("receipt");
    }
  });

  it("answers for every reason the verifier can return", () => {
    for (const reason of ALL_FAILURES) {
      const presented = describeStatementFailure(reason);
      expect(presented.title, reason).toBeTruthy();
      expect(presented.body, reason).toBeTruthy();
      expect(["forged", "unchecked"], reason).toContain(presented.kind);
    }
  });

  it("overrides — rather than inherits — the reasons a statement actually produces", () => {
    // If any of these ever silently fell back to the receipt copy, the page
    // would start describing the wrong artifact again.
    for (const reason of [
      "bad_signature",
      "malformed",
      "wrong_type",
      "untrusted_issuer",
      "unknown_key",
      "unsupported_version",
      "jwks_unreachable",
    ] as const) {
      expect(describeStatementFailure(reason), reason).not.toEqual(describeFailure(reason));
    }
  });

  // Same rule as the receipt page, and it has to hold on both: a key the
  // issuer no longer publishes is not evidence the statement was altered.
  it("does not accuse a statement of alteration when the key is merely not published", () => {
    const copy = describeStatementFailure("unknown_key");
    const text = `${copy.title} ${copy.body}`.toLowerCase();
    expect(text).not.toContain("altered");
    expect(text).not.toMatch(/a genuine statement is always/);
    expect(text).toContain("withdrawn");
  });

  it("treats a version it does not understand as UNCHECKED, not as forgery", () => {
    // We are behind; the statement is not wrong. Calling this "forged" would
    // accuse an issuer of tampering for shipping an upgrade.
    expect(describeStatementFailure("unsupported_version").kind).toBe("unchecked");
    expect(describeStatementFailure("jwks_unreachable").kind).toBe("unchecked");
    expect(describeStatementFailure("bad_signature").kind).toBe("forged");
  });
});

describe("reading a pasted artifact before any network call", () => {
  const jws = (typ: string, claims: Record<string, unknown> = {}) => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    return `${b64({ alg: "EdDSA", typ })}.${b64({ iss: "https://gw.example.com", ...claims })}.sig`;
  };

  it("tells a statement from a receipt from something else", () => {
    expect(peekStatement(jws("passcontrol-statement+jws")).kind).toBe("statement");
    expect(peekStatement(jws("passcontrol-receipt+jwt")).kind).toBe("receipt");
    expect(peekStatement(jws("something-else")).kind).toBe("other_jws");
    expect(peekStatement("not a jws").kind).toBe("not_jws");
  });

  it("fails at the gate that actually refused it", () => {
    expect(statementPreflight("nonsense")).toEqual({ step: "parse", reason: "malformed" });
    expect(statementPreflight(jws("passcontrol-receipt+jwt"))).toEqual({
      step: "type",
      reason: "wrong_type",
    });
    expect(
      statementPreflight(jws("passcontrol-statement+jws", { iss: "javascript:alert(1)" }))
    ).toEqual({ step: "issuer", reason: "untrusted_issuer" });
    expect(statementPreflight(jws("passcontrol-statement+jws"))).toBeNull();
  });

  it("passes a loopback issuer, so the local stack verifies", () => {
    expect(statementPreflight(jws("passcontrol-statement+jws", { iss: "http://localhost:3000" }))).toBeNull();
  });
});

describe("presenting what a statement covered", () => {
  it("says a full day is complete", () => {
    const note = describeCoverage(CLAIMS({ n: 5, nr: 5, unp: 0, unk: 0 }));
    expect(note.state).toBe("complete");
    expect(note.notes).toEqual([]);
  });

  it("names every gap rather than folding it into the total", () => {
    const note = describeCoverage(CLAIMS({ n: 4, nr: 6, unp: 2, unk: 1 }));
    expect(note.state).toBe("partial");
    expect(note.notes).toHaveLength(3);
    expect(note.notes.join(" ")).toContain("not covered");
    // The sentence that stops a reader treating an unpriced call as a free one.
    expect(note.notes.join(" ")).toContain("unknown, not zero");
  });

  it("never claims the totals were independently checked", () => {
    const said = [
      describeCoverage(CLAIMS()).headline,
      ...STATEMENT_LIMITS.map((l) => `${l.claim} ${l.body}`),
    ]
      .join(" ")
      .toLowerCase();
    expect(said).toContain("does not say");
    expect(said).toContain("totals are correct");
  });

  it("distinguishes the head of a chain from a linked statement", () => {
    expect(describeChain(CLAIMS({ pst: null })).state).toBe("head");
    expect(describeChain(CLAIMS({ pst: "cHJldg" })).state).toBe("linked");
  });

  it("renders a whole UTC day as a date, and anything else as a range", () => {
    expect(formatWindow(CLAIMS().per)).toBe("2026-09-03 (UTC)");
    const half = { from: Date.UTC(2026, 8, 3) / 1000, to: Date.UTC(2026, 8, 3, 12) / 1000 };
    expect(formatWindow(half)).toContain("→");
  });
});

describe("the dollar figure on a statement", () => {
  // THIS IS THE TEST FOR A BUG THAT SHIPPED. Both statement surfaces divided
  // µ¢ by 1_000_000 — which is µ¢-to-CENTS — and then wrote a `$` in front of
  // the answer, so every statement total read ONE HUNDRED TIMES its real value.
  // `lib/pricing.ts` states the units at the top of the file: 1 cent =
  // 1_000_000 µ¢, 1 USD = 100_000_000 µ¢.
  //
  // Nothing could fail: `claims.cost` is a bare number, both formatters agreed
  // with each other, and the wrong figure is a plausible-looking amount of
  // money. tests/cost-representation-coverage.test.ts does not cover it either
  // — that file guards unknown-versus-zero, a different question, and it finds
  // its consumers by grepping `cost_microcents`, a string this formatter never
  // mentions because it reads the signed claim.
  //
  // These assert the ARITHMETIC against known quantities, not the current
  // output, so they stay true if the presentation changes.
  it("converts micro-cents to dollars, not to cents", () => {
    expect(formatStatementCost(100_000_000)).toBe("$1.00");
    expect(formatStatementCost(10_000_000)).toBe("$0.10");
    // The fixture used throughout this file: 15,000 µ¢ is 15 thousandths of a
    // cent. Rendered as $0.015 it overstates a real day of spend 100-fold.
    expect(formatStatementCost(15_000)).toBe("$0.00015");
  });

  it("shows a zero total as zero dollars", () => {
    expect(formatStatementCost(0)).toBe("$0.00");
  });

  it("carries the same corrected figure into the coverage headline", () => {
    // Two call sites, one function: the headline sentence a reader actually
    // sees quoted the same wrong number as the cost field beside it.
    expect(describeCoverage(CLAIMS({ cost: 15_000 })).headline).toContain("$0.00015");
  });

});
