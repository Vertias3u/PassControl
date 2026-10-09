// Offline verification of what a PassControl deployment signs.
//
// The plain-ESM twin of sdk/verify.ts, for `passcontrol verify`. Duplicated
// rather than imported because the shipped CLI is transpilation-free; the tests
// pin the two implementations to agree on the cases that matter.
//
// Nothing here needs a PassControl account, an API key, or a passport. You need
// the artifact and the issuer's origin. That is the whole point.
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { RECEIPT_PROTOCOL, SESSION_PROTOCOL, STATEMENT_PROTOCOL } from "./protocols.mjs";

export const RECEIPT_TYP = "passcontrol-receipt+jwt";
export const AGENT_TOKEN_TYP = "passcontrol-agent+jwt";
export const STATEMENT_TYP = "passcontrol-statement+jws";
export const SESSION_TYP = "passcontrol-session+jws";
// Its own version line, separate from the receipt's — see protocols.mjs.
export const STATEMENT_SUPPORTED_VER = STATEMENT_PROTOCOL.maximum;
// Session seals: their own line too.
export const SESSION_SUPPORTED_VER = SESSION_PROTOCOL.maximum;
// Receipts v2 add Direct Agent identity claims. This is a maximum, not an
// equality check: v1 receipts remain independently verifiable forever.
export const SUPPORTED_VER = RECEIPT_PROTOCOL.maximum;

const fromB64url = (value) =>
  new Uint8Array(Buffer.from(String(value).replace(/-/g, "+").replace(/_/g, "/"), "base64"));

const decodeJson = (segment) => JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));

/**
 * Exact match after stripping a trailing slash. Prefix or suffix matching is
 * the classic issuer-confusion bug — `https://good.com.evil.com` and
 * `https://evil.com/?x=https://good.com` must both fail.
 */
export function matchesIssuer(iss, trusted) {
  const strip = (v) => String(v).replace(/\/+$/, "");
  return trusted.some((candidate) => strip(candidate) === strip(iss));
}

async function loadJwks(issuer, fetchImpl, cache) {
  if (cache?.has(issuer)) return cache.get(issuer);
  try {
    const res = await fetchImpl(new URL("/.well-known/jwks.json", issuer).toString());
    if (!res.ok) return null;
    const body = await res.json();
    const keys = Array.isArray(body?.keys) ? body.keys : [];
    cache?.set(issuer, keys);
    return keys;
  } catch {
    return null;
  }
}

/**
 * `version` names which claim carries the artifact's version and the newest
 * value understood. Receipts version with `ver`; statements have their own line
 * and use `v`. Without this a statement would flow through the receipt gate,
 * find no `ver`, read as 0 and be accepted whatever it claimed — so a future
 * statement v2 would pass this v1 verifier silently. The default reproduces the
 * receipt behaviour exactly, so the verifyReceipt call site is unchanged.
 *
 * Kept deliberately identical in shape to sdk/verify.ts. These two are twins and
 * the tests below pin them to agree.
 */
async function verifySigned(
  token,
  typ,
  { issuer, fetch: fetchImpl = fetch, jwksCache },
  version = { claim: "ver", max: SUPPORTED_VER }
) {
  const parts = String(token).split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    return { ok: false, reason: "malformed" };
  }

  let header;
  let claims;
  try {
    header = decodeJson(parts[0]);
    claims = decodeJson(parts[1]);
  } catch {
    return { ok: false, reason: "malformed" };
  }

  // EdDSA is pinned, never read from the token. A verifier that dispatches on
  // the token's own `alg` accepts alg:"none" and accepts an HS256 MAC keyed on
  // the public key it just fetched — which is public, so anyone can compute it.
  if (header?.alg !== "EdDSA") return { ok: false, reason: "bad_signature" };
  if (header?.typ !== typ) return { ok: false, reason: "wrong_type" };
  if (!claims?.iss || !matchesIssuer(claims.iss, [issuer])) {
    return { ok: false, reason: "untrusted_issuer" };
  }
  if (Number(claims?.[version.claim] ?? 0) > version.max) {
    return { ok: false, reason: "unsupported_version" };
  }

  const keys = await loadJwks(claims.iss, fetchImpl, jwksCache);
  if (!keys) return { ok: false, reason: "jwks_unreachable" };

  const candidates = keys.filter(
    (key) =>
      key?.kty === "OKP" &&
      key?.crv === "Ed25519" &&
      typeof key.x === "string" &&
      (!header.kid || !key.kid || key.kid === header.kid)
  );
  if (candidates.length === 0) return { ok: false, reason: "unknown_key" };

  const signature = fromB64url(parts[2]);
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  for (const key of candidates) {
    try {
      if (ed25519.verify(signature, signed, fromB64url(key.x))) return { ok: true, claims };
    } catch {
      // A malformed JWK entry must not abort verification against the others.
    }
  }
  return { ok: false, reason: "bad_signature" };
}

