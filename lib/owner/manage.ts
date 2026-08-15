// Owner-binding mutations. Server-side only, service_role, tenant-scoped.
//
// Migration 0017 grants the client SELECT and nothing else: every write runs
// through here so the verification ladder cannot be skipped. The rule that
// makes the tier worth anything is enforced in one place —
//
//   A CALLER MAY NEVER SET `tier` OR `verified_at`.
//
// They say what they claim (`kind`, `subject`) and whether to publish it. What
// was actually PROVEN is decided by this module, from evidence it gathered
// itself. tests/owner-manage.test.ts pins that.
import type { SupabaseClient } from "@supabase/supabase-js";

import { purgeOwnerCache } from "../state/redis";
import { isVerifiableDomain, newVerificationToken, verifyDomainControl } from "./domain";
import type { DomainFailure } from "./domain";

type OwnerDatabase = Pick<SupabaseClient, "from">;

export type OwnerKind = "self_attested" | "domain";

export interface OwnerRecord {
  kind: string;
  subject: string;
  tier: string;
  published: boolean;
  verification_token: string | null;
  verified_at: string | null;
  last_checked_at: string | null;
  failure_count: number;
}

export type OwnerResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; code: string };

/** How many consecutive re-check failures demote a verified tier. */
export const OWNER_FAILURE_LIMIT = 3;

const MAX_SUBJECT_LENGTH = 200;

const PUBLIC_COLS =
  "kind, subject, tier, published, verification_token, verified_at, last_checked_at, failure_count";

/**
 * Drop the cached owner after a write. Best-effort, exactly like the read side.
 *
 * The database write is the durable thing; the cache purge is not. Letting a
 * Redis blip throw here would return 500 for a mutation that actually SUCCEEDED
 * — the caller would retry a change already applied, and the only real
 * consequence of the miss is a stale owner claim on receipts for up to the 300s
 * TTL. Report success for the thing that succeeded.
 */
async function dropOwnerCache(userId: string): Promise<void> {
  try {
    await purgeOwnerCache(userId);
  } catch {
    // Falls back to the TTL.
  }
}

export async function readOwner(
  db: OwnerDatabase,
  userId: string
): Promise<OwnerResult<OwnerRecord | null>> {
  const { data, error } = await db
    .from("agent_owners")
    .select(PUBLIC_COLS)
    .eq("user_id", userId) // tenant boundary — service_role bypasses RLS
    .maybeSingle();

  if (error) return { ok: false, status: 500, code: "query_failed" };
  return { ok: true, data: (data as OwnerRecord) ?? null };
}

/**
 * Declare an owner. Always lands at tier `unverified`.
 *
 * Even for `kind: "domain"` — claiming a domain and proving control of it are
 * two different acts, and only the second one moves the tier. This function
 * hands back a token to publish; verifyOwnerDomain is what checks it.
 */
export async function setOwner(
  db: OwnerDatabase,
  userId: string,
  input: Record<string, unknown>
): Promise<OwnerResult<OwnerRecord>> {
  const kind = input.kind === "domain" ? "domain" : input.kind === "self_attested" ? "self_attested" : null;
  if (!kind) return { ok: false, status: 400, code: "invalid_kind" };

  const subject = typeof input.subject === "string" ? input.subject.trim() : "";
  if (!subject || subject.length > MAX_SUBJECT_LENGTH) {
    return { ok: false, status: 400, code: "invalid_subject" };
  }
  // Refuse a domain we would never be able to verify, at declaration time
  // rather than leaving the owner to discover it at verification time.
  if (kind === "domain" && !isVerifiableDomain(subject)) {
    return { ok: false, status: 400, code: "invalid_domain" };
  }

  const row = {
    user_id: userId,
    kind,
    subject: kind === "domain" ? subject.toLowerCase() : subject,
    // Never taken from the caller. Changing the claim always resets the proof:
    // an owner who re-points a binding at a new domain must prove that one too.
    tier: "unverified",
    verified_at: null,
    failure_count: 0,
    verification_token: kind === "domain" ? newVerificationToken() : null,
    published: input.published === true,
  };

  const { data, error } = await db
    .from("agent_owners")
    .upsert(row, { onConflict: "user_id" })
    .select(PUBLIC_COLS)
    .maybeSingle();

  if (error || !data) return { ok: false, status: 500, code: "write_failed" };
  await dropOwnerCache(userId);
  return { ok: true, data: data as OwnerRecord };
}

