// Verifying what PassControl signs — from outside PassControl.
//
// This is the half of the system that runs on someone ELSE'S machine. A party
// handed a signed call receipt fetches the issuer's JWK Set once and verifies
// offline: no account here, no callback, and it keeps working after the issuing
// deployment is gone.
//
// Dependencies: only @noble/curves + the platform `fetch`. Runs on Node 18+,
// edge runtimes, and the browser.
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { RECEIPT_PROTOCOL, STATEMENT_PROTOCOL } from "../cli/protocols.mjs";

export const RECEIPT_TYP = "passcontrol-receipt+jwt";
export const AGENT_TOKEN_TYP = "passcontrol-agent+jwt";

/** The newest artifact version this verifier understands. */
export const SUPPORTED_VER = RECEIPT_PROTOCOL.maximum;

export type VerifyFailure =
  | "malformed"
  | "untrusted_issuer"
  | "unknown_key"
  | "bad_signature"
  | "wrong_type"
  | "unsupported_version"
  | "jwks_unreachable"
  | "expired"
  | "wrong_audience"
  | "revoked"
  | "status_unavailable";

export type VerifyResult<T> = { ok: true; claims: T } | { ok: false; reason: VerifyFailure };

/**
 * The checks this verifier runs, in the order it runs them. Exposed so a UI can
 * show what it actually did rather than a spinner — see `onStep`.
 */
export type VerifyStepName =
  | "parse"
  | "algorithm"
  | "type"
  | "issuer"
  | "version"
  | "jwks"
  | "key"
  | "signature";

export interface VerifyStep {
  step: VerifyStepName;
  ok: boolean;
  /** Present only on the failing step; equals the reason the caller receives. */
  reason?: VerifyFailure;
  /** Real elapsed milliseconds for this step. Not a target, not a minimum. */
  ms: number;
}

export interface ReceiptClaims {
  iss: string;
  sub: string;
  jti: string;
  iat: number;
  agid: string;
  vjti?: string;
  auth?:
    | { kind: "direct_key"; kid: string; use: string }
    | { kind: "passport_proof_per_request" };
  prov: string;
  mdl: string | null;
  mth: string;
  path: string;
  req?: { alg: string; dig: string; len: number };
  /**
   * Tokens the call consumed. `in` is the provider's own uncached input count;
   * `cr` / `cw` are prompt-cache reads and writes, present only when the provider
   * reported them, so the whole input is `in + (cr ?? 0) + (cw ?? 0)`. Do not sum
   * them into `in` — it is already exclusive of both, and `cost` covers all three.
   *
   * Added after v2 shipped and readable by verifiers that predate them, because
   * unknown claims inside a supported version are ignored by design.
   */
  use: { in: number; out: number; cr?: number; cw?: number };
  cost: number;
  /**
   * Present and true only when the gateway could not price this call: it went to
   * a custom endpoint, which may mark up, re-route, alias onto a local model, or
   * be free. `cost` is then 0 because this field is required, AND THAT ZERO MEANS
   * NOTHING — do not add it to a total or report it as a free call.
   *
   * Optional and added like `cr` / `cw` above, so receipts that predate it are
   * unaffected and verifiers that predate it ignore it by design.
   */
  unp?: boolean;
  res: { status: string; http: number };
  t0: number;
  lat: number;
  /** Revision of the effective live policy, scope and budget rules. */
  pol?: string;
  own?: { kind: string; sub: string; tier: string; vat: string | null };
  /**
   * Present only on an attempt that followed a failed one: the `jti` of the
   * receipt for the attempt this one replaced. Walk it backwards to read the
   * whole chain — a receipt binds ONE call to ONE provider decision, so a
   * failover is two receipts linked, never one compound artifact.
   *
   * Both attempts carry the same `req` digest, because that digest covers the
   * bytes the CLIENT sent and those do not change between attempts. Matching
   * two receipts by a shared digest is therefore a guess; this claim is the
   * link.
   *
   * Optional, and `ver` stays 1: a verifier that predates these claims ignores
   * what it does not recognise, and must not be invalidated for a feature it
   * does not need to understand.
   */
  prev?: string;
  /**
   * Why the gateway moved on. An allowlisted enum at the issuing end, but treat
   * it as an arbitrary string here — a receipt you verify may come from a
   * different deployment or a newer version. Do not switch on it exhaustively.
   *
   * `upstream_5xx` and `unreachable` are the values where the attempt this
   * receipt replaced MAY ALREADY HAVE BEEN BILLED by the other provider: it may
   * have run the call before failing, and no one can tell. The other values mean
   * the earlier provider refused before doing any work.
   */
  why?: string;
  ver: number;
  [claim: string]: unknown;
}

