# PassControl spend statement format

**Version 1.** This document is the contract. It is written so that someone with no access
to PassControl's source can implement a verifier, and check it against the recorded test
vector at the bottom.

A statement is a small signed document that commits to *every receipt a workspace issued in
one window*, linked to the window before it. A receipt proves one call happened; a statement
makes the record of all of them tamper-evident.

Producing statements is something a deployment does on a schedule. **Verifying one requires
nothing but this document, a SHA-256, and an Ed25519 verify** — no account, no API key, and
no contact with the issuer beyond fetching its public keys.

---

## 1. What a valid statement proves

Read this before implementing, because the easy mistake is to claim more.

**It proves:** the statement was signed by the issuer it names, with a key that issuer
publishes; the set of receipts it commits to was fixed at `iat` and cannot be changed
afterwards; and, given a receipt plus an inclusion proof, that the specific call is inside
that set.

**It does not prove the totals are correct.** Recomputing `root` requires every receipt JWS
in the window, which the holder of a statement does not have. A valid signature means the
issuer cannot revise what it committed to — not that it added up right.

**It does not vouch for the issuer.** Anyone can run PassControl and sign statements about
their own agents.

---

## 2. Envelope

An [RFC 7515](https://www.rfc-editor.org/rfc/rfc7515) **compact JWS**:
`BASE64URL(header) "." BASE64URL(payload) "." BASE64URL(signature)`.

| Header field | Value |
|---|---|
| `alg` | `EdDSA` (Ed25519). Anything else is a rejection, including `none`. |
| `typ` | `passcontrol-statement+jws` |
| `kid` | Key id, matching an entry in the issuer's JWKS |

`typ` is inside the signed header, so it cannot be changed to make an artifact of one kind
pass as another. A call receipt is `passcontrol-receipt+jwt` and **must not** verify here;
per [RFC 8725 §3.11](https://www.rfc-editor.org/rfc/rfc8725#section-3.11), check it
explicitly rather than assuming the claim shape will differ enough to notice.

Base64url throughout is unpadded, per RFC 7515 Appendix C.

---

## 3. Claims

```json
{
  "iss": "https://gateway.example.com",
  "sub": "1f0c…",
  "jti": "9a2e…",
  "iat": 1788549365,
  "fmt": "passcontrol.statement",
  "v": 1,
  "seq": 42,
  "per": { "from": 1788480000, "to": 1788566400 },
  "n": 118,
  "nr": 121,
  "cost": 4207713,
  "unp": 2,
  "unk": 1,
  "root": "V0hBVEVWRVJIQVNIR09FU0hFUkVBQUFBQUFBQUFBQQ",
  "pst": "cHJldmlvdXNzdGF0ZW1lbnRkaWdlc3Rnb2VzaGVyZQ",
  "by": [{ "agid": "…", "n": 118, "cost": 4207713 }]
}
```

| Claim | Meaning |
|---|---|
| `iss` | Issuer origin. Absolute `https://` with no path — the base for JWKS discovery. `http://` is acceptable **only** for loopback, so a local stack can issue and verify. |
| `sub` | The workspace this statement is about. |
| `jti` | Unique id for this statement. |
| `iat` | Signing time, epoch seconds. |
| `fmt` | Always `passcontrol.statement`. |
| `v` | Format version. **`v`, not `ver`** — see §7. |
| `seq` | Position in this workspace's chain, counting from 1. |
| `per` | The window, epoch seconds, **half-open `[from, to)`**. A call at exactly `to` belongs to the next window. |
| `n` | Calls the root covers. |
| `nr` | Rows the window actually held. **May exceed `n`.** |
| `cost` | Total for covered calls, in micro-cents (1 000 000 = $1). |
| `unp` | Calls known to be unpriceable. |
| `unk` | Calls with no recorded cost and no recorded reason. |
| `root` | base64url SHA-256 Merkle root over the covered receipts, or `null` when nothing was covered. |
| `pst` | Digest of the previous statement in this chain, or `null` at the head. |
| `by` | Per-agent subtotals. |

### The four honesty claims, and why a verifier must surface them

`nr > n`, `unp` and `unk` are not decoration. They are the statement's own account of what
it does not know:

- **`nr - n`** — logged calls that carried no receipt, so the root says nothing about them.
- **`unp`** — calls nobody could price. Their cost is **unknown, not zero**, and is excluded
  from `cost` rather than added as `0`.
- **`unk`** — calls with no recorded cost and no recorded reason.

A verifier that renders `n` and `cost` alone silently converts "we cannot say" into "zero".
Show all four or you have built a misleading tool.

---

## 4. The Merkle tree

`root` commits to the covered receipts **in ascending order of the underlying call's
timestamp, ties broken by call id** — the same order the proof is generated against.

Two rules, both load-bearing.

### Domain separation

```
leaf(receipt)      = SHA-256( 0x00 || UTF8(receipt_jws) )
node(left, right)  = SHA-256( 0x01 || left || right )
```

The receipt is hashed **as its exact compact JWS string**, the bytes as issued — not
re-encoded, not re-serialised, not trimmed.

The one-byte prefix stops a leaf hash being presented as an internal node. Without it an
attacker who controls a "receipt" can supply a value that is itself a valid concatenation of
two hashes and forge structure.

### Odd nodes are PROMOTED, not duplicated

At each level, pair nodes left to right. **If the level has an odd count, the last node
moves up to the next level unchanged.**

```
next_level = [ node(L[0],L[1]), node(L[2],L[3]), …,  L[last] if count is odd ]
```

Do **not** duplicate the last node to make a pair. That is the
[CVE-2012-2459](https://nvd.nist.gov/vuln/detail/CVE-2012-2459) second-preimage bug: with
duplication, two different sets of receipts can produce an identical root, which destroys the
only property the root has. Promotion is the fix and it is not optional.

A tree over zero receipts has **no root**. Statements with `n = 0` carry `root: null`; they
do not carry the hash of an empty string.

### Inclusion proof

A proof is an ordered list of steps from leaf to root:

```json
[ { "hash": "<base64url sibling>", "right": true }, … ]
```

`right: true` means *the sibling is on the right*, so the running value goes on the left.
Verify by:

```
node = leaf(receipt_jws)
for step in proof:
    sibling = base64url_decode(step.hash)
    node = step.right ? node(node, sibling) : node(sibling, node)
return node == base64url_decode(statement.root)
```

**A `false` means "not in *this* root" — never "not attested."** A receipt checked against
the wrong window's statement returns a perfectly truthful `false` that reads like an
accusation. Confirm the receipt's own timestamp falls inside that statement's `per` before
treating a negative as a finding.

---

## 5. The chain

```
pst(statement N) = BASE64URL( SHA-256( UTF8( compact JWS of statement N-1 ) ) )
```

The digest is over the **entire compact JWS** of the previous statement — all three
segments, dots included — exactly as that statement was issued.

`pst` is `null` only at `seq = 1`. To verify a chain, hold consecutive statements and check
each one's `pst` against the digest you compute from its predecessor. This is what makes a
whole missing window detectable: drop a day and the next day's link stops matching.

Verifying a **single** statement cannot check `pst`, because you do not have its predecessor.
That is expected, not a gap in the artifact.

---

## 6. Verification order

Fail at the first gate that refuses, and report *which* gate:

1. **parse** — three base64url segments; header and payload are JSON objects.
2. **algorithm** — header `alg` is exactly `EdDSA`.
3. **type** — header `typ` is exactly `passcontrol-statement+jws`.
4. **issuer** — `iss` is an absolute `https://` origin (or loopback `http://`), and is one
   you decided to trust *before* you read this document. **A verifier that trusts whichever
   issuer the artifact names is not verifying anything.**
5. **version** — `v` is not greater than the maximum you implement (§7).
6. **jwks** — fetch `{iss}/.well-known/jwks.json`.
7. **key** — the header `kid` is present in that key set.
8. **signature** — Ed25519 verify over `ASCII(header_b64 "." payload_b64)`.

Report a version you do not understand as **unchecked, not forged**. You are behind; the
statement is not wrong. The same goes for an unreachable key set — that says nothing about
the statement either way.

---

## 7. Versioning

Statements version on **`v`**. Receipts version on **`ver`**. They are separate number lines
that advance independently.

This trips implementations that share one verifier between both artifact types. Gating a
statement on the receipt's maximum would let a statement claiming `v: 2` through a verifier
that only understands statement v1, because the receipt line is already at 2. Gate each
artifact on its own claim.

A verifier for version 1 must refuse `v` greater than 1.

---

## 8. Test vector

The leaf hash is the single most likely thing to get wrong, so it is pinned. This exact
receipt string:

```
pc-receipt-vector.claims-v1.signature-v1
```

must produce this leaf:

```
ec983c6e10ba8fa942178ddfa6ecd48a7702c55289bf18cdb150ea25ec83a0b0
```

That is `SHA-256( 0x00 || UTF8("pc-receipt-vector.claims-v1.signature-v1") )` in hex, 32
bytes. If your implementation disagrees, stop — nothing downstream can be right.

The same vector is asserted from both sides inside PassControl:
`tests/statement-leaf.test.ts` computes it in TypeScript and, on a deployment that operates a
chain, `db/tests/statement_leaf_invariants.sql` computes it in SQL. Each demands the other's
answer byte for byte.

---

## 9. Reference implementations

All open, all in this repository:

| Where | What |
|---|---|
| `lib/merkle.ts` | Leaf, node, root, proof and proof-verification, with the promotion rule and its tests |
| `lib/statement.ts` | Claim shape, `STATEMENT_TYP`, `statementDigest` |
| `sdk/verify.ts` | `verifyStatement` and `verifyInclusion` — self-contained, depends only on `@noble` |
| `cli/verify.mjs` | A plain-ESM twin of the above, pinned to agree with it by test |
| `app/verify/statement/` | A browser verifier that runs entirely client-side |

From the command line, against any deployment:

```bash
passcontrol verify statement "<jws>" --issuer https://gateway.example.com
```

`--issuer` is required and has no default. That is gate 4 of §6, enforced.
