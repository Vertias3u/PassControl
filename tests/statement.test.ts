import { describe, it, expect, beforeEach } from "vitest";
import { sha256 } from "@noble/hashes/sha256";

import { bytesToBase64url, utf8ToBytes } from "@/lib/encoding";
import { RECEIPT_TYP, signCompactJws, verifyCompactJws } from "@/lib/crypto/jws";
import { loadInstanceSigner } from "@/lib/crypto/instanceKey";
import { merkleLeaf, merkleRoot } from "@/lib/merkle";
import {
  STATEMENT_FORMAT,
  STATEMENT_TYP,
  STATEMENT_VERSION,
  buildStatementClaims,
  statementDigest,
} from "@/lib/statement";

const SEED = bytesToBase64url(new Uint8Array(32).fill(7));

const DAY_START = Date.UTC(2026, 8, 3, 0, 0, 0) / 1000;
const DAY_END = Date.UTC(2026, 8, 4, 0, 0, 0) / 1000;

const receipts = (n: number) => Array.from({ length: n }, (_, i) => `receipt.jws.${i}`);

const INPUT = {
  issuer: "https://gw.example.com",
  statementId: "statement-1",
  userId: "8f14e45f-ceea-467a-9a2f-2b0c2a5f0b11",
  seq: 4,
  periodStart: DAY_START,
  periodEnd: DAY_END,
  root: merkleRoot(receipts(3).map(merkleLeaf)),
  coveredCount: 3,
  rowCount: 3,
  costMicrocents: 12_345,
  unpricedCount: 0,
  unknownPricingCount: 0,
  previousDigest: "cHJldmlvdXMtc3RhdGVtZW50LWRpZ2VzdA",
  byAgent: [
    { agentId: "agent-a", n: 2, cost: 10_000 },
    { agentId: "agent-b", n: 1, cost: 2_345 },
  ],
  generatedAt: Date.UTC(2026, 8, 4, 1, 30, 0),
};

beforeEach(() => {
  process.env.INSTANCE_SIGNING_KEY = SEED;
  process.env.PASSCONTROL_ISSUER = "https://gw.example.com";
});

describe("the statement format", () => {
  it("has its own JWS type, so it can never be read as a receipt", () => {
    // The whole point of a distinct typ: one signing key covers receipts, the
    // revocation list and statements, and only typ keeps a verifier from
    // accepting one where another was meant.
    expect(STATEMENT_TYP).toBe("passcontrol-statement+jws");
    expect(STATEMENT_TYP).not.toBe(RECEIPT_TYP);
  });

  it("names its format and version inside the claims", () => {
    const claims = buildStatementClaims(INPUT);
    expect(claims.fmt).toBe(STATEMENT_FORMAT);
    expect(claims.v).toBe(STATEMENT_VERSION);
  });
});

