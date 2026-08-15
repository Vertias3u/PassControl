// Server-side input validation for the dashboard server actions. These run on
// the server regardless of any client-side checks. Each validator throws an
// Error with a safe, generic message (no internals) on bad input; callers let it
// surface to the action's error boundary.
import { isProvider } from "./providers";
import {
  MAX_FALLBACKS,
  MAX_FALLBACK_MODEL_LEN,
  type FallbackEntry,
} from "./providers/fallbacks";
import { passportIdToPublicKey } from "./crypto/ed25519";
import { modelPatternIsUsable, policyIsWellFormed } from "./scope";

export const LIMITS = {
  agentName: 80,
  label: 80,
  providerKey: 500, // provider API keys are well under this
  models: 50, // max model patterns per scope entry
  // Kept for the callers that bound a pattern's LENGTH (break-glass's scope
  // union). Whether a pattern is one the gateway will actually evaluate is asked
  // of the matcher itself — modelPatternIsUsable — not decided from this number.
  modelPattern: 200,
  scopes: 20, // max scope entries
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Validate the identity-independent part of a new agent. Direct-first and
 * passport-first creation must share this exact scope/budget boundary. */
export function validateAgentProfileInput(input: {
  name?: unknown;
  scopes?: unknown;
  budget_tokens?: unknown;
  budget_cents?: unknown;
}): {
  name: string;
  scopes: { provider: string; models: string[] }[];
  budget_tokens: number | null;
  budget_cents: number | null;
} {
  const name = str(input.name).trim();
  if (name.length < 1 || name.length > LIMITS.agentName) {
    throw new Error(`Agent name must be 1–${LIMITS.agentName} characters.`);
  }

  return {
    name,
    scopes: validateScopes(input.scopes),
    budget_tokens: input.budget_tokens === undefined ? null : budget(input.budget_tokens, "budget_tokens"),
    budget_cents: input.budget_cents === undefined ? null : budget(input.budget_cents, "budget_cents"),
  };
}

/** Validate + normalize a new passport-agent payload. Throws on invalid input. */
export function validateAgentInput(input: {
  name?: unknown;
  passportPubkey?: unknown;
  scopes?: unknown;
  budget_tokens?: unknown;
  budget_cents?: unknown;
}): {
  name: string;
  passportPubkey: string;
  scopes: { provider: string; models: string[] }[];
  budget_tokens: number | null;
  budget_cents: number | null;
} {
  const profile = validateAgentProfileInput(input);
  const passportPubkey = str(input.passportPubkey).trim();
  // Must decode to a raw 32-byte Ed25519 public key.
  if (!passportPubkey || !passportIdToPublicKey(passportPubkey)) {
    throw new Error("Invalid passport public key.");
  }
  return { ...profile, passportPubkey };
}

/** Validate + normalize a scopes array. Throws on invalid input. */
export function validateScopes(raw: unknown): { provider: string; models: string[] }[] {
  if (!Array.isArray(raw) || raw.length > LIMITS.scopes) {
    throw new Error("Invalid scopes.");
  }
  return raw.map((s: unknown) => {
    const entry = (s ?? {}) as { provider?: unknown; models?: unknown };
    const provider = str(entry.provider).trim();
    if (!isProvider(provider)) throw new Error("Unknown provider in scope.");
    if (!Array.isArray(entry.models) || entry.models.length > LIMITS.models) {
      throw new Error("Invalid models in scope.");
    }
    const models = entry.models.map((m: unknown) => {
      const pattern = str(m).trim();
      // Asked of the matcher rather than re-derived, for the reason
      // validateFallbacks sets out below: a pattern this accepts but the matcher
      // will not evaluate saves cleanly, appears in the scope list, and then
      // matches nothing — every call 403s and the scope row says it shouldn't.
      // The matcher refuses over-long and wildcard-stuffed patterns, so this
      // must too.
      if (!pattern || !modelPatternIsUsable(pattern)) {
        throw new Error("Invalid model pattern in scope.");
      }
      return pattern;
    });
    return { provider, models };
  });
}

/**
 * Validate + normalize an ordered fallback list. Throws on invalid input.
 *
 * ── This must never be looser than parseFallbacks ────────────────────────────
 *
 * The gateway re-parses this column out of untrusted jsonb (a tenant can PATCH
 * it directly through PostgREST), and that parser rejects the ENTIRE list on any
 * violation rather than skipping the offending entry. So a validator that
 * accepts even one thing the parser refuses produces the worst outcome
 * available: the operator's save succeeds, the editor reads the list back, and
 * the gateway silently honours none of it — indistinguishable from a provider
 * that simply never failed. Both bounds are therefore imported from the parser's
 * own module rather than retyped beside LIMITS. tests/validate.test.ts pins the
 * round-trip property.
 *
 * `[]` is a legitimate value and means "no failover" — the same thing the column
 * default means, and the way an operator turns the feature back off.
 */
export function validateFallbacks(raw: unknown): FallbackEntry[] {
  if (!Array.isArray(raw)) throw new Error("Invalid fallbacks.");
  if (raw.length > MAX_FALLBACKS) {
    throw new Error(`At most ${MAX_FALLBACKS} fallback providers.`);
  }
  return raw.map((f: unknown) => {
    const entry = (f ?? {}) as { provider?: unknown; model?: unknown };
    const provider = str(entry.provider).trim();
    if (!isProvider(provider)) throw new Error("Unknown provider in fallbacks.");
    const model = str(entry.model).trim();
    if (!model || model.length > MAX_FALLBACK_MODEL_LEN) {
      throw new Error("Invalid model in fallbacks.");
    }
    // A fallback names a model to CALL, not a pattern to match. `*` is
    // legitimate in a scope entry and meaningless sent upstream.
    if (model.includes("*")) {
      throw new Error("A fallback must name one exact model, not a pattern.");
    }
    return { provider, model };
  });
}

/**
 * Validate a policy document — the live one or a shadow candidate.
 *
 * The bounds are NOT restated here. `policyIsWellFormed` is the gateway's own
 * read-side boundary (`parsePolicy`) asked directly, so this validator cannot
 * drift from what the proxy will actually honour. Retyping the shape is how
 * `validateFallbacks` nearly went wrong, and policy has more surface than
 * fallbacks does.
 *
 * `null` is a legitimate value and means "no policy" — the way an operator turns
 * a live policy off, and the way they turn shadow mode off.
 *
 * Note the asymmetry with the read path, which is deliberate. A malformed LIVE
 * policy is read as `policy:malformed` and denies; a malformed SHADOW policy is
 * inert, because diagnostics that can change a decision are not diagnostics.
 * Neither is a reason to let a malformed document into either column in the
 * first place: an operator who typed a bad rule should be told so at the form,
 * not discover it from traffic.
 */
export function validatePolicy(raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;
  if (!policyIsWellFormed(raw)) {
    throw new Error("That policy is not valid. Check the deny rules, windows and rate limit.");
  }
  return raw;
}

/** A non-negative integer budget, or null (= unlimited / no cap). Throws otherwise. */
function budget(v: unknown, label: string): number | null {
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    throw new Error(`${label} must be a non-negative integer or null.`);
  }
  return v;
}

