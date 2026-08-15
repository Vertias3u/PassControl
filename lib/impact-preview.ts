// Prospective changes rendered with the exact same reader as capability
// history. These helpers deliberately construct the audit-row shape rather
// than re-describing scopes, fallbacks, policies, elevation, or key lifecycle.
import {
  summariseChange,
  type CapabilityChange,
} from "./audit-history";
import type { ScopeRow } from "./scope-rows";

function requireChange(raw: unknown): CapabilityChange {
  const change = summariseChange(raw);
  if (!change) throw new Error("Impact preview did not describe an agent change.");
  return change;
}

export function prospectiveAgentChange(
  fields: string,
  from: unknown,
  to: unknown,
  metadata: Record<string, unknown> = {}
): CapabilityChange {
  return requireChange({
    id: "impact-preview",
    action: "agent.update",
    created_at: null,
    metadata: {
      fields,
      via: "dashboard",
      from: JSON.stringify(from),
      to: JSON.stringify(to),
      ...metadata,
    },
  });
}

export function prospectiveBreakGlassChange(
  scopes: readonly ScopeRow[],
  expiresAt: string,
  reason: string
): CapabilityChange {
  return requireChange({
    id: "impact-preview",
    action: "agent.break_glass",
    created_at: null,
    metadata: {
      via: "dashboard",
      scopes: JSON.stringify(scopes),
      expires_at: expiresAt,
      reason,
    },
  });
}

export function prospectivePassportRotation(
  currentPassportId: string,
  graceSeconds: number
): CapabilityChange {
  return prospectiveAgentChange(
    "passport_pubkey",
    currentPassportId,
    "new browser-generated key",
    { rotated: true, planned: true, grace_seconds: graceSeconds }
  );
}