describe("the statement claims", () => {
  it("carries the issuer, subject, sequence and window", () => {
    const claims = buildStatementClaims(INPUT);
    expect(claims.iss).toBe(INPUT.issuer);
    expect(claims.sub).toBe(INPUT.userId);
    expect(claims.jti).toBe(INPUT.statementId);
    expect(claims.seq).toBe(4);
    expect(claims.per).toEqual({ from: DAY_START, to: DAY_END });
    expect(claims.iat).toBe(Math.floor(INPUT.generatedAt / 1000));
  });

  it("encodes the root as base64url, and null when nothing was covered", () => {
    expect(buildStatementClaims(INPUT).root).toBe(bytesToBase64url(INPUT.root!));
    const empty = buildStatementClaims({
      ...INPUT,
      root: null,
      coveredCount: 0,
      rowCount: 0,
      costMicrocents: 0,
      byAgent: [],
    });
    // A quiet day still gets a signed statement — it keeps the chain unbroken.
    expect(empty.root).toBeNull();
    expect(empty.n).toBe(0);
  });

  it("reports covered and total row counts separately, never folding one into the other", () => {
    // A row with no receipt cannot be a leaf: the deployment may have had no
    // signing key, or signing may have failed on that call. Stating both numbers
    // makes the gap a disclosed fact instead of a silent hole in the commitment.
    const claims = buildStatementClaims({ ...INPUT, coveredCount: 3, rowCount: 5 });
    expect(claims.n).toBe(3);
    expect(claims.nr).toBe(5);
  });

  it("carries per-agent subtotals that sum to the statement total", () => {
    const claims = buildStatementClaims(INPUT);
    expect(claims.by).toEqual([
      { agid: "agent-a", n: 2, cost: 10_000 },
      { agid: "agent-b", n: 1, cost: 2_345 },
    ]);
    expect(claims.by.reduce((sum, row) => sum + row.cost, 0)).toBe(claims.cost);
    expect(claims.by.reduce((sum, row) => sum + row.n, 0)).toBe(claims.n);
  });

  it("says how many covered calls nobody could price", () => {
    // Same reason receipts carry `unp`: a cost total that silently includes
    // unpriced calls as zero reads as "these were free", which is not a claim
    // this instance can make about a custom endpoint.
    expect(buildStatementClaims({ ...INPUT, unpricedCount: 2 }).unp).toBe(2);
  });

  it("counts calls whose pricing certainty was never recorded, separately from unpriced", () => {
    // NULL is not false. A row written before agent_logs gained `unpriced` — or
    // by a deployment that has not migrated — cannot be called priced OR
    // unpriced, and folding it into either would be an invented fact.
    const claims = buildStatementClaims({ ...INPUT, unpricedCount: 1, unknownPricingCount: 4 });
    expect(claims.unp).toBe(1);
    expect(claims.unk).toBe(4);
  });

  it("self-describes a window of pure history as one it cannot price-classify", () => {
    // The first statements generated over existing agent_logs history look like
    // this: every covered call unknown. The claim set says so out loud rather
    // than reporting `unp: 0`, which would read as "all of these were priced".
    const historical = buildStatementClaims({
      ...INPUT,
      coveredCount: 3,
      unpricedCount: 0,
      unknownPricingCount: 3,
    });
    expect(historical.unk).toBe(historical.n);
    expect(historical.unp).toBe(0);
  });

  it("carries the previous statement's digest, and null at the head of a chain", () => {
    expect(buildStatementClaims(INPUT).pst).toBe(INPUT.previousDigest);
    expect(buildStatementClaims({ ...INPUT, seq: 1, previousDigest: null }).pst).toBeNull();
  });

  it("carries ids and numbers only — no email, handle, model or agent name", () => {
    // A statement is made to be handed to an outsider. Anything in it that
    // names a person or describes a workload leaves the tenant on sharing.
    const serialised = JSON.stringify(buildStatementClaims(INPUT));
    for (const forbidden of ["@", "gpt-", "claude-", "handle", "email", "name"]) {
      expect(serialised.toLowerCase()).not.toContain(forbidden);
    }
  });
});

describe("the statement digest", () => {
  it("is sha-256 over the compact JWS bytes, base64url encoded", () => {
    const jws = "header.payload.signature";
    expect(statementDigest(jws)).toBe(bytesToBase64url(sha256(utf8ToBytes(jws))));
  });

  it("changes when any byte of the statement changes", () => {
    expect(statementDigest("a.b.c")).not.toBe(statementDigest("a.b.d"));
  });
});

describe("a chain of statements", () => {
  const sign = (claims: unknown) => {
    const signer = loadInstanceSigner()!;
    return signCompactJws({
      typ: STATEMENT_TYP,
      kid: signer.kid,
      claims: claims as Record<string, unknown>,
      seed: signer.seed,
    });
  };

  it("verifies against the instance key under its own type", () => {
    const jws = sign(buildStatementClaims(INPUT));
    const signer = loadInstanceSigner()!;
    expect(verifyCompactJws(jws, signer.publicKey, { typ: STATEMENT_TYP })).not.toBeNull();
  });

  it("does not verify as a receipt", () => {
    const jws = sign(buildStatementClaims(INPUT));
    const signer = loadInstanceSigner()!;
    expect(verifyCompactJws(jws, signer.publicKey, { typ: RECEIPT_TYP })).toBeNull();
  });

  it("breaks when the statement it points back to is altered", () => {
    // The property this feature exists for: rewrite an earlier statement and
    // every later one stops matching, so a removed or edited day is detectable
    // from the chain alone.
    const first = sign(buildStatementClaims({ ...INPUT, seq: 1, previousDigest: null }));
    const second = sign(
      buildStatementClaims({ ...INPUT, seq: 2, previousDigest: statementDigest(first) })
    );
    const signer = loadInstanceSigner()!;
    const claims = verifyCompactJws(second, signer.publicKey, { typ: STATEMENT_TYP })!.claims;

    const altered = sign(
      buildStatementClaims({ ...INPUT, seq: 1, previousDigest: null, costMicrocents: 999_999 })
    );
    expect(claims.pst).toBe(statementDigest(first));
    expect(claims.pst).not.toBe(statementDigest(altered));
  });

  it("detects a thinned window, because the root moves", () => {
    // Sign a statement over five receipts, then try to pass off a four-receipt
    // window as the same statement.
    const full = receipts(5).map(merkleLeaf);
    const signed = buildStatementClaims({
      ...INPUT,
      root: merkleRoot(full),
      coveredCount: 5,
      rowCount: 5,
    });
    const thinned = merkleRoot(full.filter((_, i) => i !== 2));
    expect(bytesToBase64url(thinned!)).not.toBe(signed.root);
  });
});
