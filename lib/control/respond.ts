// Shared response shape for the control-plane API. Every response carries an
// X-Request-Id; errors are { error: { code, message, request_id } } with a safe,
// generic message (no internals leak).

export function newRequestId(): string {
  return crypto.randomUUID();
}

const MESSAGES: Record<string, string> = {
  missing_api_key: "Provide an API key as 'Authorization: Bearer <key>'.",
  invalid_api_key: "The API key is invalid or has been revoked.",
  insufficient_scope: "This operation requires a key with 'write' scope.",
  rate_limited: "Too many requests. Slow down and retry after the indicated delay.",
  invalid_id: "The resource id is malformed.",
  invalid_request: "The request body is invalid.",
  empty_update: "No updatable fields were provided.",
  invalid_idempotency_key: "The Idempotency-Key header is missing or malformed.",
  request_in_progress: "A request with this Idempotency-Key is still being processed.",
  agent_exists: "That passport is already registered.",
  agent_not_active: "Only an active passport can be rotated.",
  same_key: "That is already this agent's passport. Generate a new keypair.",
  rotation_in_progress:
    "A previous key is still inside its grace window. Wait for it to close, or end it first.",
  rotation_conflict: "This passport changed while the rotation was in flight. Read it and retry.",
  unsupported_media_type: "Request body must be application/json.",
  payload_too_large: "Request body is too large.",
  not_found: "Resource not found.",
  query_failed: "The request could not be completed. Please try again.",
  export_unavailable: "The workspace export could not be built. Please try again.",
  auth_lookup_failed: "The request could not be completed. Please try again.",
  system_forbidden: "This API key is not authorized to read system health.",
  system_totp_required: "The account owning this API key must verify an authenticator app before reading system health.",
  system_not_configured: "This instance names no system-health operators, so it authorizes no API key.",
  system_allowlist_invalid: "This instance's system-health operator list is malformed and authorizes no API key.",
  internal_error: "Something went wrong. Please try again.",
};

export function errorResponse(
  status: number,
  code: string,
  requestId: string,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(
    JSON.stringify({ error: { code, message: MESSAGES[code] ?? "Request failed.", request_id: requestId } }),
    {
      status,
      headers: { "content-type": "application/json", "x-request-id": requestId, ...extraHeaders },
    }
  );
}

export function jsonResponse(body: unknown, requestId: string, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-request-id": requestId },
  });
}
