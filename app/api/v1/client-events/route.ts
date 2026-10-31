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
//
// One more kind rides the same batch: `injection_finding`, what the sidecar's scan of a
// tool's output found (plans/injection-guard.md §2b). It goes to `injection_findings`
// as `surface='sidecar'`, only while the owner has the injection guard on, and the answer
// never says which: off, it is counted with the rejected events like any other.
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
import { POLICY_UNREADABLE } from "@/lib/gate";
import { err } from "@/lib/gateway/responses";
import type { InjectionFinding } from "@/lib/injection-guard";
import { recordInjectionFindings, redisSeenStore, sidecarFinding, type FindingsDb } from "@/lib/injection-findings";
import { readBoundedBody } from "@/lib/http/bounded-body";
import { captureError } from "@/lib/observability";
import { rateLimit } from "@/lib/ratelimit";
import { readKillState } from "@/lib/state/killswitch";
import { injectionGuardMode } from "@/lib/scope";
import { taintFromFindings } from "@/lib/state/taint";
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

  let policy: Awaited<ReturnType<typeof readCurrentAgentPolicyAndShadow>> | null = null;
  if (principal.kind === "passport") {
    policy = await readCurrentAgentPolicyAndShadow(db, userId, agentId);
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
  const findingEvents: unknown[] = [];
  for (const event of batch.events) {
    if ((event as { kind?: unknown } | null)?.kind === "injection_finding") {
      findingEvents.push(event);
      continue;
    }
    const row = clientReportedRow(event, who, nowMs);
    if (!row || keys.has(row.event_key)) continue;
    keys.add(row.event_key);
    rows.push(row);
  }
  const findingsAccepted = await recordSidecarFindings(db, findingEvents, { userId, agentId, policy });
  const accepted = rows.length + findingsAccepted;
  const rejected = batch.events.length - accepted;
  if (rows.length === 0) return json({ accepted, rejected });

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
  return json({ accepted, rejected });
}

// The injection findings in a batch, recorded only while the agent's live policy has the
// guard on. A Direct Agent Key's policy is read here, and only when the batch carries a
// finding; a passport's was read for its sender proof. Unreadable means off, as on the
// proxy. Returns how many were taken: stored, or already stored (a re-sent block). A
// database without 0089 or 0090 takes none, and the batch's reported calls are unaffected.
async function recordSidecarFindings(
  db: Parameters<typeof readCurrentAgentPolicyAndShadow>[0],
  events: unknown[],
  who: { userId: string; agentId: string; policy: Awaited<ReturnType<typeof readCurrentAgentPolicyAndShadow>> | null }
): Promise<number> {
  if (events.length === 0) return 0;
  const findings: InjectionFinding[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    const finding = sidecarFinding(event, who.userId);
    if (!finding || seen.has(finding.contentHmac)) continue;
    seen.add(finding.contentHmac);
    findings.push(finding);
  }
  if (findings.length === 0) return 0;
  const policy = who.policy ?? (await readCurrentAgentPolicyAndShadow(db, who.userId, who.agentId));
  const mode = policy.policy === POLICY_UNREADABLE ? null : injectionGuardMode(policy.policy);
  if (mode === null) return 0;
  const outcome = await recordInjectionFindings({
    db: db as unknown as FindingsDb,
    seen: redisSeenStore(),
    userId: who.userId,
    agentId: who.agentId,
    provider: "",
    model: "",
    findings,
    surface: "sidecar",
  });
  if (outcome.state === "failed") {
    await captureError(new Error("client_events injection findings write failed"), { route: ROUTE }).catch(() => {});
  }
  // Hold mode (Phase 2): a new high finding taints the agent, which the sidecar learns
  // from /self, never from this answer. A taint that cannot be set holds nothing.
  try {
    await taintFromFindings({ agentId: who.agentId, mode, outcome, surface: "sidecar", now: Date.now() });
  } catch (error) {
    await captureError(error, { route: ROUTE, agentId: who.agentId, code: "injection_taint_failed" }).catch(() => {});
  }
  return outcome.state === "recorded" || outcome.state === "nothing_new" ? findings.length : 0;
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