/** Publish or unpublish an existing binding. The only field a caller may toggle freely. */
export async function setOwnerPublished(
  db: OwnerDatabase,
  userId: string,
  published: boolean
): Promise<OwnerResult<OwnerRecord>> {
  const { data, error } = await db
    .from("agent_owners")
    .update({ published })
    .eq("user_id", userId)
    .select(PUBLIC_COLS)
    .maybeSingle();

  if (error) return { ok: false, status: 500, code: "write_failed" };
  if (!data) return { ok: false, status: 404, code: "no_owner" };
  await dropOwnerCache(userId);
  return { ok: true, data: data as OwnerRecord };
}

/**
 * Run the domain check and record the outcome.
 *
 * On success the tier becomes `domain` and the date is stamped. On failure the
 * tier is only demoted after OWNER_FAILURE_LIMIT consecutive failures, and even
 * then the SUBJECT and the original verified_at are kept — degrade the label,
 * never silently delete someone's binding because their web server had a bad day.
 *
 * Returns 409 `owner_changed` if the binding was re-declared while the check was
 * in flight. Nothing is written in that case: the result belongs to a claim that
 * no longer exists, and applying it to its replacement is how an unproven domain
 * gets a proven label. See the note at the update below.
 */
export async function verifyOwnerDomain(
  db: OwnerDatabase,
  userId: string,
  options: { fetch?: typeof fetch; now?: () => Date } = {}
): Promise<OwnerResult<{ owner: OwnerRecord; verified: boolean; reason?: DomainFailure }>> {
  const current = await readOwner(db, userId);
  if (!current.ok) return current;
  const owner = current.data;
  if (!owner) return { ok: false, status: 404, code: "no_owner" };
  if (owner.kind !== "domain") return { ok: false, status: 400, code: "not_a_domain_owner" };
  if (!owner.verification_token) return { ok: false, status: 409, code: "no_verification_token" };

  const now = (options.now ?? (() => new Date()))().toISOString();
  const result = await verifyDomainControl(owner.subject, owner.verification_token, {
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  const patch = result.ok
    ? { tier: "domain", verified_at: now, last_checked_at: now, failure_count: 0 }
    : nextFailureState(owner, now);

  // Compare-and-set on the claim that was actually checked.
  //
  // Everything above this line happened BEFORE an HTTPS fetch of a host the
  // owner named — and the owner of that host decides how long it takes. Hold
  // the response open and the tenant has an arbitrarily long window in which to
  // re-declare, which resets the tier and issues a new token. `user_id` alone
  // then lands this patch on whatever row is there now: a valid proof for
  // acme.com promoting a brand-new claim on some other domain to `tier:
  // "domain"`, which /verify and every signed receipt then assert to strangers.
  // The UI's pending state is not the control — a Server Action is addressable
  // over HTTP by its id, extractable from the built client chunks.
  //
  // So the write states the row it believes it is patching. `subject` and
  // `verification_token` are both required: re-declaring the SAME domain keeps
  // the subject and rotates only the token (setOwner above), and that re-declare
  // is precisely the reset a stale success would undo. No new column, no
  // migration — the token already IS a per-declaration nonce.
  //
  // Both branches are conditioned. A stale FAILURE is the same defect wearing
  // the other face: it would spend one of three strikes against a binding
  // nothing has checked yet, and three of them demote it.
  const { data, error } = await db
    .from("agent_owners")
    .update(patch)
    .eq("user_id", userId) // tenant boundary — service_role bypasses RLS
    .eq("kind", owner.kind)
    .eq("subject", owner.subject)
    .eq("verification_token", owner.verification_token)
    .select(PUBLIC_COLS)
    .maybeSingle();

  // Order matters: a database that is down is not a row that moved. Reporting
  // one as the other would tell an operator their binding changed when it did
  // not, and would bury a real outage under a reassuring message.
  if (error) return { ok: false, status: 500, code: "write_failed" };
  // No match, no error: the row is no longer the row that was proven. Say so
  // and change nothing. The evidence gathered was real — it was just about a
  // claim this tenant has since withdrawn, and re-checking is one click.
  if (!data) return { ok: false, status: 409, code: "owner_changed" };
  await dropOwnerCache(userId);

  return {
    ok: true,
    data: {
      owner: data as OwnerRecord,
      verified: result.ok,
      ...(result.ok ? {} : { reason: result.reason }),
    },
  };
}

function nextFailureState(owner: OwnerRecord, now: string) {
  const failures = owner.failure_count + 1;
  return {
    failure_count: failures,
    last_checked_at: now,
    // One bad check is a blip; three in a row is a claim that no longer holds.
    // verified_at is deliberately NOT cleared — the page can then say when the
    // binding was last genuinely confirmed, which is more useful than silence.
    ...(failures >= OWNER_FAILURE_LIMIT ? { tier: "unverified" } : {}),
  };
}
