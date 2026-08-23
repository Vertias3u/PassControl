// Admin-action audit: a durable, per-tenant trail of privileged dashboard
// mutations (the operator-accountability counterpart to agent_logs). Rows are
// written with the service-role client (clients have no insert path — see
// migration 0003 RLS) and are append-only by convention.
//
// The row builder is pure + sanitized so an injected field can't forge an audit
// entry; recordAdminAction is best-effort (a failed audit write must not break
// the user's action, but it is logged).
import { serviceClient } from "./supabase";
import { captureError } from "./observability";
import { sanitizeValue } from "./seclog";

// Only these constants may be logged — actions are set by our own code, never by
// request input, so this allowlist is a guard against a wrong/forged value.
export const AUDIT_ACTIONS = [
  "agent.create",
  "agent.direct_key.create",
  "agent.direct_key.revoke",
  "agent.update",
  "agent.suspend",
  "agent.revoke",
  "provider_key.add",
  "provider_key.rotate",
  // Which stored credential the gateway injects, and the destruction of one.
  // Both change what gets billed upstream, so both belong in the audit trail.
  "provider_key.activate",
  "provider_key.delete",
  "killswitch.master",
  "agent.break_glass",
  "owner.set",
  "owner.publish",
  "owner.verify",
  // The operator's own identity. `profile.publish` and `profile.handle` are the
  // two that matter to a reader of this trail: one changes what a stranger can
  // see, and the other permanently consumes a handle out of a global namespace.
  "profile.update",
  "profile.handle",
  "profile.publish",
  "profile.avatar",
  "profile.avatar_removed",
  // Listing one agent publicly. Distinct from profile.publish: this is the
  // second, independent opt-in, and an audit trail that conflated them could
  // not answer "when did this agent become visible to strangers".
  "agent.publish",
  "apikey.create",
  "apikey.revoke",
  "mfa.enroll",
  "mfa.disable",
  // Taking a portable copy of the workspace configuration, and restoring one.
  // `workspace.export` is written by BOTH the dashboard route and the
  // control-plane read endpoint, because the Recovery panel reads the newest one
  // back as "Last export" — a CLI export that wrote no row would leave the panel
  // quietly claiming the operator has never taken one.
  //
  // Both strings have to be HERE or they do nothing at all: buildAuditRecord
  // throws on an action outside this list and recordAdminAction swallows that
  // throw, so a missing entry writes no row, raises nothing, and looks exactly
  // like a workspace nobody has ever exported.
  "workspace.export",
  "workspace.import",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

const TARGET_TYPE_MAX = 40;
const TARGET_ID_MAX = 200;

/**
 * ── Audit metadata is not a log line ────────────────────────────────────────
 *
 * Metadata used to go through seclog's `sanitizeValue`, whose 256-character
 * bound is a log-INJECTION control for a one-line stdout surface. Metadata is
 * not that: it is structured JSON in a jsonb column, and the capability writers
 * stringify whole scope / fallback / policy documents into it. The log bound cut
 * those mid-JSON, admin_audit is append-only, and no reader could recover them —
 * the row then read as if the change predated the record of previous values.
 *
 * So the audit side keeps its own bound. Two things decide the number, and both
 * are written down here because a bare constant with no reasoning is exactly how
 * the 256 got in.
 *
 * FIRST: it must be a size an INSERT can actually carry. A row holds two
 * snapshots — `from` and `to` — so the per-value bound is half a row budget, not
 * a value budget. Sized generously (256 KiB per value) the fix made the worst
 * case WORSE: a pathological save becomes a ~410 KB insert, `recordAdminAction`
 * swallows a failed insert, and the row would vanish entirely where before it
 * merely arrived cut. No row is worse than a damaged row on the one surface
 * whose job is the record. 64 KiB of snapshot per row sits an order of magnitude
 * below the smallest request-body limit anything on this path imposes, so
 * "will it insert" stops being a question worth asking.
 *
 * SECOND: it must still hold a real document. `LIMITS` permits 20 scope entries
 * x 50 model patterns = 1,000 patterns, and at the length real identifiers run
 * ("claude-sonnet-4-20250514" is 24 characters) that entire ceiling serialises
 * to roughly 28 KB — inside 32 KiB, so an operator using every slot the product
 * sells them keeps their snapshot. Only a document of near-maximum 200-character
 * patterns exceeds it, and a policy document has no count bound at all
 * (`parsePolicy` limits pattern length, not how many rules). Those are DECLINED,
 * explicitly, with the marker below — the operator reads "too large to record"
 * instead of a cut string that still looks like data, or a row that never
 * arrived.
 */
const AUDIT_ROW_SNAPSHOT_BUDGET = 64 * 1024;
/** `from` and `to`: the two snapshot values one capability-change row carries. */
const SNAPSHOTS_PER_ROW = 2;
export const AUDIT_VALUE_MAX_CHARS = AUDIT_ROW_SNAPSHOT_BUDGET / SNAPSHOTS_PER_ROW;

/**
 * What is stored in place of a value past that ceiling.
 *
 * Never a truncated prefix: a cut string still looks like data to every reader,
 * which is how the original defect stayed invisible. A marker is not a snapshot
 * and cannot be mistaken for one — `lib/audit-history.ts` renders any side it
 * cannot parse as "recorded, but what is stored cannot be read", which is the
 * truth here.
 */
export interface AuditOmission {
  omitted: "too_large";
  chars: number;
}

/**
 * Strip control characters, bound the length, keep the JSON.
 *
 * Control characters are still stripped — an audit value is read back into the
 * dashboard and can reach a log line elsewhere — but note this is a no-op on the
 * values that matter most: `JSON.stringify` escapes control characters, so a
 * snapshot never contains a raw one. Non-strings pass through untouched, as
 * before (booleans, numbers and counts are written by our own code).
 */
export function sanitizeAuditValue(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const clean = v.replace(/[\r\n\t\x00-\x1f\x7f]/g, " ");
  if (clean.length <= AUDIT_VALUE_MAX_CHARS) return clean;
  const omission: AuditOmission = { omitted: "too_large", chars: clean.length };
  return omission;
}

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
  for (const [k, v] of Object.entries(input.metadata ?? {})) metadata[k] = sanitizeAuditValue(v);

  // targetType/targetId keep the log-style treatment deliberately: they are
  // short identifiers (a uuid, the word "agent"), they are what the history
  // query filters on, and a 200-character bound on them is correct.
  const targetType =
    input.targetType != null ? String(sanitizeValue(input.targetType)).slice(0, TARGET_TYPE_MAX) : null;
  const targetId =
    input.targetId != null ? String(sanitizeValue(input.targetId)).slice(0, TARGET_ID_MAX) : null;

  return { user_id: input.userId, action: input.action, target_type: targetType, target_id: targetId, metadata };
}

