// The three states of passport proof-of-possession, in one place.
//
// Small on purpose. `lib/state/policy.ts` reads the mode on the credential
// path, the dashboard reads it to render a control, and the proxy's observe
// branch records against it — three importers, and a normaliser copied into
// three files is how a fourth state ends up meaning something different in each
// of them. There is no Redis, no database and no `server-only` here, so a test
// or a client component can import it without dragging the gateway in.
//
// See db/migrations/0049 for why this replaced 0046's boolean.

export type SenderConstraintMode = "off" | "observe" | "required";

/** Every value the column may hold, in the order 0049's CHECK lists them. */
export const SENDER_CONSTRAINT_MODES: readonly SenderConstraintMode[] = [
  "off",
  "observe",
  "required",
];

/**
 * Resolve a stored value, and resolve it DOWNWARD.
 *
 * A mode this build does not understand must not read as `required` — that
 * would refuse every call for an agent whose operator configured something we
 * simply have not shipped yet — and must not read as absent, which the proxy
 * treats as an authentication failure. `off` is the only answer that is both
 * safe and honest about what we know. Same discipline as `normalizeStatus` and
 * `normalizeTier` in lib/verify/passport.ts.
 */
export function toSenderConstraintMode(value: unknown): SenderConstraintMode {
  return SENDER_CONSTRAINT_MODES.includes(value as SenderConstraintMode)
    ? (value as SenderConstraintMode)
    : "off";
}

/**
 * What observe mode found. Recorded on `agent_logs.sender_proof_would` and
 * nowhere else — never on `auth_method`, because an unenforced proof is not
 * assurance and a receipt is handed to third parties.
 */
export type SenderProofObservation = "pass" | "missing" | "invalid" | "clock_skew" | "replayed";

/** Every verdict, so a summary cannot silently omit one it has not thought about. */
export const SENDER_PROOF_OBSERVATIONS: readonly SenderProofObservation[] = [
  "pass",
  "missing",
  "invalid",
  "clock_skew",
  "replayed",
];
