// Rotating the instance signing key twice must not retroactively make genuine
// receipts unverifiable.
//
// The whole promise of a receipt is that it stays checkable offline, forever,
// by someone who has no account here. Receipts carry no `exp`. So the day a
// deployment rotates its signing key for the second time, every receipt signed
// under the ORIGINAL key becomes a receipt whose `kid` the issuer no longer
// publishes — and the public verifier presents that as an accusation, not as a
// missing key. The signature is still mathematically valid; only the issuer's
// published key set moved.
//
// One scalar `INSTANCE_SIGNING_KEY_PREV` holds exactly one generation of
// history, so A→B keeps A and B→C drops A. This file walks a key through three
// generations while holding a receipt signed under the first one.
import { describe, it, expect, beforeEach } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";

import { bytesToBase64url } from "@/lib/encoding";
import { publicJwk, loadInstanceVerifiers } from "@/lib/crypto/instanceKey";
import { signReceipt } from "@/lib/receipt";
import { verifyReceipt } from "@/sdk/verify";
import { GET as jwksRoute } from "@/app/.well-known/jwks.json/route";

const ISSUER = "https://gw.example.com";

const A = new Uint8Array(32).fill(1);
const B = new Uint8Array(32).fill(2);
const C = new Uint8Array(32).fill(3);
const STRANGER = new Uint8Array(32).fill(4);

const seed = (s: Uint8Array) => bytesToBase64url(s);
/** The value an operator appends to the history: `<kid>:<x>`, public half only. */
const historyEntry = (s: Uint8Array) => {
  const jwk = publicJwk(ed25519.getPublicKey(s));
  return `${jwk.kid}:${jwk.x}`;
};

const INPUT = {
  receiptId: "11111111-2222-4333-8444-555555555555",
  passportId: "cGFzc3BvcnQ",
  agentId: "agent-1",
  visaJti: "visa-1",
  provider: "openai",
  model: "gpt-4o-mini",
  method: "POST",
  path: "v1/chat/completions",
  rawBody: JSON.stringify({ model: "gpt-4o-mini" }),
  inputTokens: 3,
  outputTokens: 5,
  costMicrocents: 100,
  status: "ok" as const,
  httpStatus: 200,
  startedAt: 1_700_000_000_000,
  latencyMs: 12,
};

/**
 * Verification reads the key set through the REAL route handler, so this proves
 * what the deployment publishes rather than what the loader happens to return.
 */
const throughPublishedJwks = () =>
  (async () => {
    const res = await jwksRoute();
    const body = await res.json();
    return { ok: true, status: 200, json: async () => body };
  }) as never;

const verify = (receipt: string) =>
  verifyReceipt(receipt, { trustedIssuers: [ISSUER], fetch: throughPublishedJwks() });

function configure({ current, prev, history }: { current: Uint8Array; prev?: Uint8Array; history?: string }) {
  process.env.INSTANCE_SIGNING_KEY = seed(current);
  if (prev) process.env.INSTANCE_SIGNING_KEY_PREV = seed(prev);
  else delete process.env.INSTANCE_SIGNING_KEY_PREV;
  if (history !== undefined) process.env.INSTANCE_SIGNING_KEY_HISTORY = history;
  else delete process.env.INSTANCE_SIGNING_KEY_HISTORY;
}

beforeEach(() => {
  process.env.PASSCONTROL_ISSUER = ISSUER;
  configure({ current: A });
});

describe("a receipt signed before two rotations", () => {
  it("still verifies after the issuer has rotated A → B → C", async () => {
    // Signed under A, on an ordinary day, by the real signing path.
    const receipt = signReceipt(INPUT)!;
    expect(await verify(receipt)).toMatchObject({ ok: true });

    // First rotation. B signs now; A's public half rides in _PREV.
    configure({ current: B, prev: A });
    expect(await verify(receipt)).toMatchObject({ ok: true });

    // Second rotation. C signs, B is the in-flight previous — and A has to live
    // somewhere durable or it is gone from the key set forever.
    configure({ current: C, prev: B, history: `${historyEntry(A)},${historyEntry(B)}` });
    expect(await verify(receipt)).toMatchObject({ ok: true });
  });

  it("is not laundered: a receipt signed by a key the issuer never had stays unknown", async () => {
    // The control. `unknown_key` is the right answer here and must keep being
    // the right answer — history that accepted anything would verify forgeries.
    configure({ current: STRANGER });
    const forged = signReceipt(INPUT)!;

    configure({ current: C, prev: B, history: `${historyEntry(A)},${historyEntry(B)}` });
    expect(await verify(forged)).toMatchObject({ ok: false, reason: "unknown_key" });
  });
});

