// What the web session-seal checker shows (sprint T9, owner D10). The page runs
// sdk/verify.ts's verifySession in the visitor's browser, against keys fetched
// from the issuer the seal names; this module turns its answer into the four
// checks, each pass / fail / not run, and the agent tree, worded as
// `passcontrol verify session` words them (bin/passcontrol.mjs). Pure, so the
// evidence a visitor reads is as testable as the verifier's own answer.
import type { SessionClaims, SessionVerifyResult } from "@/sdk/verify";
import { describeLineage } from "@/lib/verify/receipt-view";

export type SessionCheckName = "signature" | "bundle" | "receipts" | "journal";
export type SessionCheckState = "pass" | "fail" | "not-run";

export interface SessionCheckRow {
  name: SessionCheckName;
  state: SessionCheckState;
  title: string;
  detail: string[];
}

export interface SessionTreeRow {
  who: string;
  depth: number;
  calls: number;
  cost: number;
  refused: number;
}

export interface SessionCheckView {
  /** valid: every check run passed; failed: the seal is genuine but a check failed; invalid: the seal itself is not. */
  verdict: "valid" | "failed" | "invalid";
  headline: string;
  rows: SessionCheckRow[];
  session: { id: string; note: string } | null;
  claims: SessionClaims | null;
  tree: SessionTreeRow[];
}

// The CLI's wording (cli/verify.mjs FAILURE_REASONS), for the same failures.
const REASONS: Record<string, string> = {
  malformed: "not a signed seal",
  bad_signature: "the signature does not verify against the issuer's published key",
  wrong_type: "this is a different kind of artifact, not a session seal",
  untrusted_issuer: "the issuer in the seal is not the one it was checked against",
  unknown_key: "the issuer does not publish the key this was signed with",
  jwks_unreachable: "the issuer's key set could not be fetched from this browser",
  unsupported_version: "signed by a newer PassControl than this page understands",
  expired: "expired",
  malformed_bundle: "the bundle is not a list of receipts",
  malformed_journal: "the journal could not be read as a list of receipt ids",
  other_session: "not from the sealed session",
  other_agent: "from a different agent than the seal names",
  outside_period: "outside the seal's time window",
  duplicate: "appears twice in the bundle",
};
const reason = (r: string | undefined) => (r ? (REASONS[r] ?? r) : "unknown");
/** Printable ASCII, capped: a signed value is still not the page's to render raw. */
const shown = (v: unknown) => String(v ?? "").replace(/[^\x20-\x7e]/g, "?").slice(0, 128);

/** Nest the seal's flat tree: main agent first, each sub-agent under the agent that spawned it. */
function treeRows(nodes: SessionClaims["tree"] | undefined): SessionTreeRow[] {
  const list = Array.isArray(nodes) ? nodes : [];
  const agents = new Set(list.map((n) => n.agt).filter((a): a is string => typeof a === "string"));
  const out: SessionTreeRow[] = [];
  const row = (node: (typeof list)[number], depth: number, who: string): SessionTreeRow => ({
    who,
    depth,
    calls: Number(node.n) || 0,
    cost: Number(node.cost) || 0,
    refused: Number(node.refused) || 0,
  });
  const done = new Set<unknown>();
  const visit = (node: (typeof list)[number], depth: number, who: string) => {
    if (done.has(node) || depth > 32) return;
    done.add(node);
    out.push(row(node, depth, who));
    if (node.agt) for (const child of list) if (child.par === node.agt) visit(child, depth + 1, `sub-agent ${shown(child.agt)}`);
  };
  // The main agent, then every sub-agent with no parent (first level), each followed by its own.
  for (const node of list) if (node.agt === null) visit(node, 0, "main agent");
  for (const node of list) if (node.agt !== null && (node.par === null || node.par === undefined)) visit(node, 0, `sub-agent ${shown(node.agt)}`);
  // A sub-agent whose declared parent made no calls still shows, saying so.
  for (const node of list) {
    if (!done.has(node) && node.par && !agents.has(node.par)) {
      visit(node, 0, `sub-agent ${shown(node.agt)} (declared parent ${shown(node.par)} made no calls)`);
    }
  }
  return out;
}