export function verifyReceipt(jws, options) {
  return verifySigned(jws, RECEIPT_TYP, options);
}

/**
 * Verify a signed spend statement.
 *
 * A valid statement proves the issuer committed to a fixed set of receipts for
 * that window at signing time, and that it follows a specific earlier statement.
 * It is NOT an independent audit of the totals: recomputing `root` needs every
 * receipt in the window, which the holder of a statement does not have.
 */
export function verifyStatement(jws, options) {
  return verifySigned(jws, STATEMENT_TYP, options, {
    claim: "v",
    max: STATEMENT_SUPPORTED_VER,
  });
}

/**
 * Fold a receipt and an inclusion path back to a root.
 *
 * `false` means "not in THIS root" — not "not attested". Pairing a receipt with
 * the wrong day's statement returns a truthful `false` that reads like an
 * accusation, and nothing here can tell the difference.
 */
export function verifyInclusion(receiptJws, proof, root) {
  const bytes = (v) => (typeof v === "string" ? fromB64url(v) : v);
  // Same domain separation as lib/merkle.ts: 0x00 for a leaf, 0x01 for a node,
  // so a leaf can never be passed off as an internal node.
  const hash = (prefix, ...parts) => {
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
    let node = hash(0x00, new TextEncoder().encode(String(receiptJws)));
    for (const step of proof ?? []) {
      const sibling = bytes(step.hash);
      node = step.right ? hash(0x01, node, sibling) : hash(0x01, sibling, node);
    }
    const target = bytes(root);
    if (node.length !== target.length) return false;
    for (let i = 0; i < node.length; i++) if (node[i] !== target[i]) return false;
    return true;
  } catch {
    return false;
  }
}

export async function verifyAgentToken(token, options) {
  const { audience, now = () => Date.now() } = options;
  if (!audience) return { ok: false, reason: "wrong_audience" };

  const result = await verifySigned(token, AGENT_TOKEN_TYP, options);
  if (!result.ok) return result;

  if (result.claims.aud !== audience) return { ok: false, reason: "wrong_audience" };
  const seconds = Math.floor(now() / 1000);
  if (typeof result.claims.exp !== "number" || result.claims.exp <= seconds) {
    return { ok: false, reason: "expired" };
  }
  return result;
}

// ── Session seals ────────────────────────────────────────────────────────────

/** Leaf and node hashing, the same domain separation as verifyInclusion above. */
function sessionHash(prefix, ...parts) {
  const total = parts.reduce((sum, p) => sum + p.length, 1);
  const buf = new Uint8Array(total);
  buf[0] = prefix;
  let at = 1;
  for (const p of parts) {
    buf.set(p, at);
    at += p.length;
  }
  return sha256(buf);
}

/** lib/merkle.ts's root: leaves in bundle order, an odd node promoted unchanged. */
function sessionRoot(bundle) {
  if (bundle.length === 0) return null;
  let level = bundle.map((jws) => sessionHash(0x00, new TextEncoder().encode(jws)));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(level[i + 1] ? sessionHash(0x01, level[i], level[i + 1]) : level[i]);
    }
    level = next;
  }
  return Buffer.from(level[0]).toString("base64url");
}