export interface AgentTokenClaims {
  iss: string;
  sub: string;
  aud: string;
  jti: string;
  iat: number;
  exp: number;
  agid: string;
  own?: { kind: string; sub: string; tier: string; vat: string | null } | null;
  ver: number;
  [claim: string]: unknown;
}

export interface VerifyOptions {
  /**
   * Origins whose signatures this verifier accepts. REQUIRED, with no default,
   * ever — a verifier that trusts whatever issuer the token names is not
   * verifying anything. Compared by exact string match (see matchesIssuer).
   */
  trustedIssuers: string[];
  fetch?: typeof fetch;
  /** Cache of issuer origin -> JWK Set, reused across calls. */
  jwksCache?: Map<string, PublicJwk[]>;
  /**
   * Called as each check resolves, in order, stopping at the first failure.
   *
   * Purely observational: supplying it cannot change the outcome, and a callback
   * that throws is swallowed rather than turned into a verification failure — a
   * presentation bug must never be able to answer a security question.
   *
   * Note the trace covers the SIGNATURE checks only. verifyAgentToken's audience
   * and expiry checks run after these and are not reported here.
   */
  onStep?: (step: VerifyStep) => void;
}

export interface PublicJwk {
  kty: string;
  crv: string;
  x: string;
  alg?: string;
  use?: string;
  kid?: string;
}

