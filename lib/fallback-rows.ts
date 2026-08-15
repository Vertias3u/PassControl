// Pure helpers behind the fallback editor, kept out of the component for the
// same reason lib/scope-rows.ts is: this is the part with edge cases worth
// testing, and a test should not have to import a client component to reach it.
import { MAX_FALLBACKS } from "./providers/fallbacks";

export interface FallbackRow {
  provider: string;
  model: string;
}

/**
 * Coerce a raw `fallbacks` column into rows the editor can hold.
 *
 * Deliberately MORE forgiving than parseFallbacks, and the difference is the
 * point. parseFallbacks is the gateway's boundary against untrusted jsonb: one
 * bad entry there rejects the whole list, because half-honoured configuration is
 * worse than none. This one is for DISPLAY — an operator looking at a list that
 * a direct PATCH left malformed is better served by seeing the good entries and
 * the gap than by an empty editor that silently overwrites everything on save.
 *
 * It never returns more rows than the gateway would honour, so the editor cannot
 * present a list it is unable to save.
 */
export function toFallbackRows(value: unknown): FallbackRow[] {
  if (!Array.isArray(value)) return [];
  const rows: FallbackRow[] = [];
  for (const candidate of value) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const entry = candidate as { provider?: unknown; model?: unknown };
    if (typeof entry.provider !== "string" || !entry.provider.trim()) continue;
    if (typeof entry.model !== "string" || !entry.model.trim()) continue;
    rows.push({ provider: entry.provider.trim(), model: entry.model.trim() });
    if (rows.length === MAX_FALLBACKS) break;
  }
  return rows;
}

/**
 * Which of these fallbacks the agent's current scope does not cover.
 *
 * Every attempt is re-checked against the scope carried in the visa, so a
 * fallback the agent may not call is configuration that does nothing — and does
 * nothing SILENTLY, which is the failure mode worth a warning. Matching is
 * deliberately approximate on the model (prefix wildcards only) because the
 * authoritative check is scopeAllows at call time; this is a warning, not a
 * gate, and over-warning is cheaper here than under-warning.
 */
export function outOfScope(
  rows: readonly FallbackRow[],
  scopes: readonly { provider: string; models: string[] }[]
): FallbackRow[] {
  return rows.filter((row) => {
    const scope = scopes.find((s) => s.provider === row.provider);
    if (!scope) return true;
    return !scope.models.some((pattern) =>
      pattern.endsWith("*") ? row.model.startsWith(pattern.slice(0, -1)) : pattern === row.model
    );
  });
}
