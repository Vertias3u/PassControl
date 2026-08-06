// Turning a verified receipt — or a failed verification — into words a stranger
// can act on.
//
// Pure by design: no React, no DOM, no network. Everything here is a judgement
// about wording, and the judgements are the part worth testing.
//
// The audience is the thing to keep in mind. This is not the Control Tower. The
// reader is a client's finance manager, a supplier's ops person, an auditor —
// someone handed a receipt who has no account here and no reason to get one. So
// the departures board's vocabulary ("CLEARED", "NO VISA") is deliberately NOT
// reused: it is exactly right for an operator watching their own fleet and
// meaningless to someone reading a single receipt from a company they are
// checking up on. The TONE mapping is shared; the words are not.
import type { DepartureTone } from "@/lib/departures";
import { MICROCENTS_PER_CENT } from "@/lib/pricing";
import {
  AGENT_TOKEN_TYP,
  RECEIPT_TYP,
  type ReceiptClaims,
  type VerifyFailure,
  type VerifyStepName,
} from "@/sdk/verify";

/**
 * Why a failure happened, in the only two categories that matter to a reader.
 *
 * `forged` — a statement about the artifact. Something is wrong with it.
 * `unchecked` — a statement about US. We could not complete the check, which is
 *   NOT a claim that the receipt is bad. Conflating the two either slanders a
 *   genuine receipt or launders a forged one, and both are worse than saying
 *   "we don't know".
 */
export type FailureKind = "forged" | "unchecked";

export interface FailurePresentation {
  title: string;
  body: string;
  kind: FailureKind;
}

/** Every reason sdk/verify.ts can return. Kept exhaustive by tests/receipt-view.test.ts. */
export const ALL_FAILURES = [
  "malformed",
  "untrusted_issuer",
  "unknown_key",
  "bad_signature",
  "wrong_type",
  "unsupported_version",
  "jwks_unreachable",
  "expired",
  "wrong_audience",
  "revoked",
  "status_unavailable",
] as const satisfies readonly VerifyFailure[];

const FAILURES: Record<VerifyFailure, FailurePresentation> = {
  bad_signature: {
    kind: "forged",
    title: "This receipt has been altered.",
    body:
      "The signature does not match the contents. Either something in the receipt was changed after it was signed, or it was never signed by the issuer it names. Do not rely on anything it says.",
  },
  unknown_key: {
    kind: "forged",
    title: "The issuer does not publish this signing key.",
    body:
      "The receipt names a key that this issuer does not list as one of theirs. A genuine receipt is always signed by a key its issuer publishes, including old keys kept for exactly this reason.",
  },
  malformed: {
    kind: "forged",
    title: "This is not a receipt.",
    body:
      "The text pasted is not a signed PassControl receipt. Check you copied the whole thing — a receipt is one long line with exactly two dots in it, and no spaces.",
  },
  wrong_type: {
    kind: "forged",
    title: "This is a different kind of artifact.",
    body:
      "It is signed by PassControl, but it is not a call receipt. This page checks receipts. The type is part of what gets signed, so it cannot be changed to make it fit.",
  },
  untrusted_issuer: {
    kind: "forged",
    title: "This receipt names no issuer we could check.",
    body:
      "A receipt has to say who issued it, as a plain https address. This one does not, so there is nowhere to fetch a key from.",
  },
  // Deliberately NOT "forged". We are behind, the receipt is not wrong.
  unsupported_version: {
    kind: "unchecked",
    title: "This receipt is newer than this page.",
    body:
      "It was signed by a newer version of PassControl than this page understands, so it is not checked rather than checked wrongly. Try again later, or verify it with an up-to-date copy of the passcontrol command-line tool.",
  },
  jwks_unreachable: {
    kind: "unchecked",
    title: "The issuer's key list could not be reached.",
    body:
      "We could not fetch the public keys from the address this receipt names, so the signature has not been checked either way. This says nothing about the receipt itself — the issuer's site may simply be down, or may not be a PassControl deployment at all.",
  },
  status_unavailable: {
    kind: "unchecked",
    title: "The issuer could not be asked about this passport.",
    body:
      "The signature checks out, but the issuer did not answer when asked whether the passport is still active. Treat the live status as unknown rather than as revoked.",
  },
  expired: {
    kind: "forged",
    title: "This artifact has expired.",
    body:
      "Receipts do not expire, so this is a short-lived token rather than a receipt. It was valid once and is not now.",
  },
  wrong_audience: {
    kind: "forged",
    title: "This was issued for someone else.",
    body: "It names an audience other than the one it was checked against.",
  },
  revoked: {
    kind: "forged",
    title: "The passport behind this has been revoked.",
    body:
      "The signature is genuine, but the issuer reports that the passport that made this call has since been withdrawn.",
  },
};