describe("the retired-key history", () => {
  it("publishes every retired key alongside the current one", () => {
    configure({ current: C, prev: B, history: `${historyEntry(A)},${historyEntry(B)}` });
    const kids = loadInstanceVerifiers().map((v) => v.kid);

    expect(kids).toContain(publicJwk(ed25519.getPublicKey(A)).kid);
    expect(kids).toContain(publicJwk(ed25519.getPublicKey(B)).kid);
    expect(kids).toContain(publicJwk(ed25519.getPublicKey(C)).kid);
  });

  it("publishes a key named twice exactly once", () => {
    // B is both the in-flight _PREV and (correctly) already appended to the
    // permanent history. Publishing it twice is not wrong, but a duplicate kid
    // in a JWKS is the kind of thing strict verifiers reject.
    configure({ current: C, prev: B, history: historyEntry(B) });
    const kids = loadInstanceVerifiers().map((v) => v.kid);
    expect(kids).toHaveLength(2);
    expect(new Set(kids).size).toBe(2);
  });

  // THE trap this format exists to catch. A seed and an Ed25519 public key are
  // both 32 bytes, and every doc we ship trains the operator to paste a SEED
  // into a rotation variable. A history that accepted bare 32 bytes would take
  // the seed, derive a kid from seed bytes, publish a key nobody ever signed
  // with, and leave the real receipts failing exactly as before — silently, and
  // with the operator believing they had preserved them.
  it("refuses an entry whose kid does not match its key, which is what a pasted seed looks like", () => {
    const pastedSeed = ed25519.getPublicKey(A); // stand-in shape: right length, wrong role
    const realKid = publicJwk(ed25519.getPublicKey(A)).kid;
    configure({ current: C, history: `${realKid}:${bytesToBase64url(A)}` });
    expect(loadInstanceVerifiers().map((v) => v.kid)).toEqual([publicJwk(ed25519.getPublicKey(C)).kid]);
    // And the well-formed pair for the same key is accepted, so the rejection
    // above is about the mismatch and not about the format.
    configure({ current: C, history: `${publicJwk(pastedSeed).kid}:${bytesToBase64url(pastedSeed)}` });
    expect(loadInstanceVerifiers()).toHaveLength(2);
  });

  it.each(["", "   ", "garbage", "no-colon-here", "aaa:bbb", ":", "kid:"])(
    "ignores the malformed history entry %j rather than dropping the whole key set",
    (history) => {
      configure({ current: C, history });
      expect(loadInstanceVerifiers().map((v) => v.kid)).toEqual([publicJwk(ed25519.getPublicKey(C)).kid]);
    }
  );

  it("keeps the good entries when one entry in the list is malformed", () => {
    configure({ current: C, history: `garbage,${historyEntry(A)}` });
    expect(loadInstanceVerifiers()).toHaveLength(2);
  });

  it("accepts entries separated by whitespace and newlines as well as commas", () => {
    configure({ current: C, history: `${historyEntry(A)}\n  ${historyEntry(B)} ` });
    expect(loadInstanceVerifiers()).toHaveLength(3);
  });

  it("never publishes a private component for a history key", async () => {
    configure({ current: C, prev: B, history: historyEntry(A) });
    const keys = (await (await jwksRoute()).json()).keys as Record<string, unknown>[];

    expect(keys).toHaveLength(3);
    for (const jwk of keys) {
      expect(jwk.d).toBeUndefined();
      expect(Object.keys(jwk).sort()).toEqual(["alg", "crv", "kid", "kty", "use", "x"]);
    }
  });

  // History is public key material and must never become a signing path: a
  // retired PRIVATE seed left in configuration can mint new receipts backdated
  // under the old kid, which is the whole reason this variable takes public
  // halves rather than seeds.
  it("is never used for signing", () => {
    configure({ current: C, history: historyEntry(A) });
    const receipt = signReceipt(INPUT)!;
    const header = JSON.parse(Buffer.from(receipt.split(".")[0] ?? "", "base64url").toString());
    expect(header.kid).toBe(publicJwk(ed25519.getPublicKey(C)).kid);
  });
});
