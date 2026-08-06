// Pure helpers behind the scope editor. Kept out of the component for the same
// reason lib/verify/receipt-view.ts is: this is the part with edge cases worth
// testing, and a test should not have to import a client component (and with it
// a "use server" module, next/cache, and the Supabase client) to reach it.

export interface ScopeRow {
  provider: string;
  models: string[];
}

/**
 * Coerce a raw `allowed_scopes` column into rows the editor can hold.
 * The column is jsonb, so it can contain whatever a past migration or a hand
 * edit left there — malformed entries are dropped, never thrown on.
 */
export function toScopeRows(value: unknown): ScopeRow[] {
  if (!Array.isArray(value)) return [];
  const rows: ScopeRow[] = [];
  for (const candidate of value) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const entry = candidate as { provider?: unknown; models?: unknown };
    if (typeof entry.provider !== "string" || !entry.provider) continue;
    const models = Array.isArray(entry.models)
      ? entry.models.filter((m): m is string => typeof m === "string" && m.length > 0)
      : [];
    rows.push({ provider: entry.provider, models });
  }
  return rows;
}

/** Comma-separated is the same spelling used when a passport is issued. */
export function parseModels(raw: string): string[] {
  return raw
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
}

/**
 * Render a visa TTL as words. Never hardcode the duration at a call site:
 * VISA_TTL_SECONDS is tunable within [300, 900], so "5 minutes" is wrong on a
 * deployment that raised it.
 */
export function describeDelay(ttlSeconds: number): string {
  const minutes = Math.round(ttlSeconds / 60);
  if (ttlSeconds % 60 === 0 && minutes >= 1) {
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  return `${ttlSeconds} seconds`;
}
