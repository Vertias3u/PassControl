/**
 * Session seals: one signed commitment over every receipt in one working session
 * (sprint Bet B, D4). Verified by `verifySession` in sdk/verify.ts and
 * cli/verify.mjs.
 *
 * WHAT A SESSION IS. The calls one agent made under one DECLARED session id
 * (`agent_logs.client_session`, lib/client-lineage.ts): a Claude Code or Codex
 * session, or a sidecar run. The id is declared by the client, never
 * authenticated, so a seal shows how the ISSUER grouped what the client declared.
 *
 * TOTALS COME FROM THE SIGNED RECEIPTS, not from the log columns. A verifier
 * holding the bundle recomputes them from the same receipts, so the issuer's
 * figure and the verifier's cannot drift. Two numbers only the log can supply are
 * carried as the issuer's statement, exactly as on a spend statement: `nr` (rows,
 * including any whose receipt failed to sign) and `unk` (covered calls whose cost
 * was never recorded). Neither is recomputable from a bundle, and verifySession
 * does not pretend to.
 *
 * Leaf rule, tree shape and `n`/`nr`/`unp`/`unk` are the statement's
 * (lib/statement.ts, lib/merkle.ts), unchanged.
 */
import { base64urlToBytes, bytesToBase64url } from "@/lib/encoding";
import { loadInstanceSigner } from "@/lib/crypto/instanceKey";
import { signCompactJws } from "@/lib/crypto/jws";
import { merkleLeaf, merkleRoot } from "@/lib/merkle";

export const SESSION_FORMAT = "passcontrol.session";
export const SESSION_VERSION = 1;
/** One key signs receipts, statements and seals: `typ` is what keeps them apart. */
export const SESSION_TYP = "passcontrol-session+jws";

/** A session's log row, in seal order (created_at, id). */
export interface SessionRow {
  receipt: string | null;
  cost_microcents: number | null;
  unpriced: boolean | null;
}

export interface SessionTreeNode {
  agt: string | null;
  par: string | null;
  n: number;
  cost: number;
  refused: number;
}

export interface SessionClaims {
  iss: string;
  sub: string;
  jti: string;
  iat: number;
  fmt: typeof SESSION_FORMAT;
  v: typeof SESSION_VERSION;
  ses: { id: string; src: string };
  /** Half-open `[from, to)`, epoch seconds, over the receipts' own start times. */
  per: { from: number; to: number };
  n: number;
  nr: number;
  cost: number;
  unp: number;
  unk: number;
  root: string | null;
  tree: SessionTreeNode[];
  mdl: { mdl: string | null; n: number; cost: number }[];
}

export interface SessionInput {
  issuer: string;
  sealId: string;
  agentId: string;
  sessionId: string;
  /** Who declared the session: claude-code, codex or sidecar. */
  src: string;
  rows: SessionRow[];
  generatedAt?: number;
}

type ReceiptClaims = {
  cost?: unknown;
  unp?: unknown;
  mdl?: unknown;
  t0?: unknown;
  res?: { status?: unknown };
  ctx?: { agt?: unknown; par?: unknown };
};

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Our own receipt's claims. We signed it, so decoding without verifying is sound here. */
function claimsOf(jws: string): ReceiptClaims {
  return JSON.parse(new TextDecoder().decode(base64urlToBytes(jws.split(".")[1] ?? ""))) as ReceiptClaims;
}

export function buildSessionClaims(input: SessionInput): { claims: SessionClaims; bundle: string[] } {
  const generatedAt = input.generatedAt ?? Date.now();
  const bundle = input.rows.flatMap((r) => (r.receipt ? [r.receipt] : []));
  const root = merkleRoot(bundle.map(merkleLeaf));

  const tree = new Map<string, SessionTreeNode>();
  const models = new Map<string, { mdl: string | null; n: number; cost: number }>();
  let cost = 0;
  let unp = 0;
  let first = Infinity;
  let last = -Infinity;
  for (const jws of bundle) {
    const c = claimsOf(jws);
    const agt = str(c.ctx?.agt);
    const par = str(c.ctx?.par);
    const node = tree.get(JSON.stringify([agt, par])) ?? { agt, par, n: 0, cost: 0, refused: 0 };
    node.n += 1;
    node.cost += num(c.cost);
    if (typeof c.res?.status === "string" && c.res.status.startsWith("blocked_")) node.refused += 1;
    tree.set(JSON.stringify([agt, par]), node);
    const mdl = str(c.mdl);
    const m = models.get(JSON.stringify(mdl)) ?? { mdl, n: 0, cost: 0 };
    m.n += 1;
    m.cost += num(c.cost);
    models.set(JSON.stringify(mdl), m);
    cost += num(c.cost);
    if (c.unp === true) unp += 1;
    const t = Math.floor(num(c.t0) / 1000);
    first = Math.min(first, t);
    last = Math.max(last, t);
  }
  const at = Math.floor(generatedAt / 1000);

  return {
    bundle,
    claims: {
      iss: input.issuer,
      sub: input.agentId,
      jti: input.sealId,
      iat: at,
      fmt: SESSION_FORMAT,
      v: SESSION_VERSION,
      ses: { id: input.sessionId, src: input.src },
      per: bundle.length ? { from: first, to: last + 1 } : { from: at, to: at },
      n: bundle.length,
      nr: input.rows.length,
      cost,
      unp,
      // Covered (it has a receipt) but no cost recorded and not known-unpriceable.
      unk: input.rows.filter((r) => r.receipt && r.cost_microcents == null && !r.unpriced).length,
      root: root ? bytesToBase64url(root) : null,
      tree: [...tree.values()],
      mdl: [...models.values()],
    },
  };
}

/** Sign a seal, or null when this instance has no signing key. Never throws. */
export function signSessionSeal(claims: SessionClaims): string | null {
  try {
    const signer = loadInstanceSigner();
    if (!signer) return null;
    return signCompactJws({
      typ: SESSION_TYP,
      kid: signer.kid,
      seed: signer.seed,
      claims: claims as unknown as Record<string, unknown>,
    });
  } catch {
    return null;
  }
}