/**
 * Report a failed audit write without letting the report itself fail anything.
 *
 * The swallow above it is deliberate and stays: an audit write must never break
 * the operator's action. But swallowed and unnoticed are different things, and
 * a console line on an edge function is not something anyone is watching. A row
 * that quietly never lands is the single failure this subsystem cannot afford to
 * be quiet about — the record is the product. Same shape lib/log.ts uses for the
 * same reason, and `.catch` because observability must not become the thing that
 * throws.
 */
async function reportAuditFailure(reason: string, input: AuditInput): Promise<void> {
  await captureError(new Error(reason), {
    route: "lib.audit.recordAdminAction",
    method: "INSERT",
    status: 500,
    // Only allowlisted, non-secret context survives the scrubber. The action and
    // the agent are what makes the alert actionable: which record is missing.
    event: input.action,
    agentId: input.targetType === "agent" && input.targetId ? String(input.targetId) : undefined,
    code: "admin_audit_insert_failed",
  }).catch(() => {});
}

/** Write an admin-action audit row. Best-effort: never throws into the caller's
 *  action; a failed write is logged server-side AND reported. */
export async function recordAdminAction(input: AuditInput): Promise<void> {
  try {
    const record = buildAuditRecord(input);
    const { error } = await serviceClient().from("admin_audit").insert(record);
    if (error) {
      // eslint-disable-next-line no-console
      console.error("[audit] insert failed:", String(sanitizeValue(error.message)));
      await reportAuditFailure("admin audit insert failed", input);
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[audit] error:", e instanceof Error ? String(sanitizeValue(e.message)) : "unknown");
    await reportAuditFailure("admin audit write threw", input);
  }
}
