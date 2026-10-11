// Bet D (owner-approved design plans/delegation-design.md §3–4, built 2026-10-10).
// The chain rules, pure: the spike's 17 cases ported to vitest, plus the input bounds
// the exchange route relies on. Every refusal names its reason, so a test cannot pass
// by refusing for the wrong one.
import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import {
  DELEGATION_TYP,
  delegationChainHash,
  verifyDelegationChain,
  type DelegationRoot,
} from "@/lib/delegation/chain";

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const enc = (v: unknown) => b64(new TextEncoder().encode(JSON.stringify(v)));
const key = () => {
  const priv = ed25519.utils.randomPrivateKey();
  return { priv, id: b64(ed25519.getPublicKey(priv)) };
};
function sign(priv: Uint8Array, payload: Record<string, unknown>, header: Record<string, unknown> = { alg: "EdDSA", typ: DELEGATION_TYP }) {
  const input = `${enc(header)}.${enc(payload)}`;
  return `${input}.${b64(ed25519.sign(new TextEncoder().encode(input), priv))}`;
}

const AUD = "https://gw.example";
const NOW = 1_800_000_000;
const root = key();
const worker = key();
const sub2 = key();
const ROOT: DelegationRoot = {
  passportId: root.id,
  scope: [
    { provider: "anthropic", models: ["claude-*"] },
    { provider: "openai", models: ["gpt-5-mini"] },
  ],
  expiresAtSeconds: null,
};
const jti = (n: number) => `jti-${String(n).padStart(16, "0")}`;
function link1(over: Record<string, unknown> = {}) {
  return {
    iss: root.id,
    sub: worker.id,
    aud: AUD,
    jti: jti(1),
    iat: NOW - 10,
    exp: NOW + 3600,
    dep: 1,
    max: 2,
    scope: [{ provider: "anthropic", models: ["claude-haiku-4-5", "claude-*"] }],
    cap: 50_000_000,
    ...over,
  };
}
function link2(first: string, over: Record<string, unknown> = {}) {
  return {
    iss: worker.id,
    sub: sub2.id,
    aud: AUD,
    jti: jti(2),
    iat: NOW - 5,
    exp: NOW + 1800,
    dep: 2,
    max: 2,
    ph: b64(sha256(new TextEncoder().encode(first))),
    scope: [{ provider: "anthropic", models: ["claude-haiku-4-5"] }],
    cap: 10_000_000,
    ...over,
  };
}
const verify = (chain: unknown, root: DelegationRoot = ROOT, now = NOW) =>
  verifyDelegationChain({ chain, root, audience: AUD, nowSeconds: now });
const reason = (r: ReturnType<typeof verify>) => (r.ok ? "ok" : r.reason);

describe("verifyDelegationChain: chains that verify", () => {
  it("a one-link chain names the worker, its scope, cap and the link's jti", () => {
    const l1 = sign(root.priv, link1());
    const r = verify([l1]);
    expect(r).toMatchObject({
      ok: true,
      leaf: { sub: worker.id, jti: jti(1), dep: 1, cap: 50_000_000, exp: NOW + 3600 },
      links: [{ jti: jti(1), cap: 50_000_000, iat: NOW - 10, sub: worker.id }],
      chainHash: delegationChainHash([l1]),
    });
    if (r.ok) expect(r.leaf.scope).toEqual([{ provider: "anthropic", models: ["claude-haiku-4-5", "claude-*"] }]);
  });

  it("a two-link chain: the sub-worker, narrower again, both links' caps root first", () => {
    const l1 = sign(root.priv, link1());
    const l2 = sign(worker.priv, link2(l1));
    const r = verify([l1, l2]);
    expect(r).toMatchObject({ ok: true, leaf: { sub: sub2.id, jti: jti(2), dep: 2, cap: 10_000_000 } });
    if (r.ok) expect(r.links.map((l) => [l.jti, l.cap])).toEqual([[jti(1), 50_000_000], [jti(2), 10_000_000]]);
  });
});

