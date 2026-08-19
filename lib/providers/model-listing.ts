/**
 * ── Narrowing a model listing to the visa's scope ───────────────────────────
 *
 * `GET /v1/models` forwards to the provider and comes back with every model the
 * PROVIDER KEY can reach. That is not the set the VISA permits — the key is the
 * tenant's whole account, the visa is one agent's capability — so an SDK's model
 * picker offered choices guaranteed to 403 on their first real use. This narrows
 * the provider's own response to what the agent may actually call, which makes
 * the gateway visibly be the boundary it already enforces.
 *
 * ── What this is NOT ────────────────────────────────────────────────────────
 *
 * It is not enforcement. Scope is enforced at the gate before a call is
 * forwarded, and nothing here can grant capability. So when the response shape
 * is not one this recognises, it passes through **untouched** rather than
 * guessing: a model listing was never a secret, and a filter that mangles an
 * unfamiliar provider response would be a worse bug than the one it fixes.
 *
 * It is also not an invention. Nothing is added, no field is synthesised, and an
 * entry that survives is returned exactly as the provider sent it. That line
 * matters: PassControl declines to answer model-metadata questions out of its
 * own head (there is no context-window data here to be right or wrong about) —
 * it only ever removes rows the visa cannot use.
 *
 * ── Why only the index, never the retrieve ──────────────────────────────────
 *
 * Discovery is scoped; an explicit lookup is not. `GET /v1/models` is the agent
 * asking "what may I use?", and the honest answer is bounded by the visa.
 * `GET /v1/models/{id}` names a model the caller already knows about, so hiding
 * it reveals nothing and only replaces a straight answer with a confusing one.
 * The caller still cannot *call* an out-of-scope model — the gate sees to that.
 */
import { scopeAllows } from "../scope";
import type { ScopeEntry } from "../auth/visa";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The id a client would use to call this entry, or null if it has none. */
function entryId(entry: unknown): string | null {
  if (!isRecord(entry)) return null;
  return typeof entry.id === "string" && entry.id ? entry.id : null;
}

/**
 * Narrow a model-listing response to the models `scopes` permits.
 *
 * Returns the input unchanged (by reference) whenever it cannot be narrowed
 * confidently — an unrecognised body, a non-array `data`, or a visa whose scope
 * was never supplied. An absent scope means "not known yet", not "nothing
 * permitted"; filtering to empty on a missing input would invent a restriction
 * the operator never configured.
 */
export function filterModelListingToScope(
  body: unknown,
  provider: string,
  scopes: readonly ScopeEntry[] | undefined
): unknown {
  if (!scopes) return body;
  if (!isRecord(body)) return body;
  const data = body.data;
  if (!Array.isArray(data)) return body;

  const kept = data.filter((entry) => {
    const id = entryId(entry);
    // An entry a client cannot name cannot be selected, and must not survive a
    // filter whose whole job is identification.
    if (id === null) return false;
    return scopeAllows(scopes as ScopeEntry[], provider, id);
  });

  const out: Record<string, unknown> = { ...body, data: kept };

  // Cursors that name rows no longer in `data` would send a paging client to a
  // position it cannot see. Only rewritten when the provider sent them at all —
  // adding a field the provider omitted would be inventing shape.
  if ("first_id" in body) out.first_id = entryId(kept[0]);
  if ("last_id" in body) out.last_id = entryId(kept[kept.length - 1]);
  // `has_more` is deliberately untouched: it is the provider's statement about
  // its own pages, and we have no basis to restate it.

  return out;
}
