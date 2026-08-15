// Which providers a tenant holds a credential for.
//
// Modelled on lib/owner/current.ts: Redis cache, tenant-scoped select on a miss,
// and a failure that degrades rather than escalates. Called only from the proxy's
// credit-exhaustion branch — a path that has already decided to return an error —
// so it never touches an approved call.
//
// **Returns [] on ANY failure.** An empty alternatives list is honest; a blipped
// cache or database read must never turn a well-formed 402 into a 500. The same
// rule the receipt's owner claim follows: degrade the detail, never the answer.
//
// This reads provider ids and nothing else — no label, no credential id, no Vault
// secret reference. It is not, and must not become, a path to credential material.
import { waitUntil } from "@vercel/functions";
import type { SupabaseClient } from "@supabase/supabase-js";

import { getCachedProviderKeys, setCachedProviderKeys } from "../state/redis";

const PROVIDER_KEYS_CACHE_TTL_S = 300;

type ProviderKeysDatabase = Pick<SupabaseClient, "from">;

function toProviders(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === "string"))];
}

export async function readProvidersWithKeys(
  db: ProviderKeysDatabase,
  userId: string
): Promise<string[]> {
  try {
    const cached = await getCachedProviderKeys(userId);
    if (cached !== null) {
      try {
        return toProviders(JSON.parse(cached));
      } catch {
        return [];
      }
    }
  } catch {
    // A cache read failure falls through to the tenant-scoped source of truth.
  }

  try {
    const { data, error } = await db
      .from("provider_credentials")
      .select("provider")
      .eq("user_id", userId); // tenant boundary — service_role bypasses RLS

    if (error) return [];

    const providers = toProviders(
      (data ?? []).map((row: Record<string, unknown>) => row.provider)
    );
    // Cache the empty result too: a tenant with one provider is the common case
    // and should not cost a database read on every exhausted call.
    waitUntil(
      setCachedProviderKeys(userId, JSON.stringify(providers), PROVIDER_KEYS_CACHE_TTL_S)
    );
    return providers;
  } catch {
    return [];
  }
}
