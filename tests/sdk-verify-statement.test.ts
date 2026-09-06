import { describe, it, expect, beforeEach } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";

import { bytesToBase64url, utf8ToBytes } from "@/lib/encoding";
import { publicJwk, loadInstanceSigner } from "@/lib/crypto/instanceKey";
import { signCompactJws } from "@/lib/crypto/jws";
import { merkleLeaf, merkleProof, merkleRoot } from "@/lib/merkle";
import { STATEMENT_TYP, buildStatementClaims } from "@/lib/statement";
import { signReceipt } from "@/lib/receipt";
import {
  STATEMENT_SUPPORTED_VER,
  verifyInclusion,
  verifyStatement,
  type StatementClaims,
} from "@/sdk/verify";

const SEED = bytesToBase64url(new Uint8Array(32).fill(7));
const ISSUER = "https://gw.example.com";

const RECEIPTS = ["receipt-1", "receipt-2", "receipt-3", "receipt-4", "receipt-5"];
const LEAVES = RECEIPTS.map(merkleLeaf);
const ROOT = merkleRoot(LEAVES)!;

const STATEMENT_INPUT = {
  issuer: ISSUER,
  statementId: "statement-1",
  userId: "8f14e45f-ceea-467a-9a2f-2b0c2a5f0b11",
  seq: 3,
  periodStart: Math.floor(Date.UTC(2026, 8, 3) / 1000),
  periodEnd: Math.floor(Date.UTC(2026, 8, 4) / 1000),
  root: ROOT,
  coveredCount: 5,
  rowCount: 6,
  costMicrocents: 4200,
  unpricedCount: 1,
  unknownPricingCount: 0,
  previousDigest: "cHJldmlvdXMtZGlnZXN0",
  byAgent: [{ agentId: "agent-1", n: 5, cost: 4200 }],
  generatedAt: Date.UTC(2026, 8, 4, 1, 30),
};

const sign = (claims: Record<string, unknown>, typ = STATEMENT_TYP) => {
  const signer = loadInstanceSigner()!;
  return signCompactJws({ typ, kid: signer.kid, claims, seed: signer.seed });
};

const statementJws = (over: Partial<Record<string, unknown>> = {}) =>
  sign({ ...buildStatementClaims(STATEMENT_INPUT), ...over } as Record<string, unknown>);

const jwksFetch = (keys: unknown[], init: { ok?: boolean } = {}) =>
  (async () =>
    ({
      ok: init.ok ?? true,
      json: async () => ({ keys }),
    }) as unknown as Response) as unknown as typeof fetch;

const opts = (over: Record<string, unknown> = {}) => {
  const signer = loadInstanceSigner()!;
  return {
    trustedIssuers: [ISSUER],
    fetch: jwksFetch([publicJwk(signer.publicKey)]),
    ...over,
  } as never;
};

beforeEach(() => {
  process.env.INSTANCE_SIGNING_KEY = SEED;
  process.env.PASSCONTROL_ISSUER = ISSUER;
});

