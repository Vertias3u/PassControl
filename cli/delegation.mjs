// Signed delegation, client side (Bet D; plans/delegation-design.md §3, §8, §10).
//
// Plain ESM, shared by the SDK (sdk/passcontrol.ts, sdk/verify.ts) and the CLI, as
// cli/protocols.mjs is, so the two verifiers cannot disagree.
//
// - createDelegationLink: sign a link handing a worker's key a NARROWER slice. The
//   parent never holds the worker's private key: the worker generates its key and
//   sends only the public half.
// - checkDelegationChain: the offline half of the gateway's rules, for anyone holding
//   a chain. Signatures by position, issuers, depth, parent hashes, caps and expiries
//   that only narrow. NOT the scope against the agent's current scope: only the
//   gateway knows that, and it checked it when the worker exchanged the chain.
// - verifyReceiptDelegation: tie a worker's receipt (ver 3, auth.kind "delegated") to
//   the chain that authorised it.
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";

export const DELEGATION_TYP = "passcontrol-delegation+jws";
export const DELEGATION_MAX_DEPTH = 2;
export const DELEGATION_MAX_LIFETIME_S = 24 * 3600;
const IAT_SKEW_S = 30;
const MAX_LINK_CHARS = 8192;
const JTI_RE = /^[A-Za-z0-9_-]{16,64}$/;
const MEMBERS = ["iss", "sub", "aud", "jti", "iat", "exp", "dep", "max", "scope", "cap"];

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = typeof btoa !== "undefined" ? btoa(bin) : Buffer.from(bin, "binary").toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = typeof atob !== "undefined" ? atob(b64) : Buffer.from(b64, "base64").toString("binary");
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
const json = (part) => JSON.parse(dec.decode(fromB64url(part)));
const isInt = (v) => typeof v === "number" && Number.isSafeInteger(v);
const keyBytes = (id) => {
  try {
    const k = fromB64url(id);
    return typeof id === "string" && id.length === 43 && k.length === 32 ? k : null;
  } catch {
    return null;
  }
};

/** SHA-256 of the links joined by commas, base64url: what a receipt's `auth.ch` commits to. */
export function delegationChainHash(chain) {
  return b64url(sha256(enc.encode(chain.join(","))));
}

/** A fresh Ed25519 key for a worker. Keep `privateKey` in the worker; send only `publicKey`. */
export function generateWorkerKey() {
  const priv = ed25519.utils.randomPrivateKey();
  return { publicKey: b64url(ed25519.getPublicKey(priv)), privateKey: b64url(priv) };
}

function decodeLink(compact) {
  if (typeof compact !== "string" || compact.length > MAX_LINK_CHARS) return null;
  const [h, p, s, ...rest] = compact.split(".");
  if (rest.length || !h || !p || !s) return null;
  try {
    const header = json(h);
    if (!header || Object.keys(header).length !== 2 || header.alg !== "EdDSA" || header.typ !== DELEGATION_TYP) return null;
    const payload = json(p);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    const signature = fromB64url(s);
    if (signature.length !== 64) return null;
    return { payload, signingInput: `${h}.${p}`, signature };
  } catch {
    return null;
  }
}

/**
 * Sign one link. `parentChain` is the signer's own chain when a WORKER delegates on
 * (depth 2); omit it when the agent's passport signs. The local checks mirror the
 * gateway's, so a bad link fails here with a reason rather than at the exchange.
 * `unchecked` skips them (tests only): the gateway still refuses.
 */
export function createDelegationLink(opts) {
  const priv = fromB64url(opts.signerPrivateKey);
  if (priv.length !== 32) throw new Error("delegation: signerPrivateKey must encode 32 bytes");
  const derived = b64url(ed25519.getPublicKey(priv));
  const iss = opts.signerKeyId ?? derived;
  const parentChain = opts.parentChain ?? [];
  const now = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  const dep = parentChain.length + 1;
  let exp = now + Math.floor(opts.ttlSeconds);
  let max = opts.allowFurtherDelegation === false ? dep : DELEGATION_MAX_DEPTH;
  let ph;
  if (!opts.unchecked && dep > DELEGATION_MAX_DEPTH) {
    throw new Error(`delegation: depth ${dep} is past the maximum of ${DELEGATION_MAX_DEPTH}`);
  }
  if (parentChain.length > 0) {
    const parent = decodeLink(parentChain[parentChain.length - 1]);
    if (!parent) throw new Error("delegation: the parent chain does not decode");
    const p = parent.payload;
    exp = Math.min(exp, p.exp);
    max = Math.min(max, p.max);
    ph = b64url(sha256(enc.encode(parentChain[0])));
    if (!opts.unchecked) {
      if (p.sub !== iss) throw new Error("delegation: only the worker the parent link names may delegate on");
      if (opts.capMicrocents > p.cap) throw new Error("delegation: a link's cap cannot exceed its parent's cap");
      if (dep > p.max) throw new Error("delegation: the parent link does not allow further delegation");
    }
  }
  if (!opts.unchecked) {
    if (iss !== derived) throw new Error("delegation: signerKeyId is not the signer's key");
    if (!keyBytes(opts.workerPublicKey)) throw new Error("delegation: workerPublicKey must be a 32-byte key, base64url");
    if (!isInt(opts.capMicrocents) || opts.capMicrocents < 0) throw new Error("delegation: capMicrocents must be a non-negative integer");
    if (!(opts.ttlSeconds > 0) || exp - now > DELEGATION_MAX_LIFETIME_S) throw new Error("delegation: the lifetime must be between 1 second and 24 hours");
  }
  const jti = opts.jti ?? b64url(crypto.getRandomValues(new Uint8Array(18)));
  const payload = {
    iss,
    sub: opts.workerPublicKey,
    aud: opts.audience,
    jti,
    iat: now,
    exp,
    dep,
    max,
    ...(ph ? { ph } : {}),
    scope: opts.scope,
    cap: opts.capMicrocents,
  };
  const input = `${b64url(enc.encode(JSON.stringify({ alg: "EdDSA", typ: DELEGATION_TYP })))}.${b64url(enc.encode(JSON.stringify(payload)))}`;
  return `${input}.${b64url(ed25519.sign(enc.encode(input), priv))}`;
}

