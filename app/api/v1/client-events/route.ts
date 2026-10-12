// POST /api/v1/client-events — model calls a client REPORTED (subscription mode,
// Phase 1b; migration 0084).
//
// A Claude Pro/Max session talks to Anthropic directly: Anthropic's terms forbid
// anything that intermediates that login, so the gateway never sees its calls. Claude
// Code's own telemetry reports each one to the local sidecar, which uploads them here
// in batches, as the agent.
//
// The agent plane, not a developer API, through the same door as /self: verify,
// sender proof, kill and suspend, then its own rate limit (`events:<agent>`), so
// uploads never use up the allowance /self or model calls share. The tenant and agent
// come from the credential only; no id is ever read from the body. A stopped agent
// gains no write path: what is reported while it is stopped is not recorded.
//
// What is written is the client's word, and stored as that: in
// `client_reported_calls`, never in `agent_logs` (whose rows are receipt-bearing
// proof), never signed, and with a cost that is API-equivalent and never charged.
// A database before 0084 answers 503 `client_events_unavailable`; nothing else
// depends on this table.
export const runtime = "edge";

import { evaluateGate } from "@/lib/gate";
import {
  authenticateGatewayRequest,
  enforceSenderConstraint,
  principalSuspended,
} from "@/lib/gateway/authenticate";
import {
  CLIENT_EVENTS_MAX_BATCH,
  CLIENT_EVENTS_MAX_BYTES,
  CLIENT_EVENTS_SOURCE,
  CLIENT_EVENTS_TABLE,
  clientReportedRow,
  isMissingTable,
  type ClientReportedRow,
} from "@/lib/client-reported";
import { err } from "@/lib/gateway/responses";
import { readBoundedBody } from "@/lib/http/bounded-body";
import { captureError } from "@/lib/observability";
import { rateLimit } from "@/lib/ratelimit";
import { readKillState } from "@/lib/state/killswitch";
import { readCurrentAgentPolicyAndShadow } from "@/lib/state/policy";
import { isSuspended, redis } from "@/lib/state/redis";

const EVENTS_RATE_LIMIT = Number(process.env.CLIENT_EVENTS_RATE_LIMIT ?? "30");
const EVENTS_RATE_WINDOW_S = 60;
const ROUTE = "api.client_events";
// Retention (owner, 2026-10-12): rows go after 90 days, the window fixed inside
// 0084's prune function. One sweep per agent per day, claimed in Redis.
const RETENTION_SWEEP_EVERY_S = 86_400;

export async function POST(req: Request): Promise<Response> {
  // ── 1. Authenticate: the provider argument is a log label only.
  const authentication = await authenticateGatewayRequest(req, "client-events", ROUTE);
  if (!authentication.ok) return authentication.response;
  const { principal, db, credentialToken } = authentication;
  const { agentId, userId } = principal;

  if (principal.kind === "passport") {
    const policy = await readCurrentAgentPolicyAndShadow(db, userId, agentId);
    const sender = await enforceSenderConstraint(req, credentialToken, principal, policy);
    if (!sender.ok) return sender.response;
  }

  // ── 2. Kill and suspend, as for a model call, with the same opaque answer. The
  // agent as a whole: a batch spans sessions, and a stopped session's calls are
  // exactly what an owner would want to see were still made.
  const [kill, suspended] = await Promise.all([readKillState(userId), isSuspended(agentId, null)]);
  const revocation = evaluateGate({
    agentId,
    killState: kill,
    suspended: Boolean(suspended) || principalSuspended(principal),
    provider: "client-events",
    method: "POST",
    path: ["client-events"],
    model: "",
  });
  if (revocation.deniedBy === "kill" || revocation.deniedBy === "suspend") return err(403, "blocked_suspended");

  // ── 3. Its own rate limit, after revocation as on the proxy.
  const limited = await rateLimit(`events:${agentId}`, EVENTS_RATE_LIMIT, EVENTS_RATE_WINDOW_S);
  if (!limited.success) {
    return new Response(JSON.stringify({ error: "rate_limited" }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": String(EVENTS_RATE_WINDOW_S) },
    });
  }

  // ── 4. The batch: bounded in bytes before it is parsed, in events after.
  const body = await readBoundedBody(req, CLIENT_EVENTS_MAX_BYTES);
  if (!body.ok) return err(413, "client_events_too_large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    return err(400, "invalid_client_events");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return err(400, "invalid_client_events");
  const batch = parsed as { source?: unknown; events?: unknown };
  if (batch.source !== CLIENT_EVENTS_SOURCE || !Array.isArray(batch.events)) return err(400, "invalid_client_events");
  if (batch.events.length > CLIENT_EVENTS_MAX_BATCH) return err(413, "client_events_too_large");

  // ── 5. Each event on its own: one that does not fit is dropped and counted.
  const nowMs = Date.now();
  const who = { userId, agentId, auth: principal.kind === "passport" ? ("passport" as const) : ("direct_key" as const) };
  const rows: ClientReportedRow[] = [];
  const keys = new Set<string>();
  for (const event of batch.events) {
    const row = clientReportedRow(event, who, nowMs);
    if (!row || keys.has(row.event_key)) continue;
    keys.add(row.event_key);
    rows.push(row);
  }
  const rejected = batch.events.length - rows.length;
  if (rows.length === 0) return json({ accepted: 0, rejected });

  // ── 6. Append. A retry of an event already stored is a no-op.
  const { error } = await db
    .from(CLIENT_EVENTS_TABLE)
    .upsert(rows, { onConflict: "agent_id,event_key", ignoreDuplicates: true });
  if (error) {
    if (isMissingTable(error)) return err(503, "client_events_unavailable");
    await captureError(new Error(`client_events write failed: ${String(error.code ?? "unknown")}`), { route: ROUTE }).catch(() => {});
    return err(500, "client_events_write_failed");
  }
  await ageOutOldRows(db, agentId, userId);
  return json({ accepted: rows.length, rejected });
}

// Best-effort: a failed sweep never fails the upload, and tomorrow's claim retries it.
async function ageOutOldRows(
  db: { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ error: unknown }> },
  agentId: string,
  userId: string
): Promise<void> {
  try {
    const claimed = await redis().set(`retention:client_events:${agentId}`, 1, { nx: true, ex: RETENTION_SWEEP_EVERY_S });
    if (claimed !== "OK") return;
    const { error } = await db.rpc("prune_client_reported_calls", { p_agent_id: agentId, p_user_id: userId });
    if (error) await captureError(new Error("client_events retention sweep failed"), { route: ROUTE }).catch(() => {});
  } catch {
    // Redis or the database unreachable: the upload already succeeded.
  }
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
