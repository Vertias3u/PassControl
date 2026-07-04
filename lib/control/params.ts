// Shared query-param parsing for control-plane endpoints.

/** Parse a `?limit=` value into a bounded integer (default 50, hard cap 100).
 *  Non-numeric / out-of-range input falls back to the default or the bounds. */
export function clampLimit(raw: string | null, def = 50, max = 100): number {
  const n = Number(raw ?? def);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.floor(n), 1), max);
}
