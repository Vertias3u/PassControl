// Is this passport good right now?
//
// ── Why this is a module and not two functions ──────────────────────────────
//
// The rule already exists once, as the gate order inside
// findAuthenticatablePassport (lib/auth/passport.ts): status, then passport
// expiry, then the retired-key deadline. Its header calls that order "policy,
// not preference" and gives the reason — an operator debugging a fleet must be
// able to tell "someone revoked this" from "this aged out".
//
// Two PUBLIC surfaces have to give the same answer that gate would, and before
// this module neither knew about expiry at all:
//
//   /verify/<passportId>   reported an expired passport as "Valid"
//   /u/<handle>            reported an expired agent as active in its listing
//
// They are fed by different RPCs (verify_passport, public_operator_agents) and
// carried their own separate status unions, so widening one would not have
// touched the other and the compiler would not have said so. One fact with two
// public answers is the defect this codebase keeps logging about; hence one
// exported rule, and both surfaces call it.
//
// ── What it deliberately is NOT ─────────────────────────────────────────────
//
// Not an auth gate. Nothing here decides whether a visa is minted — the gateway
// keeps its own copy of the order, inside the lookup that also does the
// ambiguity refusal and the security logging. This is the READ-ONLY projection
// of that decision, and tests/public-verification.test.ts asserts the two agree
// case by case. Factoring the gate itself out of findAuthenticatablePassport is
// the better long-term fix; doing it here would put a public-surface change
// into the mint path, which is not a blast radius this task wants.

/** The states a public surface may report. `expired` is derived, never stored. */
export type PassportValidity = "active" | "expired" | "suspended" | "revoked" | "unknown";

export interface PassportValidityInput {
  /** The `agents.status` enum value, as stored. */
  status: unknown;
  /** `agents.expires_at`. null = never expires, which is every pre-0021 row. */
  expiresAt: string | null;
  /** True when the id presented was the agent's RETIRED key, not its current one. */
  usedRetiredKey?: boolean;
  /** `agents.previous_valid_until` — when the retired key stops authenticating. */
  retiredValidUntil?: string | null;
}

/**
 * Past, and unreadable counts as past.
 *
 * Copied in spirit from lib/auth/passport.ts's isPast for the same reason it
 * gives: a deadline nobody can parse is not permission to keep going. Every
 * ambiguity in this file resolves toward "not valid".
 */
function isPast(value: string | null | undefined, now: number): boolean {
  if (typeof value !== "string" || !value.trim()) return true;
  const at = Date.parse(value);
  return !Number.isFinite(at) || at <= now;
}

/**
 * The public answer, in the gateway's own order.
 *
 * An unrecognised lifecycle state resolves to `unknown`, never upward to
 * `active` — the same downward discipline the normalisers in lib/verify and
 * lib/profile already apply to owner tiers. Drift that renders as "valid" would
 * be a false claim about somebody's identity on a page strangers read.
 */
export function effectivePassportStatus(
  input: PassportValidityInput,
  now: number = Date.now()
): PassportValidity {
  if (input.status !== "active") {
    return input.status === "suspended" || input.status === "revoked" ? input.status : "unknown";
  }

  // null means never expires and must stay that way: every row holds null the
  // moment 0021 applies, so treating it as a missing deadline would retire the
  // entire existing fleet on a page refresh.
  if (input.expiresAt !== null && isPast(input.expiresAt, now)) return "expired";

  // Only binds when the RETIRED key is the one being asked about. A row midway
  // through a rotation would otherwise report its live current key as dead.
  if (input.usedRetiredKey && isPast(input.retiredValidUntil, now)) return "expired";

  return "active";
}
