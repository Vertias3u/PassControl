// Signed delegation: the chain rules (Bet D; plans/delegation-design.md §3–4, approved by
// the owner 2026-10-10 with P2's recommendations).
//
// An agent signs a short token handing a NARROWER slice of what it may do to a worker's
// own Ed25519 key; the worker may hand a narrower slice again (depth 2 at most). This
// module decides whether a chain of such tokens is valid against the root passport and
// the agent's CURRENT scope. It is pure: no clock but the one passed in, no store. The
// revocation half of rule 10 (a revoked jti, the agent's watermark) needs a store and is
// the caller's, using the `links` this returns.
//
// Every refusal names its reason. The reasons are for logs and tests; the exchange route
// answers one code for all of them, so a caller learns nothing about which rule it broke.
import { sha256 } from "@noble/hashes/sha256";
import { base64urlToBytes, bytesToBase64url, bytesToUtf8, utf8ToBytes } from "@/lib/encoding";
import { passportIdToPublicKey, verifySignature } from "@/lib/crypto/ed25519";
import { modelPatternIsUsable, scopeRuleMatch } from "@/lib/scope";
import type { ScopeEntry } from "@/lib/auth/visa";

export const DELEGATION_TYP = "passcontrol-delegation+jws";
/** Deepest chain the gateway accepts: the agent, a worker, a sub-worker. */
export const DELEGATION_MAX_DEPTH = 2;
/** The longest a single link may live. */
export const DELEGATION_MAX_LIFETIME_S = 24 * 3600;
const IAT_SKEW_S = 30;
// Input bounds, checked before any matching or signature work: the exchange route sits
// in front of authentication, so a request must not be able to buy unbounded parsing.
const MAX_LINK_CHARS = 8192;
const MAX_SCOPE_ENTRIES = 16;
const MAX_MODELS_PER_ENTRY = 32;
const MAX_PROVIDER_CHARS = 32;
const JTI_RE = /^[A-Za-z0-9_-]{16,64}$/;
const PROVIDER_RE = /^[a-z0-9_-]+$/;
const LINK_MEMBERS = ["iss", "sub", "aud", "jti", "iat", "exp", "dep", "max", "scope", "cap"];

export type DelegationRefusal =
  | "malformed"
  | "issuer"
  | "signature"
  | "audience"
  | "depth"
  | "scope"
  | "cap"
  | "expiry"
  | "parent_hash";

/** What a chain is checked against: the passport that signs link 1, as the agent stands NOW. */
export interface DelegationRoot {
  passportId: string;
  scope: readonly ScopeEntry[];
  /** The passport's expiry, or null when it has none. */
  expiresAtSeconds: number | null;
}

export interface DelegationLink {
  jti: string;
  iss: string;
  sub: string;
  iat: number;
  exp: number;
  dep: number;
  max: number;
  cap: number;
  scope: ScopeEntry[];
}

export type DelegationVerdict =
  | { ok: true; leaf: DelegationLink; links: DelegationLink[]; chainHash: string }
  | { ok: false; reason: DelegationRefusal };

/** SHA-256 of the links joined by commas (a comma never appears in a compact JWS), base64url. */
export function delegationChainHash(chain: readonly string[]): string {
  return bytesToBase64url(sha256(utf8ToBytes(chain.join(","))));
}

function decodeJson(part: string): unknown {
  return JSON.parse(bytesToUtf8(base64urlToBytes(part)));
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);

function readScope(value: unknown): ScopeEntry[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SCOPE_ENTRIES) return null;
  const out: ScopeEntry[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
    const { provider, models } = entry as Record<string, unknown>;
    if (Object.keys(entry).length !== 2) return null;
    if (typeof provider !== "string" || provider.length > MAX_PROVIDER_CHARS || !PROVIDER_RE.test(provider)) return null;
    if (!Array.isArray(models) || models.length < 1 || models.length > MAX_MODELS_PER_ENTRY) return null;
    if (!models.every((m) => typeof m === "string" && modelPatternIsUsable(m))) return null;
    out.push({ provider, models: [...(models as string[])] });
  }
  return out;
}

/** Decode one link's structure. Null on anything outside the format; no rule is judged here. */
function readLink(compact: string, position: number): (DelegationLink & { ph?: string; aud: string; signingInput: string; signature: Uint8Array }) | null {
  const [headerPart, payloadPart, signaturePart, ...rest] = compact.split(".");
  if (rest.length > 0 || !headerPart || !payloadPart || !signaturePart) return null;
  try {
    const header = decodeJson(headerPart);
    if (typeof header !== "object" || header === null || Array.isArray(header)) return null;
    const h = header as Record<string, unknown>;
    if (Object.keys(h).length !== 2 || h.alg !== "EdDSA" || h.typ !== DELEGATION_TYP) return null;
    const payload = decodeJson(payloadPart);
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
    const p = payload as Record<string, unknown>;
    const expected = position === 2 ? [...LINK_MEMBERS, "ph"] : LINK_MEMBERS;
    const keys = Object.keys(p);
    if (keys.length !== expected.length || !expected.every((k) => k in p)) return null;
    if (typeof p.iss !== "string" || typeof p.aud !== "string") return null;
    if (typeof p.sub !== "string" || p.sub.length !== 43 || !passportIdToPublicKey(p.sub)) return null;
    if (typeof p.jti !== "string" || !JTI_RE.test(p.jti)) return null;
    if (!isInt(p.iat) || !isInt(p.exp) || !isInt(p.dep) || !isInt(p.max)) return null;
    if (p.dep < 1 || p.max < 1 || p.max > 8) return null;
    if (!isInt(p.cap) || p.cap < 0) return null;
    if (position === 2 && (typeof p.ph !== "string" || p.ph.length !== 43)) return null;
    const scope = readScope(p.scope);
    if (!scope) return null;
    const signature = base64urlToBytes(signaturePart);
    if (signature.length !== 64) return null;
    return {
      jti: p.jti,
      iss: p.iss,
      sub: p.sub,
      aud: p.aud,
      iat: p.iat,
      exp: p.exp,
      dep: p.dep,
      max: p.max,
      cap: p.cap,
      scope,
      ...(position === 2 ? { ph: p.ph as string } : {}),
      signingInput: `${headerPart}.${payloadPart}`,
      signature,
    };
  } catch {
    return null;
  }
}

