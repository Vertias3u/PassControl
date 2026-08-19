/**
 * ── Operationally meaningful calls vs SDK housekeeping ──────────────────────
 *
 * Every call the gateway handles is preserved, forever, exactly as it happened —
 * that is the product. But not every preserved row is *agent activity*. An SDK
 * pointed at PassControl lists models on startup; an MCP client re-probes on
 * reconnect. Those rows are real, governed, and worth keeping, and they are also
 * protocol chatter. Counting them as calls the agent chose to make inflates the
 * fleet's activity, and — the sharpest instance — can fire the onboarding
 * "first call" milestone on a handshake nobody made.
 *
 * So: preserve everything, present honestly. This module draws that line.
 *
 * ── Why this is DERIVED and not a column ───────────────────────────────────
 *
 * Two reasons, and the second is the one that decides it.
 *
 * FIRST, a stored label is a stored *judgment*, and this file's whole argument is
 * that judgments belong to the presentation layer. `agent_logs` records facts:
 * which endpoint, which model, which verdict, which identity. The receipt signs
 * those facts. If the rule below turns out to be wrong or too narrow, a derived
 * rule is a one-line fix that reclassifies all of history correctly; a stored
 * column is a permanent record of the old opinion.
 *
 * SECOND — and this is decisive — migration 0006 rejects UPDATE on `agent_logs`
 * at depth 1 *even for service_role*. A new column could therefore never be
 * backfilled. The live database holds the real call history, so a stored
 * classification would show every row written before today as unclassified,
 * forever, with no way to repair it. Deriving classifies all of history for free
 * and needs no migration on either Supabase project.
 *
 * ── The rule, and what it rests on ─────────────────────────────────────────
 *
 * A row is housekeeping when the gateway ADMITTED it (`status === "ok"`) and it
 * carried no model. On the proxy path, `model` comes from the request body, and
 * `lib/gate.ts` skips the per-model scope check for exactly one thing: a
 * model-listing request. Any *other* model-less call fails `scopeRuleMatch` and
 * is written with `blocked_scope`, not `ok`. The demo path stamps `demo-1`
 * rather than leaving the field empty. So `ok` + model-less isolates precisely
 * the successful capability probes.
 *
 * That assumption is load-bearing and is pinned by a test: it holds only while
 * model-listing is the sole model-free entry in `ENDPOINT_ALLOWLIST`. Admitting
 * something like `POST /v1/messages/count_tokens` would write model-less `ok`
 * rows too, and `tests/call-class.test.ts` fails the moment the allowlist grows
 * so that widening is a decision rather than a side effect.
 *
 * ── The invariant ──────────────────────────────────────────────────────────
 *
 * **This classification is presentation-only.** It must never reach the kill
 * switch, scope, the budget reserve, key resolution, or the receipt payload. A
 * label that can route a call around the atomic Lua reserve is not a label, it
 * is a budget bypass. `tests/call-class.test.ts` asserts that no file in the
 * check order imports this module.
 */

/** A call the agent's operator would recognise as work it asked for. */
export type CallClass = "inference" | "housekeeping";

/**
 * Why a row was filed as housekeeping — named, never a vague bucket.
 *
 * The UI says "capability probe", not "chatter", because an operator reading a
 * hidden row needs to know exactly what was hidden. Same discipline as
 * `DEPARTURE_VERDICT` in lib/departures.ts: a call shown as the wrong kind of
 * thing sends someone looking in the wrong place.
 */
export const CALL_CLASS_REASONS = ["model_listing"] as const;
export type CallClassReason = (typeof CALL_CLASS_REASONS)[number];

export interface CallClassification {
  klass: CallClass;
  /** Null for inference: there is nothing to explain about a normal call. */
  reason: CallClassReason | null;
}

/** The columns the rule reads. Deliberately narrow — anything wider invites a
 *  future rule that depends on a field the realtime WAL payload may not carry. */
export interface ClassifiableCall {
  /** Undefined accepted, and it fails toward inference: a row whose status this
   *  caller does not carry is not one we may quietly file as chatter. */
  status?: string | null;
  model?: string | null;
}

const INFERENCE: CallClassification = { klass: "inference", reason: null };
const MODEL_LISTING: CallClassification = { klass: "housekeeping", reason: "model_listing" };

/**
 * Classify one recorded call.
 *
 * Fails toward "inference" on purpose. An unrecognised status, a null field, a
 * row shape from a future migration — anything this rule cannot positively
 * identify as a capability probe stays visible as agent activity. Wrongly
 * showing a probe costs a slightly noisy count; wrongly hiding a refusal costs
 * an operator the one row they needed.
 */
export function classifyCall(row: ClassifiableCall): CallClassification {
  if (row.status !== "ok") return INFERENCE;
  // An ABSENT `model` key is not an empty model — it is a row we cannot judge.
  //
  // `DeparturesBoard` casts realtime payloads (`payload.new as DepartureRow`)
  // straight from the WAL with no normalization, so a partial payload can arrive
  // with the key missing entirely. Since housekeeping is hidden by default, a
  // guess of "probe" would silently hide a real inference call — the one way
  // this feature could lose an operator a row they needed. Absent means unknown,
  // and unknown stays visible; only a key that is present and empty is a probe.
  if (!("model" in row)) return INFERENCE;
  if (typeof row.model === "string" && row.model.trim() !== "") return INFERENCE;
  return MODEL_LISTING;
}

export function isHousekeeping(row: ClassifiableCall): boolean {
  return classifyCall(row).klass === "housekeeping";
}

export function isInference(row: ClassifiableCall): boolean {
  return classifyCall(row).klass === "inference";
}

/** Human label for a housekeeping row, for the one place that renders it. */
export function housekeepingLabel(reason: CallClassReason): string {
  switch (reason) {
    case "model_listing":
      return "Capability probe";
  }
}

/**
 * Split a list once, rather than filtering it twice at three call sites.
 * Order is preserved within each side.
 */
export function partitionByClass<T extends ClassifiableCall>(
  rows: readonly T[]
): { inference: T[]; housekeeping: T[] } {
  const inference: T[] = [];
  const housekeeping: T[] = [];
  for (const row of rows) (isHousekeeping(row) ? housekeeping : inference).push(row);
  return { inference, housekeeping };
}