/**
 * The offline rules. `nowSeconds` omitted skips the time checks, which is what a
 * receipt needs: the receipt outlives its delegation, and its signature still holds.
 */
export function checkDelegationChain({ chain, rootPassportId, audience, nowSeconds }) {
  const fail = (reason) => ({ ok: false, reason });
  if (!Array.isArray(chain) || chain.length < 1 || chain.length > DELEGATION_MAX_DEPTH) return fail("malformed");
  let parent = { key: rootPassportId, cap: Infinity, exp: Infinity, max: DELEGATION_MAX_DEPTH };
  const links = [];
  for (let i = 0; i < chain.length; i++) {
    const position = i + 1;
    const link = decodeLink(chain[i]);
    if (!link) return fail("malformed");
    const p = link.payload;
    const expected = position === 2 ? [...MEMBERS, "ph"] : MEMBERS;
    if (Object.keys(p).length !== expected.length || !expected.every((k) => k in p)) return fail("malformed");
    if (!keyBytes(p.sub) || !JTI_RE.test(String(p.jti)) || ![p.iat, p.exp, p.dep, p.max, p.cap].every(isInt) || p.cap < 0) return fail("malformed");
    if (p.iss !== parent.key) return fail("issuer");
    const key = keyBytes(parent.key);
    let valid = false;
    try {
      valid = Boolean(key) && ed25519.verify(link.signature, enc.encode(link.signingInput), key);
    } catch {
      valid = false;
    }
    if (!valid) return fail("signature");
    if (audience !== undefined && p.aud !== audience) return fail("audience");
    if (p.dep !== position || p.max > parent.max || p.dep > p.max) return fail("depth");
    if (p.cap > parent.cap) return fail("cap");
    if (p.exp <= p.iat || p.exp > parent.exp || p.exp - p.iat > DELEGATION_MAX_LIFETIME_S) return fail("expiry");
    if (nowSeconds !== undefined && (p.iat > nowSeconds + IAT_SKEW_S || nowSeconds >= p.exp)) return fail("expiry");
    if (position === 2 && p.ph !== b64url(sha256(enc.encode(chain[0])))) return fail("parent_hash");
    links.push({ jti: p.jti, iss: p.iss, sub: p.sub, iat: p.iat, exp: p.exp, dep: p.dep, max: p.max, cap: p.cap, scope: p.scope });
    parent = { key: p.sub, cap: p.cap, exp: p.exp, max: p.max };
  }
  return { ok: true, leaf: links[links.length - 1], links, chainHash: delegationChainHash(chain) };
}

/**
 * A worker's receipt and the chain behind it: the chain is rooted in the receipt's
 * passport (`sub`), its hash is the receipt's `auth.ch`, its leaf is the worker in
 * `auth.act` under `auth.dlg`. Verify the receipt's signature first (verifyReceipt).
 */
export function verifyReceiptDelegation(claims, chain, options = {}) {
  void options.nowSeconds;
  const auth = claims && claims.auth;
  if (!auth || auth.kind !== "delegated") return { ok: false, reason: "not_delegated" };
  // No clock: a receipt outlives the delegation it was made under, and what it attests
  // (this chain authorised this worker when the gateway checked it) does not expire.
  const checked = checkDelegationChain({ chain, rootPassportId: claims.sub, audience: options.audience ?? claims.iss });
  if (!checked.ok) return checked;
  if (checked.chainHash !== auth.ch) return { ok: false, reason: "chain_hash" };
  if (checked.leaf.sub !== auth.act || checked.leaf.jti !== auth.dlg || checked.leaf.dep !== auth.dep) {
    return { ok: false, reason: "leaf" };
  }
  return { ok: true, chain: checked };
}
