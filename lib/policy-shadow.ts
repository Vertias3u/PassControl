// What a shadow policy WOULD have done to traffic that already happened.
//
// Pure, for the same reason lib/audit-history.ts and lib/scope-rows.ts are: the
// judgements are the part worth testing, and a test should not need a React tree
// to reach them.
//
// ── Three things this module refuses to overstate ───────────────────────────
//
// 1. IT COUNTS ATTEMPTS, NOT CALLS. The proxy writes one agent_logs row per
//    attempt, and a call that fails over to a second provider writes two. Each
//    carries the verdict for the provider and model IT went to — the draft is
//    re-evaluated per attempt, exactly as the live policy is, because a draft
//    that denies one provider by name says nothing about the other. So a single
//    failed-over call contributes 2 here, and the two can disagree. Every label
//    this module produces says "attempts" for that reason. Calling them calls
//    would be a quiet 2× on exactly the traffic that already went wrong.
//
// 2. IT IS A FLOOR, NOT A CENSUS. writeLog is best-effort by design — after two
//    failed inserts it gives up with a captureError. A database blip loses the
//    audit row and the shadow verdict with it. That is the right trade for
//    diagnostics, but it means these numbers can only ever be "at least this
//    many", and `partial` exists so the UI can say so.
//
// 3. A MALFORMED DRAFT IS NOT A STRICT DRAFT. parsePolicy rejects the whole
//    document on any violation, so a typo produces `deny:policy` on every single
//    attempt — indistinguishable, by the numbers alone, from a draft that is
//    working perfectly and blocking everything. The number is true and the
//    conclusion it invites is wrong, so `wellFormed` is carried here and the UI
//    leads with it instead of the count.
//
// 4. IT ATTRIBUTES BY REVISION, NOT BY CLOCK. A timestamp cutoff is not proof of
//    which draft produced a verdict: a streaming request that read draft A can
//    stay open across a save and insert A's verdict after draft B's cutoff, and
//    a policy-cache miss that began before the purge can hand A's document to a
//    call that finishes later still. Both land inside B's window. So each
//    verdict carries a revision of the document that produced it and only
//    matching stamps are counted. See `shadowRevision`.
import { policyIsWellFormed } from "./scope";

/** The verdicts the proxy records. Anything else is ignored rather than guessed at. */
const SHADOW_ALLOW = "allow";
const SHADOW_DENY = "deny:policy";

/**
 * Separates the verdict from the revision of the draft that produced it inside
 * the single `agent_logs.policy_shadow_would` text column.
 *
 * One column, not two, and that is a constraint rather than a preference: the
 * demo database runs behind the code, and PostgREST rejects the WHOLE query on a
 * column that does not exist yet (see lib/state/policy.ts). Adding a column for
 * a diagnostic would put the live policy read at risk of the same failure. `@`
 * appears in neither verdict, so the split is unambiguous.
 */
const REVISION_MARK = "@";

/** The live status that means the LIVE policy is what stopped the attempt. */
const LIVE_BLOCKED_BY_POLICY = "blocked_policy";

export interface ShadowDivergence {
  /** Attempts carrying a shadow verdict at all. The denominator. */
  considered: number;
  /** The live policy let it past; the draft would have stopped it. */
  wouldBlock: number;
  /** The live policy stopped it; the draft would have let it through. */
  wouldAllow: number;
  /** Both reached the same conclusion. */
  agreed: number;
  /**
   * True when at least one row in the sample carried NO shadow verdict — either
   * shadow mode was off when it was recorded, or an earlier gate (kill switch,
   * scope, budget) decided before policy was ever reached. Distinguishes "the
   * draft agreed with everything" from "the draft saw almost nothing".
   */
  partial: boolean;
}