const b64urlToBytes = (value: string): Uint8Array => {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const utf8 = (s: string) => new TextEncoder().encode(s);

/**
 * Exact string match, deliberately. Prefix or substring matching here is the
 * classic issuer-confusion bug: `https://good.com.evil.com` starts with nothing
 * useful but ends the way a naive `endsWith` would like, and
 * `https://evil.com/?x=https://good.com` contains a trusted origin outright.
 * A trailing slash is the one normalisation worth allowing.
 */
export function matchesIssuer(iss: string, trusted: string[]): boolean {
  const strip = (v: string) => v.replace(/\/+$/, "");
  return trusted.some((candidate) => strip(candidate) === strip(iss));
}

async function loadJwks(
  issuer: string,
  options: VerifyOptions,
  revalidate = false
): Promise<PublicJwk[] | null> {
  if (!revalidate) {
    const cached = options.jwksCache?.get(issuer);
    if (cached) return cached;
  }

  const fetchImpl = options.fetch ?? fetch;
  try {
    // `no-cache` means "revalidate with the origin", not "do not cache" — an
    // unchanged key set still answers 304, so the retry below is cheap.
    const res = await fetchImpl(
      new URL("/.well-known/jwks.json", issuer).toString(),
      revalidate ? { cache: "no-cache" } : undefined
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { keys?: PublicJwk[] };
    const keys = Array.isArray(body?.keys) ? body.keys : [];
    options.jwksCache?.set(issuer, keys);
    return keys;
  } catch {
    return null;
  }
}

const selectCandidates = (keys: PublicJwk[], kid?: string): PublicJwk[] =>
  keys.filter(
    (key) =>
      key?.kty === "OKP" &&
      key?.crv === "Ed25519" &&
      typeof key.x === "string" &&
      (!kid || !key.kid || key.kid === kid)
  );

/** Monotonic where available; wall clock is an acceptable fallback for a UI timer. */
const nowMs = (): number =>
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();

/**
 * Emits one VerifyStep per gate, timing each from the end of the previous one.
 * Returns a no-op when no consumer asked for a trace, so the untraced path pays
 * nothing — not even a clock read.
 */
function tracer(onStep: VerifyOptions["onStep"]) {
  if (!onStep) return () => {};
  let previous = nowMs();
  return (step: VerifyStepName, ok: boolean, reason?: VerifyFailure) => {
    const at = nowMs();
    const ms = at - previous;
    previous = at;
    try {
      onStep(reason === undefined ? { step, ok, ms } : { step, ok, reason, ms });
    } catch {
      // Deliberately swallowed. See onStep's contract.
    }
  };
}

/**
 * Which claim carries the artifact's version, and the newest value understood.
 *
 * Receipts version themselves with `ver`; statements use `v` and have their own
 * version line entirely. Without this parameter a statement would flow through
 * the receipt's gate, find no `ver`, read as version 0 and be accepted whatever
 * it claimed — so a future statement v2 would pass a v1 verifier silently. That
 * is the exact forward-compatibility failure SUPPORTED_VER exists to prevent.
 *
 * The default reproduces the receipt behaviour byte for byte, so the
 * verifyReceipt call site is unchanged.
 */
interface VersionGate {
  claim: "ver" | "v";
  max: number;
}

async function verifySigned<T extends { iss?: unknown; ver?: unknown; v?: unknown }>(
  token: string,
  typ: string,
  options: VerifyOptions,
  version: VersionGate = { claim: "ver", max: SUPPORTED_VER }
): Promise<VerifyResult<T>> {
  const trace = tracer(options.onStep);

  // Each gate below reports through `fail`, so the emitted reason and the
  // returned reason cannot drift apart.
  const fail = (step: VerifyStepName, reason: VerifyFailure): { ok: false; reason: VerifyFailure } => {
    trace(step, false, reason);
    return { ok: false, reason };
  };

  const parts = token.split(".");
  if (parts.length !== 3) return fail("parse", "malformed");
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  if (!headerPart || !payloadPart || !signaturePart) return fail("parse", "malformed");

  let header: { alg?: string; typ?: string; kid?: string };
  let claims: T;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(headerPart)));
    claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(payloadPart)));
  } catch {
    return fail("parse", "malformed");
  }
  trace("parse", true);

  // EdDSA is pinned, never read from the token. A verifier that dispatches on
  // the token's own `alg` accepts alg:"none", and accepts an HS256 MAC computed
  // over the public key it just fetched from the JWKS — the key material is
  // public, so the "secret" is known to the attacker. That single mistake turns
  // this whole mechanism into decoration.
  if (header.alg !== "EdDSA") return fail("algorithm", "bad_signature");
  trace("algorithm", true);

  // RFC 8725 explicit typing: a historical receipt must never satisfy a live
  // authentication decision, and both are signed by the same key.
  if (header.typ !== typ) return fail("type", "wrong_type");
  trace("type", true);

  const iss = typeof claims.iss === "string" ? claims.iss : "";
  if (!iss || !matchesIssuer(iss, options.trustedIssuers)) {
    return fail("issuer", "untrusted_issuer");
  }
  trace("issuer", true);

  // Additive-only versioning: a NEWER artifact than we understand is refused
  // (it may rely on a claim we would ignore), but unknown claims within a
  // supported version are fine — that is what lets the issuer add a field
  // without invalidating verifiers already in the field.
  const declared = (claims as Record<string, unknown>)[version.claim];
  const ver = typeof declared === "number" ? declared : 0;
  if (ver > version.max) return fail("version", "unsupported_version");
  trace("version", true);

  const keys = await loadJwks(iss, options);
  if (!keys) return fail("jwks", "jwks_unreachable");
  trace("jwks", true);

  let candidates = selectCandidates(keys, header.kid);
  if (candidates.length === 0) {
    // Before saying an issuer does not publish this key — which is presented as
    // a forgery — go back to the origin once, bypassing any HTTP cache. The
    // JWKS ships `max-age=300, stale-while-revalidate=86400`, so a browser can
    // hold a key list a day old; across a key rotation that list is missing the
    // NEW key, and a genuine receipt signed minutes ago resolves to unknown_key.
    // (INSTANCE_SIGNING_KEY_PREV keeps OLD keys published for the reverse case.)
    // The retry is the price of an accusation, not of verification: it only runs
    // on the path that was about to make one, and an unchanged key set answers
    // 304. If it fails we keep `unknown_key` — we did reach the issuer and did
    // read a key list, so "could not reach" would misdescribe what happened.
    const fresh = await loadJwks(iss, options, true);
    if (fresh) candidates = selectCandidates(fresh, header.kid);
  }
  if (candidates.length === 0) return fail("key", "unknown_key");
  trace("key", true);

  const signature = b64urlToBytes(signaturePart);
  const signed = utf8(`${headerPart}.${payloadPart}`);
  for (const key of candidates) {
    try {
      if (ed25519.verify(signature, signed, b64urlToBytes(key.x))) {
        trace("signature", true);
        return { ok: true, claims };
      }
    } catch {
      // Try the next key; a malformed JWK entry must not abort verification.
    }
  }
  return fail("signature", "bad_signature");
}

