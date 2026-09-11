// The import half of the workspace export (lib/workspace-export.ts).
//
// Everything here is PURE: no client, no I/O, no clock. That is not tidiness.
// The operator confirms a preview and then the writes happen, and those two must
// be the same decision or the confirmation describes something that did not
// occur. Keeping the decision in a function with no side effects is what makes
// "the dry run cannot disagree with the apply" a property rather than a promise.
//
// The governing rule is that an import may never leave a workspace holding an
// agent with MORE reach than the file described. Everything that looks like a
// lenient default below is that rule applied.
import { validateAgentInput, validateFallbacks } from "@/lib/validate";
import { policyIsWellFormed } from "@/lib/scope";

// `agents.status` is an enum in 0001_init.sql:12. An unknown value must not
// fall through to the column default, which is 'active'.
const AGENT_STATUSES = new Set(["active", "suspended", "revoked"]);

// The check constraint on agent_owners.kind (0048 widened 0017's original).
// Pinned against the migration by tests/owner-portability.test.ts: a kind
// missing here does not fail loudly, it rejects a real binding on restore with
// "unknown_kind", which reads as a corrupt export rather than a stale list.
const OWNER_KINDS = new Set(["self_attested", "domain", "github", "idv"]);

/**
 * The ENVELOPE check: is this file shaped like an export at all, before any
 * question about what is in it.
 *
 * It exists because two reasonable leniencies met on a path neither anticipated
 * (T4-03). `planAgentImports` returns an empty plan for a non-array — right, for
 * a planner whose contract is "decide per entry" — and the CLI defaulted a
 * missing collection to `[]`. A truncated file therefore produced an empty plan,
 * `every()` over an empty plan is true, and the API answered `complete: true`
 * with zero creates, zero skips and zero rejections. That is a false completion
 * report on the one surface whose whole job is stopping a partial restore from
 * looking like a whole one.
 *
 * A MISSING `agents` collection is corruption. An EMPTY one is a workspace with
 * no agents, which is a real thing to export and a real thing to restore, so it
 * stays valid. Both halves are load-bearing.
 */
export type ImportEnvelope =
  | { ok: true; agents: unknown[]; ownership: unknown }
  | { ok: false; reason: "not_an_object" | "workspace_not_an_object" | "agents_missing" };

export function readImportEnvelope(body: unknown): ImportEnvelope {
  if (!isRecord(body)) return { ok: false, reason: "not_an_object" };
  // The route accepts the slim payload the CLI sends AND, unchanged, the
  // `workspace` block of a full export file. A `workspace` key that is present
  // but not an object is a damaged file, not an invitation to fall back to the
  // top level — falling back would read `agents` off the envelope of an export
  // that has none and call the result a complete restore.
  const source = "workspace" in body ? body.workspace : body;
  if (!isRecord(source)) return { ok: false, reason: "workspace_not_an_object" };
  if (!Array.isArray(source.agents)) return { ok: false, reason: "agents_missing" };
  return { ok: true, agents: source.agents, ownership: source.ownership ?? null };
}

export type AgentImportPlan =
  | { action: "create"; name: string; passportPubkey: string; row: Record<string, unknown> }
  | { action: "skip"; name: string; passportPubkey: string; reason: "already_exists" }
  | { action: "reject"; name: string; reason: string };

