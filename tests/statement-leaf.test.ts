import { describe, it, expect } from "vitest";
import { bytesToHex } from "@noble/hashes/utils";

import { merkleLeaf } from "@/lib/merkle";

/**
 * THE PUBLISHED CONFORMANCE VECTOR for a spend statement's Merkle leaf.
 *
 * `docs/statement-format.md` §8 prints this exact pair and invites anyone to
 * check their own implementation against it. This test is what keeps the
 * document honest: change the leaf definition in `lib/merkle.ts` and the spec
 * stops describing the code, here, in one assertion.
 *
 * On a deployment that also OPERATES a chain there is a second half — the same
 * vector recomputed in SQL through the real window function — so the database
 * and the verifier are pinned to each other too. Nothing at runtime compares
 * those definitions: if they drift, the job keeps signing and every root simply
 * stops being reproducible, which is a failure that looks exactly like success.
 *
 * This test deliberately needs no database: the suite has no pg client and must
 * run in CI and in the pre-push hook without one. That is also why it ships to
 * every tree, including ones that never issue a statement.
 */
/**
 * DELIBERATELY NOT A REALISTIC JWS, and do not "improve" it into one.
 *
 * The first draft used a genuine base64url header/payload, which is more
 * readable and which `scripts/curate-public.sh` correctly refused to publish:
 * its scanner matches `eyJ[A-Za-z0-9_-]{20,}`, and a fixture that looks like a
 * token is indistinguishable from a leaked one at the mirror boundary. Loosening
 * that scanner so a test could look prettier would be exactly backwards.
 *
 * Nothing is lost. The tree never parses a receipt — it commits to the exact
 * bytes — so any fixed string is a valid vector, and the dot-separated shape
 * keeps the "signature is inside the leaf" case below meaningful.
 */
const VECTOR_RECEIPT = "pc-receipt-vector.claims-v1.signature-v1";
const VECTOR_LEAF = "ec983c6e10ba8fa942178ddfa6ecd48a7702c55289bf18cdb150ea25ec83a0b0";

describe("the Merkle leaf shared with the database", () => {
  it("matches the vector pinned in db/tests/statement_leaf_invariants.sql", () => {
    expect(bytesToHex(merkleLeaf(VECTOR_RECEIPT))).toBe(VECTOR_LEAF);
  });

  it("is 32 bytes, the width the SQL side encodes as 64 hex characters", () => {
    expect(merkleLeaf(VECTOR_RECEIPT)).toHaveLength(32);
    expect(VECTOR_LEAF).toHaveLength(64);
  });

  it("commits to the whole compact JWS, signature included", () => {
    // The signature is part of the leaf, so re-signing the same claims produces
    // a different leaf and a different root. That is what stops a receipt being
    // quietly reissued inside a window we already committed to.
    const [header, payload] = VECTOR_RECEIPT.split(".");
    expect(merkleLeaf(`${header}.${payload}.b3RoZXI`)).not.toEqual(
      merkleLeaf(VECTOR_RECEIPT)
    );
  });
});