/**
 * Rule 6: the child may name only what the parent allows, and may not widen a pattern.
 * A child model is allowed when it is IDENTICAL to one of the parent's patterns for that
 * provider, or a literal (no `*`, no leading `~`) that a parent pattern matches. A
 * narrower wildcard (`claude-h*` under `claude-*`) is refused: proving glob ⊆ glob is not
 * worth the risk.
 */
function scopeNarrows(child: readonly ScopeEntry[], parent: readonly ScopeEntry[]): boolean {
  return child.every((entry) => {
    const parentEntries = parent.filter((p) => p.provider === entry.provider);
    if (parentEntries.length === 0) return false;
    return entry.models.every((model) => {
      if (parentEntries.some((p) => p.models.includes(model))) return true;
      if (model.includes("*") || model.startsWith("~")) return false;
      return scopeRuleMatch(parentEntries, entry.provider, model) !== null;
    });
  });
}

export function verifyDelegationChain(input: {
  chain: unknown;
  root: DelegationRoot;
  /** This instance's issuer: the audience every link must name. */
  audience: string;
  nowSeconds: number;
}): DelegationVerdict {
  const { chain, root, audience, nowSeconds: now } = input;
  if (!Array.isArray(chain) || chain.length < 1 || chain.length > DELEGATION_MAX_DEPTH) return { ok: false, reason: "malformed" };
  if (!chain.every((c) => typeof c === "string" && c.length <= MAX_LINK_CHARS)) return { ok: false, reason: "malformed" };
  const compacts = chain as string[];

  // The predecessor of link 1 is the root passport as the agent stands now.
  let parent = {
    key: root.passportId,
    scope: root.scope as readonly ScopeEntry[],
    cap: Number.POSITIVE_INFINITY,
    exp: root.expiresAtSeconds ?? Number.POSITIVE_INFINITY,
    max: DELEGATION_MAX_DEPTH,
  };
  const links: DelegationLink[] = [];
  for (const [i, compact] of compacts.entries()) {
    const position = i + 1;
    const link = readLink(compact, position);
    if (!link) return { ok: false, reason: "malformed" };
    // Rules 2–3. The key is taken by POSITION, never from the token: a link 2 signed by
    // the root key is refused although it is more powerful, because the chain says the
    // worker delegated.
    if (link.iss !== parent.key) return { ok: false, reason: "issuer" };
    const publicKey = passportIdToPublicKey(parent.key);
    if (!publicKey || !verifySignature(link.signature, utf8ToBytes(link.signingInput), publicKey)) {
      return { ok: false, reason: "signature" };
    }
    if (link.aud !== audience) return { ok: false, reason: "audience" };
    if (link.dep !== position || link.max > parent.max || link.dep > link.max) return { ok: false, reason: "depth" };
    if (!scopeNarrows(link.scope, parent.scope)) return { ok: false, reason: "scope" };
    if (link.cap > parent.cap) return { ok: false, reason: "cap" };
    if (
      link.iat > now + IAT_SKEW_S ||
      link.exp <= link.iat ||
      link.exp > parent.exp ||
      link.exp - link.iat > DELEGATION_MAX_LIFETIME_S ||
      now >= link.exp
    ) {
      return { ok: false, reason: "expiry" };
    }
    if (position === 2 && link.ph !== bytesToBase64url(sha256(utf8ToBytes(compacts[0] ?? "")))) {
      return { ok: false, reason: "parent_hash" };
    }
    const clean: DelegationLink = {
      jti: link.jti,
      iss: link.iss,
      sub: link.sub,
      iat: link.iat,
      exp: link.exp,
      dep: link.dep,
      max: link.max,
      cap: link.cap,
      scope: link.scope,
    };
    links.push(clean);
    parent = { key: link.sub, scope: link.scope, cap: link.cap, exp: link.exp, max: link.max };
  }
  const leaf = links[links.length - 1];
  if (!leaf) return { ok: false, reason: "malformed" };
  return { ok: true, leaf, links, chainHash: delegationChainHash(compacts) };
}

/**
 * Link 1's `iss`, read WITHOUT verifying anything: only to know which passport to look
 * up before the chain is checked against it. Null when it does not decode. The lookup's
 * answer is then verified in full by verifyDelegationChain, which takes the key by
 * position and never trusts this value.
 */
export function delegationRootHint(chain: unknown): string | null {
  if (!Array.isArray(chain) || typeof chain[0] !== "string" || chain[0].length > MAX_LINK_CHARS) return null;
  const payloadPart = chain[0].split(".")[1];
  if (!payloadPart) return null;
  try {
    const payload = decodeJson(payloadPart);
    const iss = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>).iss : null;
    return typeof iss === "string" && iss.length === 43 && passportIdToPublicKey(iss) ? iss : null;
  } catch {
    return null;
  }
}