export type OwnershipImportPlan =
  | { action: "create"; row: Record<string, unknown> }
  | { action: "skip"; reason: "already_exists" }
  | { action: "reject"; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A display name for an entry that failed before its name could be trusted. */
function labelOf(entry: Record<string, unknown>): string {
  const name = entry.name;
  return typeof name === "string" && name.trim().length > 0 ? name.trim() : "(unnamed)";
}

// A workspace export is a complete configuration record. These fields are
// deliberately checked for PRESENCE before validation: `null` is a meaningful
// value for several of them (for example an intentionally unrestricted policy
// or an unlimited budget), while an absent key means a truncated or older file.
// Passing the latter through to a column default would make a restore look
// complete while silently changing the agent's authority.
const REQUIRED_AGENT_FIELDS = [
  "name",
  "passport_pubkey",
  "allowed_scopes",
  "budget_tokens",
  "budget_cents",
  "policy",
  "policy_shadow",
  "fallbacks",
  "status",
  "expires_at",
] as const;

/**
 * Decide, for each agent in an export file, whether it would be created,
 * skipped, or refused — without touching a database.
 *
 * `existingPubkeys` is the set of passport keys the tenant already holds.
 * The collision key is the passport, not the name: `agents` is unique on
 * passport_pubkey and has no constraint on name at all, so two agents may
 * legitimately share a name while the same passport may not be registered twice.
 */
export function planAgentImports(agents: unknown, existingPubkeys: Iterable<string>): AgentImportPlan[] {
  if (!Array.isArray(agents)) return [];
  const existing = new Set(existingPubkeys);
  const seen = new Set<string>();

  return agents.map((entry): AgentImportPlan => {
    if (!isRecord(entry)) return { action: "reject", name: "(unnamed)", reason: "not_an_object" };
    const name = labelOf(entry);

    for (const field of REQUIRED_AGENT_FIELDS) {
      if (!Object.hasOwn(entry, field)) {
        return { action: "reject", name, reason: `${field}_missing` };
      }
    }

    // Identity, scopes and budgets go through the same validator the dashboard
    // and the control API use, so an imported agent cannot be shaped in a way a
    // directly-created one could not.
    let base;
    try {
      base = validateAgentInput({
        name: entry.name,
        passportPubkey: entry.passport_pubkey,
        scopes: entry.allowed_scopes,
        budget_tokens: entry.budget_tokens,
        budget_cents: entry.budget_cents,
      });
    } catch (e) {
      return { action: "reject", name, reason: (e as Error).message };
    }

    // A passport repeated inside one file is a collision with itself: the first
    // occurrence would create the row and the second would hit the unique index.
    // Deciding it here keeps the preview's count honest.
    if (existing.has(base.passportPubkey)) {
      return { action: "skip", name: base.name, passportPubkey: base.passportPubkey, reason: "already_exists" };
    }
    if (seen.has(base.passportPubkey)) {
      return { action: "reject", name: base.name, reason: "duplicate_passport_in_file" };
    }

    // Policy is the reason this function rejects whole agents instead of
    // dropping fields. parsePolicy(null) returns an EMPTY policy — no deny
    // rules, no windows, no hourly cap (lib/scope.ts:269) — so a policy-bearing
    // agent imported without its policy is not "partially restored", it is
    // unrestricted. There is no honest way to write that row.
    if (entry.policy !== null && !policyIsWellFormed(entry.policy)) {
      return { action: "reject", name, reason: "policy_malformed" };
    }
    if (entry.policy_shadow !== null && !policyIsWellFormed(entry.policy_shadow)) {
      return { action: "reject", name, reason: "policy_shadow_malformed" };
    }

    // `[]` is a value here, not an absence: it is how failover is switched off
    // (lib/validate.ts:220-222). Writing `[]` for a list that failed validation
    // would be a different configuration that merely looks tidy.
    let fallbacks: unknown;
    try {
      fallbacks = validateFallbacks(entry.fallbacks);
    } catch (e) {
      return { action: "reject", name, reason: (e as Error).message };
    }

    // Restoring the recorded status matters in the restrictive direction: an
    // agent the file records as revoked must not come back active. An unknown
    // value is refused rather than defaulted, because the column default IS
    // 'active' and defaulting would resurrect it.
    let status: string;
    if (typeof entry.status !== "string" || !AGENT_STATUSES.has(entry.status)) {
      return { action: "reject", name, reason: "unknown_status" };
    }
    status = entry.status;

    let expiresAt: string | null;
    if (entry.expires_at !== null) {
      if (typeof entry.expires_at !== "string" || Number.isNaN(Date.parse(entry.expires_at))) {
        return { action: "reject", name, reason: "invalid_expires_at" };
      }
      expiresAt = entry.expires_at;
    } else {
      expiresAt = null;
    }

    // Built field by field rather than by spreading `entry`, so a column added
    // to the export later cannot become importable by accident. Absent on
    // purpose, each for its own reason:
    //   id, created_at   the new row gets its own; a restored id would claim to
    //                    be the same object in a different database
    //   user_id          supplied by the ROUTE from the authenticated caller. A
    //                    planner that emitted it would let a file name a tenant
    //   published,       publishing is an outward-facing act. An import must not
    //   public_label     put agents on a public page because a file said so
    //                    (0032_user_profile_grants.sql:50-53 revokes these from
    //                    the browser role for the same reason)
    const row: Record<string, unknown> = {
      name: base.name,
      passport_pubkey: base.passportPubkey,
      allowed_scopes: base.scopes,
      budget_tokens: base.budget_tokens,
      budget_cents: base.budget_cents,
      // All config fields are emitted explicitly. A database default is not a
      // restore value, even where today's default happens to agree with null.
      policy: entry.policy,
      policy_shadow: entry.policy_shadow,
      fallbacks,
      status,
      expires_at: expiresAt,
    };

    seen.add(base.passportPubkey);
    return { action: "create", name: base.name, passportPubkey: base.passportPubkey, row };
  });
}

/**
 * Decide whether the file's ownership declaration would be restored.
 *
 * Only the CLAIM travels — `kind` and `subject`. `tier` records what was
 * actually proven and `verified_at` when, so a file able to set either would
 * make the verified badge self-declared, which is the exact failure
 * 0017_agent_owners.sql warns about ("never derive a verified label from
 * kind"). An imported declaration lands unverified and is re-proven normally.
 *
 * The company line does not travel either, for a different reason: it is not a
 * claim the exporter made, it is the answer a register gave US when we asked.
 * Carrying it across would import a lookup nobody performed on this instance,
 * and it may have lapsed since. It is one click to look up again.
 */
export function planOwnershipImport(ownership: unknown, alreadyHasOwner: boolean): OwnershipImportPlan {
  if (!isRecord(ownership)) return { action: "reject", reason: "not_an_object" };
  // user_id is the primary key of agent_owners — one row per tenant — so an
  // existing row is never overwritten by a file.
  if (alreadyHasOwner) return { action: "skip", reason: "already_exists" };
  const { kind, subject } = ownership;
  if (typeof kind !== "string" || !OWNER_KINDS.has(kind)) return { action: "reject", reason: "unknown_kind" };
  if (typeof subject !== "string" || subject.trim().length === 0 || subject.length > 255) {
    return { action: "reject", reason: "invalid_subject" };
  }
  return { action: "create", row: { kind, subject: subject.trim() } };
}

/** Counts for the response and the CLI preview, from the plan itself. */
export function summarizePlan(plan: AgentImportPlan[]): {
  create: number;
  skip: number;
  reject: number;
} {
  return {
    create: plan.filter((p) => p.action === "create").length,
    skip: plan.filter((p) => p.action === "skip").length,
    reject: plan.filter((p) => p.action === "reject").length,
  };
}