function decodePayload(jws) {
  try {
    const claims = decodeJson(String(jws).split(".")[1] ?? "");
    return claims && typeof claims === "object" && !Array.isArray(claims) ? claims : null;
  } catch {
    return null;
  }
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const orNull = (v) => (typeof v === "string" ? v : null);

/** Tree and model lists, compared as sets: one canonical string each. */
function canonical(entries, keys) {
  if (!Array.isArray(entries)) return null;
  return JSON.stringify(
    entries
      .map((e) => keys.map((k) => (k.text ? orNull(e?.[k.name]) : num(e?.[k.name]))))
      .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0))
  );
}
const TREE_KEYS = [{ name: "agt", text: true }, { name: "par", text: true }, { name: "n" }, { name: "cost" }, { name: "refused" }];
const MODEL_KEYS = [{ name: "mdl", text: true }, { name: "n" }, { name: "cost" }];

/** What the bundle itself adds up to, from the receipts' own claims. */
function bundleTotals(decoded) {
  const tree = new Map();
  const models = new Map();
  let cost = 0;
  let unp = 0;
  for (const c of decoded) {
    if (!c) continue;
    const ctx = c.ctx && typeof c.ctx === "object" ? c.ctx : {};
    const agt = orNull(ctx.agt);
    const par = orNull(ctx.par);
    const refused = typeof c.res?.status === "string" && c.res.status.startsWith("blocked_") ? 1 : 0;
    const key = JSON.stringify([agt, par]);
    const node = tree.get(key) ?? { agt, par, n: 0, cost: 0, refused: 0 };
    node.n += 1;
    node.cost += num(c.cost);
    node.refused += refused;
    tree.set(key, node);
    const mdl = orNull(c.mdl);
    const m = models.get(JSON.stringify(mdl)) ?? { mdl, n: 0, cost: 0 };
    m.n += 1;
    m.cost += num(c.cost);
    models.set(JSON.stringify(mdl), m);
    cost += num(c.cost);
    if (c.unp === true) unp += 1;
  }
  return { cost, unp, tree: [...tree.values()], mdl: [...models.values()] };
}

/**
 * A journal entry is a receipt id, or `{ id, ... }` as the sidecar writes it. This
 * session's ids (and lines naming no session), and how many named another (`ses`):
 * one sidecar run serves many sessions.
 */
function journalIds(journal, session) {
  if (!Array.isArray(journal)) return null;
  const ids = [];
  let other = 0;
  for (const entry of journal) {
    const id = typeof entry === "string" ? entry : entry && typeof entry === "object" ? entry.id : undefined;
    if (typeof id !== "string" || id.length === 0) return null;
    const ses = entry && typeof entry === "object" ? entry.ses : undefined;
    if (typeof ses === "string" && ses !== session) {
      other += 1;
      continue;
    }
    ids.push(id);
  }
  return { ids, other };
}

/**
 * Verify a session seal against its bundle and, when given, the user's journal.
 *
 * Four checks: (1) the seal's signature; (2) its root and totals recompute from
 * the bundle; (3) every receipt in the bundle verifies and belongs to this
 * session, agent and window; (4) every receipt id the user's sidecar journaled is
 * in the bundle, directly or through a receipt's `prev` link.
 *
 * Without a journal a seal is no stronger than a statement: `checks.journal` is
 * null and says so. A journaled id that is absent is MISSING, not tampering: the
 * gateway's log write is best-effort, so a lost row and an omission look alike.
 * Receipts in the bundle but not the journal are reported in `unjournaled` and
 * never fail the session.
 */