describe("verifying a genuine statement", () => {
  it("accepts one the gateway actually signed", async () => {
    const result = await verifyStatement(statementJws(), opts());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claims.seq).toBe(3);
    expect(result.claims.root).toBe(bytesToBase64url(ROOT));
    expect(result.claims.pst).toBe("cHJldmlvdXMtZGlnZXN0");
  });

  it("hands back what the statement admits it does not know", async () => {
    const result = await verifyStatement(statementJws(), opts());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const claims: StatementClaims = result.claims;
    expect(claims.n).toBe(5);
    expect(claims.nr).toBe(6);
    expect(claims.unp).toBe(1);
    expect(claims.unk).toBe(0);
  });

  it("reports the checks it ran, in order", async () => {
    const steps: string[] = [];
    await verifyStatement(statementJws(), opts({ onStep: (s: { step: string }) => steps.push(s.step) }));
    expect(steps).toEqual(["parse", "algorithm", "type", "issuer", "version", "jwks", "key", "signature"]);
  });

  it("rejects a statement whose totals were altered after signing", async () => {
    const [header, payload, signature] = statementJws().split(".");
    const claims = JSON.parse(new TextDecoder().decode(Buffer.from(payload!, "base64url")));
    claims.cost = 1;
    const forged = `${header}.${bytesToBase64url(utf8ToBytes(JSON.stringify(claims)))}.${signature}`;
    const result = await verifyStatement(forged, opts());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("bad_signature");
  });

  it("rejects one from an issuer the caller does not trust", async () => {
    const result = await verifyStatement(statementJws(), opts({ trustedIssuers: ["https://other.example.com"] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("untrusted_issuer");
  });

  it("rejects one signed by a key the issuer does not publish", async () => {
    const stranger = publicJwk(ed25519.getPublicKey(new Uint8Array(32).fill(9)));
    const result = await verifyStatement(statementJws(), opts({ fetch: jwksFetch([stranger]) }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unknown_key");
  });
});

describe("statements and receipts are not interchangeable", () => {
  it("refuses a receipt presented as a statement", async () => {
    const receipt = signReceipt({
      receiptId: "r-1",
      passportId: "cGFzc3BvcnQ",
      agentId: "agent-1",
      visaJti: "visa-1",
      provider: "openai",
      model: "gpt-4o-mini",
      method: "POST",
      path: "v1/chat/completions",
      rawBody: "{}",
      inputTokens: 1,
      outputTokens: 1,
      costMicrocents: 1,
      status: "ok",
      httpStatus: 200,
      startedAt: 1,
      latencyMs: 1,
    } as never)!;
    const result = await verifyStatement(receipt, opts());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("wrong_type");
  });

  it("refuses a statement presented as a receipt", async () => {
    const { verifyReceipt } = await import("@/sdk/verify");
    const result = await verifyReceipt(statementJws(), opts());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("wrong_type");
  });
});

describe("the statement version gate", () => {
  // Statements version themselves with `v`; receipts use `ver`. Without a gate
  // of its own a statement's version would never be checked at all, and a future
  // v2 would be silently accepted by this v1 verifier — the exact
  // forward-compatibility failure SUPPORTED_VER exists to prevent, arriving
  // through the back door.
  it("refuses a statement newer than it understands", async () => {
    const result = await verifyStatement(
      statementJws({ v: STATEMENT_SUPPORTED_VER + 1 }),
      opts()
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unsupported_version");
  });

  it("accepts the version it does understand", async () => {
    const result = await verifyStatement(statementJws({ v: STATEMENT_SUPPORTED_VER }), opts());
    expect(result.ok).toBe(true);
  });

  it("gates on the statement's own version line, not the receipt's", async () => {
    // A receipt v2 exists today. If the statement gate were wired to the receipt
    // maximum, a statement claiming v2 would pass — and it must not.
    const { SUPPORTED_VER } = await import("@/sdk/verify");
    expect(SUPPORTED_VER).toBeGreaterThan(STATEMENT_SUPPORTED_VER);
    const result = await verifyStatement(statementJws({ v: SUPPORTED_VER }), opts());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unsupported_version");
  });

  it("fails at the version step, so a UI can say which check refused it", async () => {
    const steps: { step: string; ok: boolean }[] = [];
    await verifyStatement(
      statementJws({ v: STATEMENT_SUPPORTED_VER + 1 }),
      opts({ onStep: (s: { step: string; ok: boolean }) => steps.push(s) })
    );
    expect(steps.at(-1)).toMatchObject({ step: "version", ok: false });
  });
});

describe("checking a receipt is inside a statement", () => {
  const root = ROOT;

  it("confirms inclusion for a covered receipt", () => {
    for (let i = 0; i < RECEIPTS.length; i++) {
      expect(verifyInclusion(RECEIPTS[i]!, merkleProof(LEAVES, i), root), RECEIPTS[i]).toBe(true);
    }
  });

  it("denies a receipt that is not in the tree", () => {
    expect(verifyInclusion("receipt-forged", merkleProof(LEAVES, 0), root)).toBe(false);
  });

  it("denies a valid proof folded against a different statement's root", () => {
    // The docblock's warning made executable: a `false` here means "not in THIS
    // root", not "not attested". The pairing is the caller's to get right.
    const otherRoot = merkleRoot(["a", "b", "c"].map(merkleLeaf))!;
    expect(verifyInclusion(RECEIPTS[0]!, merkleProof(LEAVES, 0), otherRoot)).toBe(false);
  });

  it("denies a proof whose sibling was flipped to the other side", () => {
    const proof = merkleProof(LEAVES, 1).map((s, i) => (i === 0 ? { ...s, right: !s.right } : s));
    expect(verifyInclusion(RECEIPTS[1]!, proof, root)).toBe(false);
  });

  it("accepts the wire form the control API returns", () => {
    // base64url steps and a base64url root, decoded by the SDK rather than by
    // every caller.
    const wire = merkleProof(LEAVES, 3).map((s) => ({ right: s.right, hash: bytesToBase64url(s.hash) }));
    expect(verifyInclusion(RECEIPTS[3]!, wire, bytesToBase64url(root))).toBe(true);
  });
});
