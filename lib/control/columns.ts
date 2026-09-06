// Column selections shared across control-plane endpoints. Kept out of route
// files (which may only export the HTTP verbs + Next route config).

// Agent fields safe to return over the API (no secrets; passport_pubkey is public).
//
// `fallbacks` is deliberately ABSENT even though PATCH accepts it — the same
// write-without-readback asymmetry `policy` already has. Naming a column here
// makes its migration a hard prerequisite for the whole control plane: PostgREST
// errors the select, so a deployment that has not applied 0018 loses
// GET /agents *and* GET /agents/{id} — the list endpoint, not one page. No test
// catches that, because the test schema is not the deployed schema. Add it once
// 0018 has been applied everywhere that matters.
export const AGENT_COLS =
  "id, name, passport_pubkey, status, budget_tokens, budget_cents, spent_tokens, spent_microcents, allowed_scopes, created_at, last_seen_at";

// Gateway-call log fields (cost in micro-cents).
//
// `enforced_tokens` / `enforced_microcents` are here (migration 0055) for the
// same reason the dashboard drawer grew them: on a `usage_unknown` row the
// observed pair is 0/null because no usage report ever arrived, NOT because the
// call was free — and the enforced pair is the only figure on the row that
// actually moved against the cap. Omitting them from the endpoint people build
// their own reconciliation against would hand that consumer a confirmed-looking
// zero for a call that consumed budget, which is precisely the defect this
// migration exists to remove. They are null on every other status.
export const LOG_COLS =
  "id, agent_id, passport_id, jti, provider, model, input_tokens, output_tokens, cost_microcents, enforced_tokens, enforced_microcents, status, latency_ms, created_at";

// A single call plus its signed receipt. Deliberately NOT folded into LOG_COLS:
// a receipt is ~600-900 bytes of JWS, and adding it to the list endpoint would
// bloat every page of results for the one caller in a hundred who wants a proof.
// Fetched one at a time, by id, from /api/control/v1/receipts/{id}.
export const RECEIPT_COLS =
  "id, agent_id, passport_id, jti, auth_method, agent_access_key_id, credential_use_id, provider, model, input_tokens, output_tokens, cost_microcents, enforced_tokens, enforced_microcents, status, latency_ms, created_at, receipt";

// Admin-action audit fields.
export const AUDIT_COLS = "id, action, target_type, target_id, metadata, created_at";

// A signed spend statement, WITHOUT its JWS. Same split RECEIPT_COLS makes
// against LOG_COLS and for the same reason: the artifact is ~600 bytes, and
// putting one on every row of the chain bloats every page for the one caller in
// a hundred who wants a proof.
//
// `row_count`, `unpriced_count` and `unknown_pricing_count` are NOT optional
// extras. They are the statement's own account of what it does not know — rows
// it could not cover, calls nobody could price, calls whose pricing was never
// recorded — and a surface that returned only `covered_count` and
// `cost_microcents` would quietly convert "we cannot say" into "zero".
export const STATEMENT_COLS =
  "seq, period_start, period_end, covered_count, row_count, cost_microcents, unpriced_count, unknown_pricing_count, root, prev_digest, created_at";

// One statement, fetched by seq, with the signed artifact attached.
export const STATEMENT_DETAIL_COLS = `${STATEMENT_COLS}, statement`;