/**
 * Verify a signed call receipt.
 *
 * What a valid receipt proves: this issuer attests that the named passport or
 * Direct Agent Key authenticated this call, with this verdict and this cost.
 * `auth.kind === "passport_proof_per_request"` additionally attests that the
 * gateway verified the passport proof for this exact request. A direct receipt
 * proves bearer possession, not a passport signature. It does
 * NOT prove:
 * anything about the response, and nothing at all by its absence — see
 * lib/receipt.ts for the limits, which are deliberate and documented.
 */
export function verifyReceipt(
  jws: string,
  options: VerifyOptions
): Promise<VerifyResult<ReceiptClaims>> {
  return verifySigned<ReceiptClaims>(jws, RECEIPT_TYP, options);
}

// ── Signed spend statements ────────────────────────────────────────────────

export const STATEMENT_TYP = "passcontrol-statement+jws";

/** The newest statement version this verifier understands. See STATEMENT_PROTOCOL. */
export const STATEMENT_SUPPORTED_VER = STATEMENT_PROTOCOL.maximum;

/** One agent's slice of a statement. `agid` is null for a deleted agent. */
export interface StatementAgentSubtotal {
  agid: string | null;
  n: number;
  cost: number;
}

export interface StatementClaims {
  iss: string;
  sub: string;
  jti: string;
  iat: number;
  fmt: string;
  v: number;
  /** Position in this workspace's chain. */
  seq: number;
  /** Half-open window `[from, to)`, epoch seconds. */
  per: { from: number; to: number };
  /** Calls the root covers. */
  n: number;
  /** Total rows in the window — may EXCEED `n`; the difference is disclosed, not hidden. */
  nr: number;
  cost: number;
  /** Calls known to be unpriceable. Their cost is unknowable, not zero. */
  unp: number;
  /** Calls whose cost was never recorded, reason unrecorded. Also not zero. */
  unk: number;
  /** base64url SHA-256 Merkle root, or null when the window covered nothing. */
  root: string | null;
  /** Digest of the previous statement's JWS; null at the head of a chain. */
  pst: string | null;
  by: StatementAgentSubtotal[];
}

/** One step of an inclusion path. `hash` is raw bytes or base64url. */
export interface InclusionProofStep {
  right: boolean;
  hash: Uint8Array | string;
}

/**
 * Verify a signed spend statement.
 *
 * WHAT A VALID STATEMENT PROVES: this issuer committed to a fixed set of
 * receipts for the named window at the time it signed, and — via `pst` — that
 * this statement follows a specific earlier one. Nothing was removed from or
 * reordered in the chain without breaking that link.
 *
 * WHAT IT DOES NOT PROVE, and the distinction matters: it is NOT an independent
 * audit of `cost` or `n`. Recomputing `root` requires every receipt in the
 * window, which the holder of a statement does not have. A valid statement means
 * the issuer cannot now change what it committed to — not that the totals were
 * right when they were computed.
 */
export function verifyStatement(
  jws: string,
  options: VerifyOptions
): Promise<VerifyResult<StatementClaims>> {
  return verifySigned<StatementClaims>(jws, STATEMENT_TYP, options, {
    claim: "v",
    max: STATEMENT_SUPPORTED_VER,
  });
}

/**
 * Check that a receipt is one of the leaves a statement's root commits to.
 *
 * READ WHAT `false` MEANS BEFORE ACTING ON IT. It means "not in THIS root" — not
 * "not attested". Pairing a receipt with the wrong day's statement returns a
 * perfectly truthful `false` that reads like an accusation, and nothing in this
 * signature stops a caller doing that: `root` and `proof` come from a statement
 * the caller chose. Confirm the receipt's own timestamp falls inside that
 * statement's `per` window before treating a `false` as a finding.
 *
 * Verification is pure and offline — no fetch, no clock, no key. Give it the
 * receipt's compact JWS exactly as issued, the proof steps from the control API,
 * and the statement's `root`.
 */
