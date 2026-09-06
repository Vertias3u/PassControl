import { describe, it, expect } from "vitest";
import { sha256 } from "@noble/hashes/sha256";

import { base64urlToBytes, bytesToBase64url, utf8ToBytes } from "@/lib/encoding";
import {
  LEAF_PREFIX,
  NODE_PREFIX,
  merkleLeaf,
  merkleProof,
  merkleRoot,
  verifyMerkleProof,
} from "@/lib/merkle";

// Stand-ins for receipt JWS strings. The tree never parses them — it commits to
// their exact bytes — so opaque strings are the honest fixture here.
const leaves = (n: number) => Array.from({ length: n }, (_, i) => merkleLeaf(`receipt-${i}`));

const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

describe("the leaf hash", () => {
  it("is sha-256 over a domain-separation prefix and the utf8 receipt bytes", () => {
    const jws = "header.payload.signature";
    expect(merkleLeaf(jws)).toEqual(sha256(cat(Uint8Array.of(LEAF_PREFIX), utf8ToBytes(jws))));
  });

  it("uses a different prefix from an internal node, so a leaf cannot pose as one", () => {
    // Without this, an attacker who controls a leaf's bytes can supply a value
    // that is itself a valid internal-node preimage and forge a subtree.
    expect(LEAF_PREFIX).not.toBe(NODE_PREFIX);
  });

  it("changes completely when a single byte of the receipt changes", () => {
    expect(merkleLeaf("receipt-a")).not.toEqual(merkleLeaf("receipt-b"));
  });
});

describe("the root", () => {
  it("is null for an empty set, so a zero-call window is representable", () => {
    // A day with no calls still gets a statement — it keeps the chain unbroken
    // and "nothing happened" is itself a claim worth signing.
    expect(merkleRoot([])).toBeNull();
  });

  it("is the leaf itself when there is exactly one", () => {
    const only = merkleLeaf("receipt-0");
    expect(merkleRoot([only])).toEqual(only);
  });

  it("is order-dependent, because the window has a defined order", () => {
    const [a, b] = leaves(2);
    expect(merkleRoot([a!, b!])).not.toEqual(merkleRoot([b!, a!]));
  });

  it("changes when any single receipt is removed — this is the whole feature", () => {
    // THE test. If a receipt can be dropped from the window without moving the
    // root, the statement commits to nothing and the feature is theatre.
    const full = leaves(9);
    const signedRoot = merkleRoot(full);
    for (let i = 0; i < full.length; i++) {
      const thinned = full.filter((_, at) => at !== i);
      expect(merkleRoot(thinned)).not.toEqual(signedRoot);
    }
  });

  it("changes when a receipt is substituted, not just removed", () => {
    const full = leaves(5);
    const swapped = [...full];
    swapped[2] = merkleLeaf("receipt-forged");
    expect(merkleRoot(swapped)).not.toEqual(merkleRoot(full));
  });

  it("promotes an odd node rather than duplicating it", () => {
    // Duplicating the last leaf on an odd level (the CVE-2012-2459 shape) lets a
    // 3-leaf set and a 4-leaf set whose last leaf repeats produce ONE root — so
    // an attacker can add a phantom receipt without moving the commitment.
    const [a, b, c] = leaves(3);
    const promoted = merkleRoot([a!, b!, c!]);
    const duplicated = merkleRoot([a!, b!, c!, c!]);
    expect(promoted).not.toEqual(duplicated);
  });

  it("is stable across calls, so a re-run reproduces the signed commitment", () => {
    const set = leaves(7);
    expect(merkleRoot(set)).toEqual(merkleRoot([...set]));
  });
});

describe("an inclusion proof", () => {
  it("verifies for every position, at every tree shape up to 33 leaves", () => {
    // Sweep rather than spot-check: the promotion rule only bites at particular
    // sizes, and an off-by-one in the sibling walk hides at all the others.
    for (let size = 1; size <= 33; size++) {
      const set = leaves(size);
      const root = merkleRoot(set)!;
      for (let i = 0; i < size; i++) {
        const proof = merkleProof(set, i);
        expect(verifyMerkleProof(set[i]!, proof, root), `size ${size}, index ${i}`).toBe(true);
      }
    }
  });

  it("fails for a receipt that is not in the tree", () => {
    const set = leaves(8);
    const root = merkleRoot(set)!;
    const proof = merkleProof(set, 3);
    expect(verifyMerkleProof(merkleLeaf("receipt-outside"), proof, root)).toBe(false);
  });

  it("fails when one sibling in the path is altered", () => {
    const set = leaves(8);
    const root = merkleRoot(set)!;
    const proof = merkleProof(set, 5);
    expect(proof.length).toBeGreaterThan(0);
    const tampered = proof.map((step, at) =>
      at === 0 ? { ...step, hash: merkleLeaf("receipt-swapped") } : step
    );
    expect(verifyMerkleProof(set[5]!, tampered, root)).toBe(false);
  });

  it("fails when a sibling is moved to the other side", () => {
    // The left/right flag is part of the claim: hashing the same siblings in the
    // other order is a different tree, and must not verify.
    const set = leaves(8);
    const root = merkleRoot(set)!;
    const proof = merkleProof(set, 1);
    const flipped = proof.map((step, at) => (at === 0 ? { ...step, right: !step.right } : step));
    expect(verifyMerkleProof(set[1]!, flipped, root)).toBe(false);
  });

  it("fails against a root from a different window", () => {
    const set = leaves(6);
    const proof = merkleProof(set, 2);
    const otherRoot = merkleRoot(leaves(6).map((_, i) => merkleLeaf(`other-${i}`)))!;
    expect(verifyMerkleProof(set[2]!, proof, otherRoot)).toBe(false);
  });

  it("is empty for a single-leaf tree, and still verifies", () => {
    const only = leaves(1);
    expect(merkleProof(only, 0)).toEqual([]);
    expect(verifyMerkleProof(only[0]!, [], merkleRoot(only)!)).toBe(true);
  });

  it("is logarithmic, so a statement stays small however busy the day was", () => {
    // 1024 leaves must cost 10 hashes to prove, not 1024. This is why the
    // statement carries a root rather than the list of receipt ids.
    expect(merkleProof(leaves(1024), 500)).toHaveLength(10);
  });

  it("refuses an index outside the set rather than returning a proof of nothing", () => {
    const set = leaves(4);
    expect(() => merkleProof(set, 4)).toThrow();
    expect(() => merkleProof(set, -1)).toThrow();
  });
});

describe("the wire form of a proof", () => {
  it("survives a base64url round trip, which is how it reaches a verifier", () => {
    const set = leaves(11);
    const root = merkleRoot(set)!;
    const proof = merkleProof(set, 7);
    const wire = proof.map((step) => ({ right: step.right, hash: bytesToBase64url(step.hash) }));
    const back = wire.map((step) => ({ right: step.right, hash: base64urlToBytes(step.hash) }));
    expect(verifyMerkleProof(set[7]!, back, root)).toBe(true);
  });
});
