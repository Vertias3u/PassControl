/**
 * Binary Merkle tree over signed receipts.
 *
 * This is the commitment half of a signed spend statement: a statement carries
 * ONE root hash over every receipt in its window, so the set is fixed at signing
 * time and cannot be thinned afterwards — remove a receipt and the root no
 * longer matches the one that was already signed and chained.
 *
 * A root rather than a list of receipt ids, for two reasons. The statement stays
 * the same size whether the window held ten calls or ten million; and a tenant
 * who hands one statement to an auditor does not thereby hand over the id of
 * every other call they made that day. An auditor checks the one receipt they
 * hold with an inclusion proof, which is O(log n) and reveals only sibling
 * hashes.
 *
 * Everything here is pure and synchronous: no I/O, no clock, no config. That is
 * deliberate — this is the piece a third party re-implements to check our work,
 * so it must be describable in a paragraph.
 */
import { sha256 } from "@noble/hashes/sha256";

import { utf8ToBytes } from "@/lib/encoding";

/**
 * Domain separation. The two prefixes are the reason a leaf cannot be passed off
 * as an internal node: without them, an attacker who controls a receipt's bytes
 * could supply a value that is itself a valid `H(left || right)` preimage and
 * graft a forged subtree under a root we signed. One byte, and it closes the
 * whole class.
 */
export const LEAF_PREFIX = 0x00;
export const NODE_PREFIX = 0x01;

/** One step of the path from a leaf to the root. */
export interface MerkleProofStep {
  /** True when the sibling sits to the RIGHT of the node being folded. */
  right: boolean;
  hash: Uint8Array;
}

function hashWithPrefix(prefix: number, ...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 1);
  const buf = new Uint8Array(total);
  buf[0] = prefix;
  let at = 1;
  for (const part of parts) {
    buf.set(part, at);
    at += part.length;
  }
  return sha256(buf);
}

/**
 * The leaf for one receipt: a hash of the compact JWS exactly as it was signed
 * and stored.
 *
 * Hashing the whole JWS rather than a chosen subset of claims is what makes the
 * commitment total — cost, model, verdict, timestamps and the signature itself
 * are all inside it, so no field of a receipt can be edited without leaving the
 * tree. It also means the leaf is reproducible by anyone holding the receipt,
 * with no knowledge of our schema.
 */
export function merkleLeaf(receiptJws: string): Uint8Array {
  return hashWithPrefix(LEAF_PREFIX, utf8ToBytes(receiptJws));
}

function parent(left: Uint8Array, right: Uint8Array): Uint8Array {
  return hashWithPrefix(NODE_PREFIX, left, right);
}

/**
 * Fold one level. An odd node at the end is PROMOTED unchanged, never paired
 * with a copy of itself.
 *
 * Duplicating it is the well-known Bitcoin flaw (CVE-2012-2459): a set of three
 * and a set of four whose last element repeats then produce the same root, so a
 * phantom entry can be added to a window without moving the commitment. On a
 * tamper-evidence feature that is the entire attack. `tests/merkle.test.ts`
 * pins the two roots apart.
 */
function foldLevel(level: Uint8Array[]): Uint8Array[] {
  const next: Uint8Array[] = [];
  for (let i = 0; i < level.length; i += 2) {
    const left = level[i]!;
    const right = level[i + 1];
    next.push(right ? parent(left, right) : left);
  }
  return next;
}

/**
 * The root over an ordered set of leaves, or null when the set is empty.
 *
 * Null rather than a sentinel hash: a window with no calls is a real and normal
 * thing (a tenant took a day off), it still gets a signed statement so the chain
 * stays unbroken, and "there is no tree" is more honest than a magic value that
 * a careless verifier could confuse with a real commitment.
 *
 * Order matters and is the caller's responsibility — the statement job orders by
 * `(created_at, id)` so the root is reproducible from the table.
 */
export function merkleRoot(leaves: readonly Uint8Array[]): Uint8Array | null {
  if (leaves.length === 0) return null;
  // Copy: callers re-use their leaf array to build proofs afterwards, and a fold
  // that mutated it in place would silently corrupt the second call.
  let level = [...leaves];
  while (level.length > 1) level = foldLevel(level);
  return level[0]!;
}

/**
 * The sibling path proving `leaves[index]` is committed to by `merkleRoot(leaves)`.
 *
 * A promoted node contributes no step: it was carried up unchanged, so there is
 * nothing to hash against it. That is why a proof's length is not always
 * ceil(log2(n)) and why `tests/merkle.test.ts` sweeps every size up to 33 rather
 * than spot-checking a power of two — an off-by-one in the walk survives every
 * balanced tree and fails only where promotion happens.
 */
export function merkleProof(leaves: readonly Uint8Array[], index: number): MerkleProofStep[] {
  if (!Number.isInteger(index) || index < 0 || index >= leaves.length) {
    // Louder than returning []: an empty proof VERIFIES against a single-leaf
    // tree, so quietly returning one for an out-of-range index would turn a
    // caller's bug into a false claim of inclusion.
    throw new RangeError(`merkleProof: index ${index} outside 0..${leaves.length - 1}`);
  }
  const proof: MerkleProofStep[] = [];
  let level = [...leaves];
  let at = index;
  while (level.length > 1) {
    const isRightChild = at % 2 === 1;
    const siblingAt = isRightChild ? at - 1 : at + 1;
    const sibling = level[siblingAt];
    // No sibling means this node was promoted; nothing to record.
    if (sibling) proof.push({ right: !isRightChild, hash: sibling });
    level = foldLevel(level);
    at = Math.floor(at / 2);
  }
  return proof;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Re-derive a root from a leaf and its path, and compare.
 *
 * Not constant-time on purpose: every input here is public — a receipt the
 * holder already has, sibling hashes, and a root inside a signed statement.
 * There is no secret to leak through timing, and pretending otherwise would
 * imply a protection this does not provide.
 */
export function verifyMerkleProof(
  leaf: Uint8Array,
  proof: readonly MerkleProofStep[],
  root: Uint8Array
): boolean {
  let node = leaf;
  for (const step of proof) {
    node = step.right ? parent(node, step.hash) : parent(step.hash, node);
  }
  return sameBytes(node, root);
}