/** Validate a partial agent-update payload → a DB column patch with only the
 *  provided fields. Throws on invalid input. Allows name / scopes / budgets /
 *  fallbacks — the four the `authenticated` role may UPDATE (migrations 0011
 *  and 0018). A column absent from that grant must not appear here. */
export function validateAgentUpdate(input: {
  name?: unknown;
  scopes?: unknown;
  budget_tokens?: unknown;
  budget_cents?: unknown;
  fallbacks?: unknown;
}): {
  name?: string;
  allowed_scopes?: { provider: string; models: string[] }[];
  budget_tokens?: number | null;
  budget_cents?: number | null;
  fallbacks?: FallbackEntry[];
} {
  const patch: {
    name?: string;
    allowed_scopes?: { provider: string; models: string[] }[];
    budget_tokens?: number | null;
    budget_cents?: number | null;
    fallbacks?: FallbackEntry[];
  } = {};
  if (input.name !== undefined) {
    const name = str(input.name).trim();
    if (name.length < 1 || name.length > LIMITS.agentName) {
      throw new Error(`Agent name must be 1–${LIMITS.agentName} characters.`);
    }
    patch.name = name;
  }
  if (input.scopes !== undefined) patch.allowed_scopes = validateScopes(input.scopes);
  if (input.budget_tokens !== undefined) patch.budget_tokens = budget(input.budget_tokens, "budget_tokens");
  if (input.budget_cents !== undefined) patch.budget_cents = budget(input.budget_cents, "budget_cents");
  // `[]` is a value, not an absence: it is how failover is switched off. Only an
  // undefined field leaves the column untouched.
  if (input.fallbacks !== undefined) patch.fallbacks = validateFallbacks(input.fallbacks);
  return patch;
}

/** Validate a provider-key add payload. Throws on invalid input. */
export function validateProviderKeyInput(input: {
  provider?: unknown;
  label?: unknown;
  key?: unknown;
}): { provider: string; label: string; key: string } {
  const provider = str(input.provider).trim();
  if (!isProvider(provider)) throw new Error("Unknown provider.");

  const label = str(input.label).trim();
  if (label.length > LIMITS.label) throw new Error("Label too long.");

  const key = str(input.key);
  if (key.length < 1 || key.length > LIMITS.providerKey) {
    throw new Error("Invalid provider key.");
  }
  return { provider, label, key };
}

/** Validate a provider-key rotation payload. Throws on invalid input. */
export function validateRotateInput(input: {
  credentialId?: unknown;
  key?: unknown;
}): { credentialId: string; key: string } {
  const credentialId = str(input.credentialId).trim();
  if (!UUID_RE.test(credentialId)) throw new Error("Invalid credential id.");

  const key = str(input.key);
  if (key.length < 1 || key.length > LIMITS.providerKey) {
    throw new Error("Invalid provider key.");
  }
  return { credentialId, key };
}