export interface ShadowState {
  /** The draft itself, or null when shadow mode is off. */
  draft: unknown;
  /** Whether the gateway can read the draft. False means it denies everything. */
  wellFormed: boolean;
  divergence: ShadowDivergence;
  /**
   * When the draft currently in the column was saved, or null when that cannot
   * be established. Supplementary since verdicts carry a revision: it dates the
   * measurement for the operator, it no longer decides which rows belong to it.
   */
  since: string | null;
  /**
   * Which draft this is. Two jobs: it selects the verdicts that are evidence for
   * THIS document, and the panel hands it back to `promoteAgentPolicyShadow` so
   * what ships is what was reviewed. Null when shadow mode is off.
   */
  revision: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * A stable string for a policy document, with object keys in a fixed order.
 *
 * Key order MUST NOT change the answer. `agents.policy_shadow` is jsonb, which
 * does not preserve the order a document was written in, so a revision that
 * varied with it would report a conflict on a draft nobody had edited.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    // undefined and functions stringify to undefined; name them so two
    // different unstorable values cannot collapse to the same revision.
    return JSON.stringify(value) ?? `<${typeof value}>`;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

/** FNV-1a over UTF-16 code units, one 32-bit word per offset basis. */
function fnv1a(input: string, basis: number): number {
  let hash = basis >>> 0;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    hash = Math.imul(hash ^ (code & 0xff), 0x01000193) >>> 0;
    hash = Math.imul(hash ^ (code >>> 8), 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Which draft this is — 64 bits of hash over its canonical form.
 *
 * Derived, never stored. That is the whole point: no column to add, no value to
 * keep in step, and a policy-cache entry written before a purge carries its own
 * draft's revision by construction, so a verdict computed from a stale cache is
 * excluded from the new draft's counts without anything having to notice the
 * staleness.
 *
 * NOT a cryptographic digest, and not load-bearing against one. It answers "is
 * this the same document the operator was looking at", where both documents are
 * the tenant's own; a tenant who found a collision would only mislead
 * themselves. It is sync and dependency-free because it runs on the credential
 * path, where `crypto.subtle.digest` would mean an await inside the shadow
 * evaluation.
 *
 * Returns null for "no draft" — and for anything it cannot canonicalise at all,
 * because a throw here would be a 500 on a proxied call. A null revision degrades
 * to an unstamped verdict, which `summariseShadowDivergence` already excludes.
 */
export function shadowRevision(draft: unknown): string | null {
  try {
    if (draft === null || draft === undefined) return null;
    const form = canonical(draft);
    const hex = (n: number) => n.toString(16).padStart(8, "0");
    return hex(fnv1a(form, 0x811c9dc5)) + hex(fnv1a(form, 0x9e3779b1));
  } catch {
    // A cyclic document overflows the stack rather than throwing a TypeError;
    // either way the caller gets "unattributable", not an exception.
    return null;
  }
}

/** Bind a verdict to the draft that produced it, for the one text column. */
export function stampShadowVerdict(verdict: string, revision: string | null): string {
  return revision ? `${verdict}${REVISION_MARK}${revision}` : verdict;
}

/**
 * Split a recorded value back into verdict and revision.
 *
 * A value with no mark is a verdict from before revisions existed. It is
 * returned with a null revision, which is not the same as matching every
 * revision — the caller excludes it.
 */
export function parseShadowVerdict(raw: unknown): { verdict: string; revision: string | null } {
  const value = text(raw);
  const at = value.indexOf(REVISION_MARK);
  if (at === -1) return { verdict: value, revision: null };
  return { verdict: value.slice(0, at), revision: value.slice(at + 1) || null };
}

/**
 * Fold a sample of agent_logs rows into the counts.
 *
 * Rows are taken as they come out of PostgREST — unknown shapes are skipped
 * rather than throwing, because this feeds a supplementary panel and a single
 * odd row must not take the passport page down with it.
 */
export function summariseShadowDivergence(
  rows: unknown,
  since?: string | null,
  revision?: string | null
): ShadowDivergence {
  const empty: ShadowDivergence = {
    considered: 0,
    wouldBlock: 0,
    wouldAllow: 0,
    agreed: 0,
    partial: false,
  };
  if (!Array.isArray(rows)) return empty;

  // The cutoff is kept, but it is no longer what proves authorship — the
  // revision below is. It survives as a narrowing floor: strictly conservative,
  // and it costs nothing to leave a second reason to exclude a row in place.
  // Rows that cannot be dated are dropped rather than assumed recent, because
  // this panel names a specific draft and over-reporting is the failure it
  // exists to prevent.
  const cutoff = since && Number.isFinite(Date.parse(since)) ? Date.parse(since) : null;
  const wanted = revision || null;
  const withinDraft = (value: unknown): boolean => {
    if (cutoff === null) return true;
    const at = typeof value === "string" ? Date.parse(value) : NaN;
    return Number.isFinite(at) && at >= cutoff;
  };

  let considered = 0;
  let wouldBlock = 0;
  let wouldAllow = 0;
  let agreed = 0;
  let partial = false;

  for (const row of rows) {
    if (!isRecord(row)) {
      partial = true;
      continue;
    }
    if (!withinDraft(row.created_at)) {
      // Measured against an earlier draft. Not this draft's evidence, but its
      // existence means the sample shown is narrower than the traffic recorded.
      partial = true;
      continue;
    }
    const { verdict: would, revision: stamped } = parseShadowVerdict(row.policy_shadow_would);
    if (would !== SHADOW_ALLOW && would !== SHADOW_DENY) {
      // Includes null, which is the common case: shadow mode was off, or an
      // earlier gate decided and the policy step was never reached. It also
      // includes the case the gateway records when a draft sets an hourly cap
      // the live policy never counted — there is no reading for that cap, so
      // there is no verdict rather than a guessed one.
      partial = true;
      continue;
    }
    // Which draft this verdict is evidence FOR. An unstamped row predates
    // revisions and cannot be attributed to anything, so it is excluded rather
    // than credited to whichever draft happens to be current now — that is the
    // exact over-report a timestamp cutoff cannot prevent.
    if (wanted !== null && stamped !== wanted) {
      partial = true;
      continue;
    }

    considered += 1;
    // The live policy is what stopped the attempt if and only if the status says
    // so. Every other status — ok, blocked_budget, upstream_error — means the
    // attempt got PAST the live policy step, whatever happened to it afterwards.
    const liveBlockedByPolicy = text(row.status) === LIVE_BLOCKED_BY_POLICY;

    if (would === SHADOW_DENY && !liveBlockedByPolicy) wouldBlock += 1;
    else if (would === SHADOW_ALLOW && liveBlockedByPolicy) wouldAllow += 1;
    else agreed += 1;
  }

  return { considered, wouldBlock, wouldAllow, agreed, partial };
}

/**
 * The whole shadow picture for one agent, ready to render.
 *
 * The revision is DERIVED from the draft this function is already handed, so no
 * caller has to fetch or thread one. That is what keeps the binding honest:
 * there is no second copy of it anywhere to fall out of step with the document
 * it names. Editing a strict draft into a permissive one changes the revision,
 * and the permissive one therefore cannot wear the strict one's numbers.
 *
 * `since` still narrows the sample, but it is no longer the proof of authorship.
 */
export function toShadowState(
  draft: unknown,
  rows: unknown,
  since: string | null = null
): ShadowState {
  const normalised = draft === undefined ? null : draft;
  const dated = since && Number.isFinite(Date.parse(since)) ? since : null;
  const revision = shadowRevision(normalised);
  return {
    draft: normalised,
    // `null` is well-formed and means off, so this is only interesting once a
    // draft exists. Checked against the gateway's own reader, never re-described.
    wellFormed: policyIsWellFormed(normalised),
    divergence: summariseShadowDivergence(rows, dated, revision),
    since: dated,
    revision,
  };
}