export async function verifySession(input, options) {
  const jwksCache = new Map();
  const opts = { ...options, jwksCache };
  const result = {
    ok: false,
    checks: { signature: false, bundle: null, receipts: null, journal: null },
    mismatched: [],
    rejected: [],
    missing: [],
    unjournaled: [],
    otherSessions: 0,
  };

  const sealed = await verifySigned(input?.seal, SESSION_TYP, opts, { claim: "v", max: SESSION_SUPPORTED_VER });
  if (!sealed.ok) return { ...result, reason: sealed.reason };
  const claims = sealed.claims;
  result.claims = claims;
  result.checks.signature = true;

  const bundle = Array.isArray(input?.bundle) && input.bundle.every((j) => typeof j === "string") ? input.bundle : null;
  if (!bundle) {
    return { ...result, reason: "malformed_bundle", checks: { ...result.checks, bundle: false } };
  }

  // 2. The root and every total, recomputed from the bundle.
  const decoded = bundle.map(decodePayload);
  const totals = bundleTotals(decoded);
  if (sessionRoot(bundle) !== (claims.root ?? null)) result.mismatched.push("root");
  if (claims.n !== bundle.length) result.mismatched.push("n");
  if (claims.cost !== totals.cost) result.mismatched.push("cost");
  if (claims.unp !== totals.unp) result.mismatched.push("unp");
  if (canonical(claims.tree, TREE_KEYS) !== canonical(totals.tree, TREE_KEYS)) result.mismatched.push("tree");
  if (canonical(claims.mdl, MODEL_KEYS) !== canonical(totals.mdl, MODEL_KEYS)) result.mismatched.push("mdl");
  result.checks.bundle = result.mismatched.length === 0;

  // 3. Every receipt verifies, and belongs to this session, agent and window.
  const seen = new Set();
  for (let index = 0; index < bundle.length; index++) {
    const id = orNull(decoded[index]?.jti);
    const verified = await verifyReceipt(bundle[index], opts);
    let reason = verified.ok ? null : verified.reason;
    if (verified.ok) {
      const c = verified.claims;
      const t = Math.floor(num(c.t0) / 1000);
      if (seen.has(c.jti)) reason = "duplicate";
      else if (c.ctx?.ses !== claims.ses?.id) reason = "other_session";
      else if (c.agid !== claims.sub) reason = "other_agent";
      else if (!(t >= num(claims.per?.from) && t < num(claims.per?.to))) reason = "outside_period";
      seen.add(c.jti);
    }
    if (reason) result.rejected.push({ index, id, reason });
  }
  result.checks.receipts = result.rejected.length === 0;

  // 4. The user's own record.
  if (input.journal !== undefined) {
    const journaled = journalIds(input.journal, claims.ses?.id);
    if (!journaled) {
      result.reason = "malformed_journal";
      result.checks.journal = false;
    } else {
      const inBundle = new Set(decoded.map((c) => orNull(c?.jti)).filter(Boolean));
      const predecessors = new Set(decoded.map((c) => orNull(c?.prev)).filter(Boolean));
      result.otherSessions = journaled.other;
      const ids = new Set(journaled.ids);
      result.missing = [...ids].filter((id) => !inBundle.has(id) && !predecessors.has(id));
      for (const id of inBundle) {
        if (!ids.has(id)) {
          result.unjournaled.push({ id, why: predecessors.has(id) ? "failover_predecessor" : "not_in_journal" });
        }
      }
      result.checks.journal = result.missing.length === 0;
    }
  }

  const { signature, bundle: b, receipts, journal } = result.checks;
  result.ok = signature && b === true && receipts === true && journal !== false;
  return result;
}

/** Human-readable one-liners. Kept here so the CLI and its tests agree on wording. */
export const FAILURE_REASONS = {
  malformed: "not a compact JWS",
  bad_signature: "signature does not verify against the issuer's published key",
  wrong_type: "this artifact is a different type than the one you asked to verify",
  untrusted_issuer: "the issuer in the artifact is not the one you named",
  unknown_key: "the issuer does not publish the key this was signed with",
  jwks_unreachable: "could not fetch the issuer's key set",
  unsupported_version: "signed by a newer PassControl than this CLI understands",
  wrong_audience: "minted for a different audience",
  expired: "expired",
  malformed_bundle: "the bundle is not a list of receipts",
  malformed_journal: "the journal could not be read as a list of receipt ids",
  other_session: "this receipt is not from the sealed session",
  other_agent: "this receipt is from a different agent than the seal names",
  outside_period: "this receipt falls outside the seal's time window",
  duplicate: "the same receipt appears twice in the bundle",
};
