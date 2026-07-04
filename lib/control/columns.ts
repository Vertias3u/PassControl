// Column selections shared across control-plane endpoints. Kept out of route
// files (which may only export the HTTP verbs + Next route config).

// Agent fields safe to return over the API (no secrets; passport_pubkey is public).
export const AGENT_COLS =
  "id, name, passport_pubkey, status, budget_tokens, budget_cents, spent_tokens, spent_microcents, allowed_scopes, created_at, last_seen_at";

// Gateway-call log fields (cost in micro-cents).
export const LOG_COLS =
  "id, agent_id, passport_id, jti, provider, model, input_tokens, output_tokens, cost_microcents, status, latency_ms, created_at";

// Admin-action audit fields.
export const AUDIT_COLS = "id, action, target_type, target_id, metadata, created_at";