const UNRECOGNISED: FailurePresentation = {
  // Unknown means unknown. Guessing "forged" here would let a future SDK reason
  // read as an accusation the moment this page falls behind the verifier.
  kind: "unchecked",
  title: "This receipt could not be checked.",
  body:
    "Verification stopped for a reason this page does not recognise. This is not a statement that the receipt is invalid — try again, or check it with the passcontrol command-line tool.",
};

/**
 * `bad_signature` is returned by sdk/verify.ts for two conditions that mean very
 * different things to a reader:
 *
 *   alg !== "EdDSA"          — bailed four gates before a key was ever fetched.
 *                              NOTHING was compared.
 *   ed25519.verify() → false — a real signature really did not match.
 *
 * Only the second is evidence of tampering. Wording the first as "the signature
 * does not match the contents" accuses an artifact of having been altered when
 * all we actually know is that it is not signed the way we sign things — and
 * `alg: "none"`, the classic forgery attempt, lands here too.
 *
 * So the step disambiguates. Pass it whenever it is known; without it the
 * signature-step wording is the safe default, because that is the only way this
 * reason arises once an artifact has got far enough to be checked properly.
 */
const ALGORITHM_MISMATCH: FailurePresentation = {
  kind: "forged",
  title: "This is not signed the way PassControl signs things.",
  body:
    "PassControl signs receipts with Ed25519. This artifact declares a different algorithm — or none at all — so there was never a signature of the right kind to check. Nothing about it has been verified.",
};

export function describeFailure(
  reason: VerifyFailure,
  step?: VerifyStepName
): FailurePresentation {
  if (reason === "bad_signature" && step === "algorithm") return ALGORITHM_MISMATCH;
  return FAILURES[reason] ?? UNRECOGNISED;
}

// ── What the reader pasted, read locally before any network call ─────────────

export type PeekKind = "receipt" | "agent_token" | "other_jws" | "not_jws";

export interface PeekResult {
  kind: PeekKind;
  /**
   * The issuer the artifact CLAIMS, read from an unverified payload. Never
   * present it as a fact — at this point nothing has been checked.
   */
  issuer: string | null;
  /** The `alg` header, likewise unverified. */
  algorithm: string | null;
}

const NOT_JWS: PeekResult = { kind: "not_jws", issuer: null, algorithm: null };

function decodeSegment(segment: string): Record<string, unknown> | null {
  try {
    const b64 = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const parsed: unknown = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)))
    );
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * A free, instant, offline read of pasted text — purely so the page can respond
 * before it touches the network. Catches the most likely real mistake (pasting
 * an agent token, or a JSON wrapper instead of the receipt itself) and says so,
 * rather than sending someone through a round trip that ends in "wrong_type"
 * and reads like their receipt is broken.
 */
export function peekArtifact(input: string): PeekResult {
  const parts = input.trim().split(".");
  if (parts.length !== 3) return NOT_JWS;
  const [headerPart, payloadPart] = parts as [string, string, string];
  if (!headerPart || !payloadPart) return NOT_JWS;

  const header = decodeSegment(headerPart);
  if (!header) return NOT_JWS;

  const payload = decodeSegment(payloadPart);
  const issuer = typeof payload?.iss === "string" ? payload.iss : null;
  const algorithm = typeof header.alg === "string" ? header.alg : null;

  if (header.typ === RECEIPT_TYP) return { kind: "receipt", issuer, algorithm };
  if (header.typ === AGENT_TOKEN_TYP) return { kind: "agent_token", issuer, algorithm };
  return { kind: "other_jws", issuer, algorithm };
}

/**
 * The checks that can be settled locally, before touching the network.
 *
 * Returns the step that fails and the reason, or null when the artifact gets as
 * far as needing the issuer's keys.
 *
 * ── This must agree with sdk/verify.ts, gate for gate ────────────────────────
 *
 * The page draws the inspection sequence from whichever of the two answered, so
 * if they disagreed the page would report a check as failing at a point the real
 * verifier never fails at — and the durations beside it would be describing
 * something that never ran. The order below is verify.ts's order, and
 * tests/receipt-view.test.ts cross-checks every branch against the real trace
 * rather than against a second copy of my assumptions.
 *
 * The issuer branch is the one that is here for its own sake: `iss` comes from
 * an unverified payload, so until a signature says otherwise it is a string the
 * receipt's author chose. It is checked before anything is handed to fetch().
 */
export function preflight(input: string): { step: VerifyStepName; reason: VerifyFailure } | null {
  const peek = peekArtifact(input);
  if (peek.kind === "not_jws") return { step: "parse", reason: "malformed" };
  if (peek.algorithm !== "EdDSA") return { step: "algorithm", reason: "bad_signature" };
  if (peek.kind !== "receipt") return { step: "type", reason: "wrong_type" };
  if (!isFetchableIssuer(peek.issuer)) return { step: "issuer", reason: "untrusted_issuer" };
  return null;
}