describe("verifyDelegationChain: every narrowing rule", () => {
  it.each([
    ["widened scope: a provider the parent lacks", { scope: [{ provider: "groq", models: ["x"] }] }, "scope"],
    ["widened scope: a model outside the parent", { scope: [{ provider: "anthropic", models: ["gpt-5"] }] }, "scope"],
    ["raised cap", { cap: 60_000_000 }, "cap"],
    ["later expiry", { exp: NOW + 3700 }, "expiry"],
    ["max raised at link 2", { max: 3 }, "depth"],
    ["dep not its position", { dep: 1 }, "depth"],
  ])("link 2 with %s is refused", (_label, over, why) => {
    const l1 = sign(root.priv, link1());
    expect(reason(verify([l1, sign(worker.priv, link2(l1, over))]))).toBe(why);
  });

  it("a child wildcard under a parent wildcard is refused, even when narrower in fact", () => {
    const l1 = sign(root.priv, link1());
    expect(reason(verify([l1, sign(worker.priv, link2(l1, { scope: [{ provider: "anthropic", models: ["claude-h*"] }] }))]))).toBe("scope");
  });

  it("an identical wildcard is allowed: the same pattern is not wider", () => {
    const l1 = sign(root.priv, link1());
    expect(reason(verify([l1, sign(worker.priv, link2(l1, { scope: [{ provider: "anthropic", models: ["claude-*"] }] }))]))).toBe("ok");
  });

  it("a link-1 literal outside the agent's current glob is refused", () => {
    expect(reason(verify([sign(root.priv, link1({ scope: [{ provider: "openai", models: ["gpt-5"] }] }))]))).toBe("scope");
  });

  it("depth 3 is refused, and so is a link 2 when link 1 said max 1", () => {
    const l1 = sign(root.priv, link1());
    const l2 = sign(worker.priv, link2(l1));
    expect(reason(verify([l1, l2, l2]))).toBe("malformed");
    const l1max1 = sign(root.priv, link1({ max: 1 }));
    expect(reason(verify([l1max1, sign(worker.priv, link2(l1max1, { max: 1 }))]))).toBe("depth");
  });
});

describe("verifyDelegationChain: who signed what", () => {
  it("a wrong issuer is refused", () => {
    expect(reason(verify([sign(root.priv, link1({ iss: worker.id }))]))).toBe("issuer");
  });
  it("a link 2 signed by the ROOT key is refused: the chain says the worker delegated", () => {
    const l1 = sign(root.priv, link1());
    expect(reason(verify([l1, sign(root.priv, link2(l1))]))).toBe("signature");
  });
  it("a tampered payload is refused", () => {
    const l1 = sign(root.priv, link1());
    const [h, , s] = l1.split(".");
    expect(reason(verify([`${h}.${enc(link1({ cap: 99_000_000 }))}.${s}`]))).toBe("signature");
  });
  it("a spliced link 2 (ph names another link 1) is refused", () => {
    const l1 = sign(root.priv, link1());
    const other = sign(root.priv, link1({ jti: jti(9) }));
    expect(reason(verify([l1, sign(worker.priv, link2(other))]))).toBe("parent_hash");
  });
  it("ph on link 1 is refused", () => {
    expect(reason(verify([sign(root.priv, link1({ ph: "x".repeat(43) }))]))).toBe("malformed");
  });
  it("a foreign audience is refused", () => {
    expect(reason(verify([sign(root.priv, link1({ aud: "https://other.example" }))]))).toBe("audience");
  });
  it.each([
    [{ alg: "none", typ: DELEGATION_TYP }],
    [{ alg: "EdDSA", typ: "JWT" }],
    [{ alg: "EdDSA", typ: DELEGATION_TYP, kid: "x" }],
    [{ alg: "HS256", typ: DELEGATION_TYP }],
  ])("header confusion %j is refused", (header) => {
    expect(reason(verify([sign(root.priv, link1(), header)]))).toBe("malformed");
  });
});

describe("verifyDelegationChain: time", () => {
  it("an expired link is refused", () => {
    expect(reason(verify([sign(root.priv, link1())], ROOT, NOW + 3600))).toBe("expiry");
  });
  it("a lifetime over 24 hours is refused", () => {
    expect(reason(verify([sign(root.priv, link1({ exp: NOW - 10 + 86_401 }))]))).toBe("expiry");
  });
  it("a link outliving the passport is refused", () => {
    expect(reason(verify([sign(root.priv, link1())], { ...ROOT, expiresAtSeconds: NOW + 60 }))).toBe("expiry");
  });
  it("a link issued in the future beyond 30 seconds of skew is refused", () => {
    expect(reason(verify([sign(root.priv, link1({ iat: NOW + 31 }))]))).toBe("expiry");
  });
});

describe("verifyDelegationChain: bounded input", () => {
  it.each([
    ["not an array", "x"],
    ["empty", []],
    ["a non-string link", [42]],
    ["an oversized link", ["a".repeat(8193)]],
    ["two dots missing", ["abc"]],
  ])("%s is malformed", (_l, chain) => {
    expect(reason(verify(chain))).toBe("malformed");
  });
  it("too many scope entries or patterns are refused before matching", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ provider: "anthropic", models: [`claude-${i}`] }));
    expect(reason(verify([sign(root.priv, link1({ scope: many }))]))).toBe("malformed");
  });
  it.each([
    ["a fractional cap", { cap: 1.5 }],
    ["a negative cap", { cap: -1 }],
    ["a short jti", { jti: "short" }],
    ["a sub that is not a key", { sub: "nope" }],
    ["an unknown member", { extra: true }],
  ])("%s is malformed", (_l, over) => {
    expect(reason(verify([sign(root.priv, link1(over))]))).toBe("malformed");
  });
});

describe("delegationChainHash", () => {
  it("is SHA-256 of the links joined by commas, base64url", () => {
    expect(delegationChainHash(["a.b.c", "d.e.f"])).toBe(b64(sha256(new TextEncoder().encode("a.b.c,d.e.f"))));
  });
});
