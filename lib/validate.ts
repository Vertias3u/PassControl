// Server-side input validation for the dashboard server actions. These run on
// the server regardless of any client-side checks. Each validator throws an
// Error with a safe, generic message (no internals) on bad input; callers let it
// surface to the action's error boundary.
import { isProvider } from "./providers";
import { passportIdToPublicKey } from "./crypto/ed25519";

export const LIMITS = {
  agentName: 80,
  label: 80,
  providerKey: 500, // provider API keys are well under this
  models: 50, // max model patterns per scope entry
  modelPattern: 200,
  scopes: 20, // max scope entries
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Validate + normalize a new-agent payload. Throws on invalid input. */
export function validateAgentInput(input: {
  name?: unknown;
  passportPubkey?: unknown;
  scopes?: unknown;
}): {
  name: string;
  passportPubkey: string;
  scopes: { provider: string; models: string[] }[];
} {
  const name = str(input.name).trim();
  if (name.length < 1 || name.length > LIMITS.agentName) {
    throw new Error(`Agent name must be 1–${LIMITS.agentName} characters.`);
  }

  const passportPubkey = str(input.passportPubkey).trim();
  // Must decode to a raw 32-byte Ed25519 public key.
  if (!passportPubkey || !passportIdToPublicKey(passportPubkey)) {
    throw new Error("Invalid passport public key.");
  }

  return { name, passportPubkey, scopes: validateScopes(input.scopes) };
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
      if (!pattern || pattern.length > LIMITS.modelPattern) {
        throw new Error("Invalid model pattern in scope.");
      }
      return pattern;
    });
    return { provider, models };
  });
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
 *  provided fields. Throws on invalid input. Allows name / scopes / budgets. */
export function validateAgentUpdate(input: {
  name?: unknown;
  scopes?: unknown;
  budget_tokens?: unknown;
  budget_cents?: unknown;
}): { name?: string; allowed_scopes?: { provider: string; models: string[] }[]; budget_tokens?: number | null; budget_cents?: number | null } {
  const patch: {
    name?: string;
    allowed_scopes?: { provider: string; models: string[] }[];
    budget_tokens?: number | null;
    budget_cents?: number | null;
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
