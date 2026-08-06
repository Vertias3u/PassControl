// The owner claim that rides on a signed receipt.
//
// Modelled on lib/state/policy.ts: Redis cache, tenant-scoped select on a miss,
// and a failure that degrades rather than escalates. Called from inside the
// proxy's reconcile(), i.e. inside waitUntil — it never touches the hot path.
//
// One switch, one meaning: a receipt carries the owner exactly when the public
// /verify page would show it. Both read `published`. An owner who has not chosen
// to publish is not named in an artifact that gets handed to third parties.
import { waitUntil } from "@vercel/functions";
import type { SupabaseClient } from "@supabase/supabase-js";

import { getCachedOwner, setCachedOwner } from "../state/redis";
import type { OwnerClaim } from "../receipt";

const OWNER_CACHE_TTL_S = 300;

type OwnerDatabase = Pick<SupabaseClient, "from">;

function toClaim(row: Record<string, unknown> | null): OwnerClaim | null {
  if (!row) return null;
  const subject = typeof row.subject === "string" ? row.subject.trim() : "";
  if (!subject) return null;

  const tier = row.tier === "domain" || row.tier === "idv" ? row.tier : "unverified";
  return {
    kind: typeof row.kind === "string" ? row.kind : "self_attested",
    sub: subject,
    tier,
    // Same rule the public page follows: a tier that proves nothing has no
    // verification date to show, or the date reads as evidence.
    vat: tier === "unverified" || typeof row.verified_at !== "string" ? null : row.verified_at,
  };
}

/**
 * Read the published owner for a tenant, or null.
 *
 * Returns null on ANY failure — cache down, database down, no row. A receipt
 * with no owner claim is honest and still verifiable; a receipt that failed to
 * sign because the owner lookup blipped is a lost audit record. Degrade the
 * claim, never the artifact.
 */
export async function readCurrentOwner(
  db: OwnerDatabase,
  userId: string
): Promise<OwnerClaim | null> {
  try {
    const cached = await getCachedOwner(userId);
    if (cached !== null) {
      try {
        return toClaim(JSON.parse(cached));
      } catch {
        return null;
      }
    }
  } catch {
    // A cache read failure falls through to the tenant-scoped source of truth.
  }

  try {
    const { data, error } = await db
      .from("agent_owners")
      .select("kind, subject, tier, verified_at")
      .eq("user_id", userId) // tenant boundary — service_role bypasses RLS
      .eq("published", true)
      .maybeSingle();

    if (error) return null;

    // Cache the miss too. A tenant with no owner is the common case, and it
    // should not cost a database read on every single proxied call.
    waitUntil(setCachedOwner(userId, JSON.stringify(data ?? null), OWNER_CACHE_TTL_S));
    return toClaim((data as Record<string, unknown>) ?? null);
  } catch {
    return null;
  }
}