export function describeSessionCheck(result: SessionVerifyResult, bundleLength: number): SessionCheckView {
  const { checks } = result;
  const claims = result.claims ?? null;
  const rows: SessionCheckRow[] = [];

  rows.push(
    checks.signature
      ? { name: "signature", state: "pass", title: "Signature matches the issuer's published key", detail: [] }
      : { name: "signature", state: "fail", title: "The seal's signature did not verify", detail: [reason(result.reason)] }
  );

  if (!checks.signature || checks.bundle === null) {
    rows.push({ name: "bundle", state: "not-run", title: "Bundle: not checked", detail: [] });
  } else if (checks.bundle) {
    rows.push({ name: "bundle", state: "pass", title: `Bundle: the root and every total recompute from its ${bundleLength} receipt(s)`, detail: [] });
  } else {
    rows.push({
      name: "bundle",
      state: "fail",
      title: "Bundle: the seal does not match the receipts it came with",
      detail: [result.mismatched.length ? `Does not add up: ${result.mismatched.join(", ")}` : reason(result.reason)],
    });
  }

  if (!checks.signature || checks.receipts === null) {
    rows.push({ name: "receipts", state: "not-run", title: "Receipts: not checked", detail: [] });
  } else if (checks.receipts) {
    rows.push({ name: "receipts", state: "pass", title: "Receipts: every one verifies and belongs to this agent, session and window", detail: [] });
  } else {
    rows.push({
      name: "receipts",
      state: "fail",
      title: `Receipts: ${result.rejected.length} not accepted`,
      detail: result.rejected.map((x) => `#${x.index} ${shown(x.id ?? "?")}: ${reason(x.reason)}`),
    });
  }

  if (!checks.signature) {
    rows.push({ name: "journal", state: "not-run", title: "Journal: not checked", detail: [] });
  } else if (checks.journal === null) {
    rows.push({
      name: "journal",
      state: "not-run",
      title: "Journal: none given",
      detail: [
        "Without your own record this proves no more than a statement does: that the issuer committed to these receipts, not that it left none out.",
        "Add the journal file your sidecar printed when it started.",
      ],
    });
  } else if (result.reason === "malformed_journal") {
    rows.push({ name: "journal", state: "fail", title: "Journal: could not be read as a list of receipt ids", detail: [] });
  } else if (checks.journal) {
    rows.push({ name: "journal", state: "pass", title: "Journal: every call your sidecar recorded is in the seal", detail: [] });
  } else {
    rows.push({
      name: "journal",
      state: "fail",
      title: `Journal: ${result.missing.length} call(s) your sidecar recorded are missing from the seal`,
      detail: [
        ...result.missing.map((id) => shown(id)),
        "Missing means not in this seal. The gateway's log write can fail on its own, so a missing call can be a lost record as easily as one left out.",
      ],
    });
  }
  if (checks.signature && result.otherSessions) {
    rows[rows.length - 1]!.detail.push(
      `Your journal also holds ${result.otherSessions} call(s) from other sessions of the same sidecar run; not checked against this seal.`
    );
  }

  const verdict: SessionCheckView["verdict"] = !checks.signature ? "invalid" : result.ok ? "valid" : "failed";
  const lineage = claims ? describeLineage({ ses: claims.ses?.id, cli: claims.ses?.src }) : null;
  return {
    verdict,
    headline:
      verdict === "valid"
        ? "The session seal is valid."
        : verdict === "failed"
          ? "The seal is genuine, but it did not pass every check."
          : "This is not a valid session seal.",
    rows,
    session: lineage ? { id: lineage.session, note: lineage.note } : null,
    claims,
    tree: claims ? treeRows(claims.tree) : [],
  };
}

/** The dashboard's download ({seal, bundle}) or the control API's saved response ({data: {seal, bundle}}). */
export function parseSealDocument(text: string): { ok: true; seal: string; bundle: string[] } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "This is not a seal file. Paste the JSON the Sessions view downloaded." };
  }
  const outer = parsed as { data?: unknown } | null;
  const doc = (outer && typeof outer === "object" && outer.data && typeof outer.data === "object" ? outer.data : parsed) as {
    seal?: unknown;
    bundle?: unknown;
  } | null;
  if (!doc || typeof doc !== "object" || Array.isArray(doc) || typeof doc.seal !== "string" || !Array.isArray(doc.bundle) || !doc.bundle.every((r) => typeof r === "string")) {
    return { ok: false, error: "This file has no seal and receipt bundle. Paste the JSON the Sessions view downloaded." };
  }
  return { ok: true, seal: doc.seal, bundle: doc.bundle as string[] };
}

/** The sidecar's journal: one JSON object per line. An unreadable line is passed through, so the verifier rejects the journal rather than skipping a call. */
export function parseJournalText(text: string): unknown[] | undefined {
  if (!text.trim()) return undefined;
  const entries: unknown[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      entries.push(line);
    }
  }
  return entries;
}

/** The issuer a seal names, read without verifying, to know whose keys to fetch. */
export function peekSealIssuer(seal: string): string | null {
  const payload = seal.split(".")[1];
  if (!payload) return null;
  try {
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(decodeURIComponent(escape(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)))));
    return typeof json?.iss === "string" && json.iss ? json.iss : null;
  } catch {
    return null;
  }
}
