// Admin-action audit: a durable, per-tenant trail of privileged dashboard
// mutations (the operator-accountability counterpart to agent_logs). Rows are
// written with the service-role client (clients have no insert path — see
// migration 0003 RLS) and are append-only by convention.
//
// The row builder is pure + sanitized so an injected field can't forge an audit
// entry; recordAdminAction is best-effort (a failed audit write must not break
// the user's action, but it is logged).
import { serviceClient } from "./supabase";
import { sanitizeValue } from "./seclog";

// Only these constants may be logged — actions are set by our own code, never by
// request input, so this allowlist is a guard against a wrong/forged value.
export const AUDIT_ACTIONS = [
  "agent.create",
  "agent.update",
  "agent.suspend",
  "agent.revoke",
  "provider_key.add",
  "provider_key.rotate",
  "killswitch.master",
  "apikey.create",
  "apikey.revoke",
  "mfa.enroll",
  "mfa.disable",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

const TARGET_TYPE_MAX = 40;
const TARGET_ID_MAX = 200;

export interface AuditInput {
  userId: string;
  action: AuditAction;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface AuditRecord {
  user_id: string;
  action: AuditAction;
  target_type: string | null;
  target_id: string | null;
  metadata: Record<string, unknown>;
}

/** Build a sanitized audit row. Throws on an action outside the allowlist. */
export function buildAuditRecord(input: AuditInput): AuditRecord {
  if (!AUDIT_ACTIONS.includes(input.action)) {
    throw new Error(`unknown audit action: ${String(input.action)}`);
  }
  const metadata: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input.metadata ?? {})) metadata[k] = sanitizeValue(v);

  const targetType =
    input.targetType != null ? String(sanitizeValue(input.targetType)).slice(0, TARGET_TYPE_MAX) : null;
  const targetId =
    input.targetId != null ? String(sanitizeValue(input.targetId)).slice(0, TARGET_ID_MAX) : null;

  return { user_id: input.userId, action: input.action, target_type: targetType, target_id: targetId, metadata };
}

/** Write an admin-action audit row. Best-effort: never throws into the caller's
 *  action; a failed write is logged server-side. */
export async function recordAdminAction(input: AuditInput): Promise<void> {
  try {
    const record = buildAuditRecord(input);
    const { error } = await serviceClient().from("admin_audit").insert(record);
    if (error) {
      // eslint-disable-next-line no-console
      console.error("[audit] insert failed:", String(sanitizeValue(error.message)));
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[audit] error:", e instanceof Error ? String(sanitizeValue(e.message)) : "unknown");
  }
}