/**
 * Is this issuer something we can safely go and fetch a key set from?
 *
 * The page trusts whatever issuer the receipt names — that is the design, and it
 * is what makes the page work for self-hosted deployments. But "trust the name"
 * must not become "hand an arbitrary string to fetch()". An https origin, or
 * loopback http so the local Docker stack works, and nothing else: no
 * javascript:, no data:, no file:, no credentials smuggled in the userinfo.
 *
 * Mirrors instanceIssuer() in lib/crypto/instanceKey.ts, which applies the same
 * rule at the signing end. Both ends agreeing on what an issuer may look like is
 * the point.
 */
export function isFetchableIssuer(issuer: string | null): boolean {
  if (!issuer) return false;
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.search || url.hash) return false;
  if (url.pathname !== "/" && url.pathname !== "") return false;
  if (url.protocol === "https:") return true;
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  return url.protocol === "http:" && loopback;
}

// ── The verdict the receipt records ──────────────────────────────────────────

export interface VerdictPresentation {
  label: string;
  detail: string;
  tone: DepartureTone;
}

const VERDICTS: Record<string, VerdictPresentation> = {
  ok: {
    label: "Allowed",
    detail: "The gateway checked this call against its rules and let it through.",
    tone: "clear",
  },
  upstream_error: {
    label: "Allowed, then failed upstream",
    detail:
      "The gateway permitted this call, but the provider it was forwarded to returned an error.",
    tone: "held",
  },
  blocked_scope: {
    label: "Refused — outside what this agent may call",
    detail: "The agent is not permitted to use this provider or this model.",
    tone: "held",
  },
  blocked_budget: {
    label: "Refused — over budget",
    detail: "The call would have taken the agent past the spending limit set for it.",
    tone: "held",
  },
  blocked_endpoint: {
    label: "Refused — endpoint not allowed",
    detail: "The agent may use this provider, but not this particular endpoint.",
    tone: "held",
  },
  blocked_policy: {
    label: "Refused by policy",
    detail: "A rule the operator set on this agent rejected the call.",
    tone: "held",
  },
  blocked_suspended: {
    label: "Refused — agent suspended",
    detail: "The operator had paused this agent when the call was made.",
    tone: "denied",
  },
  blocked_killed: {
    label: "Refused — kill switch active",
    detail: "The operator had stopped all calls when this one was attempted.",
    tone: "denied",
  },
};

/** An unrecognised status is shown as itself rather than dressed up as a known one. */
export function describeVerdict(status: string, http: number): VerdictPresentation {
  const known = VERDICTS[status];
  if (known) return { ...known, detail: `${known.detail} (HTTP ${http})` };
  return {
    label: `Recorded as ${status}`,
    detail: `This page does not recognise that verdict, so it is shown exactly as the receipt records it. (HTTP ${http})`,
    tone: "held",
  };
}

// ── Formatting ───────────────────────────────────────────────────────────────

export function describeCall(
  claims: Pick<ReceiptClaims, "mth" | "path" | "prov" | "mdl">
): string {
  const target = claims.mdl ? `${claims.prov}/${claims.mdl}` : claims.prov;
  return `${claims.mth} ${claims.path} → ${target}`;
}

export interface CostPresentation {
  /** Readable headline figure. */
  primary: string;
  /** The exact recorded value, or null when there is nothing to be exact about. */
  exact: string | null;
}

/**
 * `cost` is recorded in MICROCENTS — a millionth of a cent — because the gateway
 * has to add up per-token prices without rounding error accumulating.
 *
 * Rendering that directly is doubly wrong on this page. "61 µ¢" is jargon, and
 * the obvious fix of converting to dollars and fixing to four places prints
 * "$0.0000" for any small call, which on a document whose entire job is to be an
 * accurate financial record reads as "this cost nothing". It didn't.
 *
 * So: an adaptive headline that never rounds a real charge down to zero, plus
 * the exact recorded figure underneath, because an auditor reading a receipt is
 * entitled to the number that was actually signed.
 */
export function formatCost(microcents: number): CostPresentation {
  if (!Number.isFinite(microcents) || microcents < 0) {
    return { primary: "Not recorded", exact: null };
  }
  if (microcents === 0) return { primary: "No charge recorded", exact: null };

  const dollars = microcents / (100 * MICROCENTS_PER_CENT);
  const exact = `${microcents.toLocaleString("en-GB")} microcents recorded`;

  if (dollars >= 0.01) return { primary: `$${dollars.toFixed(2)}`, exact };
  if (dollars >= 0.0001) return { primary: `$${dollars.toFixed(4)}`, exact };
  return { primary: "Under $0.0001", exact };
}