export function verifyInclusion(
  receiptJws: string,
  proof: readonly InclusionProofStep[],
  root: Uint8Array | string
): boolean {
  const asBytes = (v: Uint8Array | string) => (typeof v === "string" ? b64urlToBytes(v) : v);
  // Same domain separation as lib/merkle.ts, restated rather than imported: this
  // file is vendored by people who take `sdk/` alone, so it must stand up with
  // nothing but @noble/curves and the platform.
  const hash = (prefix: number, ...parts: Uint8Array[]) => {
    const total = parts.reduce((sum, p) => sum + p.length, 1);
    const buf = new Uint8Array(total);
    buf[0] = prefix;
    let at = 1;
    for (const p of parts) {
      buf.set(p, at);
      at += p.length;
    }
    return sha256(buf);
  };

  try {
    let node = hash(0x00, utf8(receiptJws));
    for (const step of proof) {
      const sibling = asBytes(step.hash);
      node = step.right ? hash(0x01, node, sibling) : hash(0x01, sibling, node);
    }
    const target = asBytes(root);
    if (node.length !== target.length) return false;
    for (let i = 0; i < node.length; i++) if (node[i] !== target[i]) return false;
    return true;
  } catch {
    // A malformed proof step or root is "not proven", never a throw into a
    // caller's verification path.
    return false;
  }
}

export interface VerifyAgentTokenOptions extends VerifyOptions {
  /** The audience YOU are. Required: a token minted for someone else is not for you. */
  audience: string;
  /**
   * Additionally ask the issuer whether the passport is still active. Off by
   * default — the whole point of this design is that verification needs no
   * callback — but a long-lived decision may want live revocation state.
   */
  requireOnline?: boolean;
  now?: () => number;
}

/**
 * Verify an agent-to-agent token.
 *
 * ── Replay is YOUR problem, deliberately ────────────────────────────────────
 *
 * There is no server-side jti denylist, because there is no server in this
 * path: verification is offline by design. A token is a bearer credential for
 * its (short) lifetime, so if replay matters to you, dedupe on `claims.jti` —
 * which is why it is returned. The short TTL bounds the window; it does not
 * close it.
 */
export async function verifyAgentToken(
  token: string,
  options: VerifyAgentTokenOptions
): Promise<VerifyResult<AgentTokenClaims>> {
  if (!options.audience) return { ok: false, reason: "wrong_audience" };

  const result = await verifySigned<AgentTokenClaims>(token, AGENT_TOKEN_TYP, options);
  if (!result.ok) return result;

  const claims = result.claims;

  // Exact match. A token minted for `aud: "billing"` must not satisfy a
  // verifier that is `payments`, however similar the names look.
  if (claims.aud !== options.audience) return { ok: false, reason: "wrong_audience" };

  const now = Math.floor((options.now?.() ?? Date.now()) / 1000);
  if (typeof claims.exp !== "number" || claims.exp <= now) return { ok: false, reason: "expired" };

  if (options.requireOnline) {
    const live = await passportStatus(claims.iss, claims.sub, options);
    // An unreachable issuer is NOT a revocation. Report it distinctly so the
    // caller decides whether their situation tolerates an unknown, rather than
    // having an outage silently read as "this agent was revoked".
    if (live === null) return { ok: false, reason: "status_unavailable" };
    if (live !== "active") return { ok: false, reason: "revoked" };
  }

  return { ok: true, claims };
}

async function passportStatus(
  issuer: string,
  passportId: string,
  options: VerifyOptions
): Promise<string | null> {
  const fetchImpl = options.fetch ?? fetch;
  try {
    const url = new URL(`/api/verify/${encodeURIComponent(passportId)}`, issuer).toString();
    const res = await fetchImpl(url);
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { status?: string } };
    return typeof body?.data?.status === "string" ? body.data.status : null;
  } catch {
    return null;
  }
}