const DATE = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "UTC",
});

/** `iat` is whole seconds. A zero or non-finite value is missing, not 1970. */
export function formatSignedAt(iat: number): string {
  if (!Number.isFinite(iat) || iat <= 0) return "Not recorded";
  return `${DATE.format(new Date(iat * 1000))} UTC`;
}

// ── The owner claim ──────────────────────────────────────────────────────────

export interface OwnerPresentation {
  subject: string;
  note: string;
  verified: boolean;
}

/**
 * Worded off `tier`, never off `kind` — the same rule as OwnerValue on the
 * passport page. `kind` records the method attempted; `tier` records what was
 * actually proven. Reading "domain" from `kind` would let anyone type a domain
 * into a form and have this page vouch for it on the Vertias domain.
 *
 * An unrecognised tier resolves DOWNWARD to unproven, so a future tier this page
 * has not learned about can never be shown as verified by accident.
 */
export function describeOwner(own: ReceiptClaims["own"] | null): OwnerPresentation | null {
  if (!own || typeof own.sub !== "string" || !own.sub) return null;

  const proven = own.tier === "domain" || own.tier === "idv";
  if (!proven) {
    return {
      subject: own.sub,
      note: "Self-declared by the operator. The issuer has not verified this claim.",
      verified: false,
    };
  }

  const how =
    own.tier === "domain" ? "Verified by control of this domain" : "Verified by identity check";
  const when = own.vat ? ` · last confirmed ${DATE.format(new Date(own.vat))}` : "";
  return { subject: own.sub, note: `${how}${when}`, verified: true };
}

// ── The inspection sequence's state, as a pure reduction ─────────────────────
//
// This lives here, next to the failure copy, and not in the component, for the
// reason the whole page exists: the row list is the *evidence* a reader is being
// shown. It has to be exactly as trustworthy as the verifier's own answer, and
// evidence assembled inside a React updater closure is not testable.
//
// It was got wrong once in precisely that way. The component held a mutable
// `shown` counter and read it from inside a setState updater, which React
// invokes lazily — by then the counter had already advanced, so every step's
// result landed on the following row. On a FORGED receipt that rendered
// "Signature matches the contents ✓" above a red "this receipt has been
// altered" card: the evidence panel vouching for a signature the verifier had
// just rejected. Passing the index in explicitly, to a function that cannot see
// a counter at all, is what makes that class of bug unrepresentable.

export type RowState = "waiting" | "active" | "pass" | "fail" | "not-reached";

export interface StepRow {
  name: VerifyStepName;
  state: RowState;
  ms: number | null;
}

/** The verifier's real gate order. The rows are this list, always, in this order. */
export const STEP_ORDER: readonly VerifyStepName[] = [
  "parse",
  "algorithm",
  "type",
  "issuer",
  "version",
  "jwks",
  "key",
  "signature",
] as const;

export const initialStepRows = (): StepRow[] =>
  STEP_ORDER.map((name, i) => ({ name, state: i === 0 ? "active" : "waiting", ms: null }));

/**
 * One shared way to draw a failure, whether it came from preflight or from a
 * trace. Everything before the failing step passed; everything after it never
 * ran — the distinction the entire failure design rests on, so it must not be
 * open to being got subtly wrong in two places.
 */
export function rowsFailingAt(step: VerifyStepName, ms = 0): StepRow[] {
  const at = STEP_ORDER.indexOf(step);
  return STEP_ORDER.map((name, i) => ({
    name,
    state: i < at ? "pass" : i === at ? "fail" : "not-reached",
    ms: i <= at ? ms : null,
  }));
}

/**
 * Apply one traced step to the rows. `index` is the position of the step being
 * applied and is always passed by the caller — never inferred, never read from
 * a counter that could have moved.
 */
export function applyStep(
  rows: readonly StepRow[],
  index: number,
  step: { ok: boolean; ms: number }
): StepRow[] {
  return rows.map((row, i) => {
    if (i === index) return { ...row, state: step.ok ? "pass" : "fail", ms: step.ms };
    // A failed gate stops the run: nothing after it was ever attempted, and
    // saying so is what separates "forged" from "we never got that far".
    if (!step.ok && i > index) return { ...row, state: "not-reached", ms: null };
    if (step.ok && i === index + 1) return { ...row, state: "active", ms: null };
    return row;
  });
}

/**
 * The honest total: the sum of the real check durations, so a reader can add the
 * rows up and get this number. Deliberately NOT wall-clock — the sequence is
 * revealed on a paced timeline, and reporting that pacing as the cost of
 * verification would be inventing duration on the one page that promises not to.
 */
export function totalCheckMs(rows: readonly StepRow[]): number {
  return rows.reduce((sum, row) => sum + (row.ms ?? 0), 0);
}
