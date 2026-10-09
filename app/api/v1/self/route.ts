// GET /api/v1/self — the calling agent's own scope and limits (1.4.0 candidate 2).
//
// An agent that can read its budget can choose a cheaper model before it is
// refused, and `passcontrol statusline` shows it to the person in Claude Code.
//
// The agent plane, not a developer API: it answers only about the credential's own
// agent (no id is ever read from the request), through the same door as a model
// call — verify, sender proof, kill and suspend — and writes nothing. No log row,
// no receipt, no hold: reading a budget must never spend it. Its rate limit is its
// own (`self:<agent>`), so a status line polling it cannot use up the allowance the
// agent's model calls share (`proxy:<agent>`).
//
// Deliberately absent from the answer: the policy and its shadow (deny rules are
// the owner's), fallbacks, endpoints, key ids and anything about the owner.
export const runtime = "edge";

import { budgetView, readPeriodCounted, type PeriodInput } from "@/lib/budget-view";
import { evaluateGate } from "@/lib/gate";
import {
  authenticateGatewayRequest,
  enforceSenderConstraint,
  principalSuspended,
} from "@/lib/gateway/authenticate";
import { err } from "@/lib/gateway/responses";
import { MICROCENTS_PER_CENT } from "@/lib/pricing";
import { rateLimit } from "@/lib/ratelimit";
import { readKillState } from "@/lib/state/killswitch";
import { readCurrentAgentPolicyAndShadow } from "@/lib/state/policy";
import { isSuspended, readBudgetSnapshot } from "@/lib/state/redis";

const SELF_RATE_LIMIT = Number(process.env.SELF_RATE_LIMIT ?? "60");
const SELF_RATE_WINDOW_S = 60;
const ROUTE = "api.self";

export async function GET(req: Request): Promise<Response> {
  // ── 1. Authenticate: the provider argument is a log label only.
  const authentication = await authenticateGatewayRequest(req, "self", ROUTE);
  if (!authentication.ok) return authentication.response;
  const { principal, db, credentialToken } = authentication;
  const { agentId, userId } = principal;

  const policy = await readCurrentAgentPolicyAndShadow(db, userId, agentId);
  if (principal.kind === "passport") {
    // Without this, /self would be the one door a bare visa still opens for an
    // agent whose owner requires proof of possession.
    const sender = await enforceSenderConstraint(req, credentialToken, principal, policy);
    if (!sender.ok) return sender.response;
  }

  // ── 2. Kill and suspend, evaluated exactly as for a model call, with the same
  // opaque answer: a caller cannot probe which control it tripped.
  const [kill, redisSuspended] = await Promise.all([readKillState(userId), isSuspended(agentId)]);
  const revocation = evaluateGate({
    agentId,
    killState: kill,
    suspended: redisSuspended || principalSuspended(principal),
    provider: "self",
    method: "GET",
    path: ["self"],
    model: "",
  });
  if (revocation.deniedBy === "kill" || revocation.deniedBy === "suspend") return err(403, "blocked_suspended");

  // ── 3. Its own rate limit, after revocation as on the proxy.
  const limited = await rateLimit(`self:${agentId}`, SELF_RATE_LIMIT, SELF_RATE_WINDOW_S);
  if (!limited.success) {
    return new Response(JSON.stringify({ error: "rate_limited" }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": String(SELF_RATE_WINDOW_S) },
    });
  }

  // ── 4. The limits the gateway would enforce on the next call: the live row,
  // and the credential's own caps only where the row could not be read (S3-04).
  const live = policy.budget;
  const capTokens = live.known ? live.tokens : principal.budgetTokens;
  const cents = live.known ? live.cents : principal.budgetCents;
  const capMicrocents = cents == null ? null : Math.round(Number(cents) * MICROCENTS_PER_CENT);
  const nowMs = Date.now();

  const periodRead = policy.period;
  const [snapshot, mirror, period] = await Promise.all([
    readBudgetSnapshot(agentId).catch(() => null),
    principal.kind === "direct_key"
      ? Promise.resolve({ spentTokens: principal.spentTokens, spentMicrocents: principal.spentMicrocents })
      : readMirror(db, agentId, userId),
    (async (): Promise<PeriodInput> => {
      if (!periodRead || !periodRead.known) return { mode: "unknown" };
      if (periodRead.kind === null || periodRead.cents === null) return { mode: "none" };
      return {
        mode: "set",
        kind: periodRead.kind,
        capMicrocents: Math.round(periodRead.cents * MICROCENTS_PER_CENT),
        counted: await readPeriodCounted(agentId, periodRead.kind, nowMs),
      };
    })(),
  ]);

  return new Response(
    JSON.stringify({
      agent_id: agentId,
      // The credential class, as receipts name it: a Direct Agent Key is never a passport.
      auth: principal.kind === "passport" ? "passport" : "direct_key",
      scope: principal.scopes,
      budget: budgetView({ capTokens, capMicrocents, snapshot, mirror, period, nowMs }),
      as_of: new Date(nowMs).toISOString(),
    }),
    { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } }
  );
}

/** `agents.spent_*` for this tenant's agent, or null when it cannot be read. */
async function readMirror(
  db: Awaited<ReturnType<typeof authenticateGatewayRequest>> extends infer A
    ? A extends { ok: true; db: infer D }
      ? D
      : never
    : never,
  agentId: string,
  userId: string
): Promise<{ spentTokens: number; spentMicrocents: number } | null> {
  try {
    const { data, error } = await db
      .from("agents")
      .select("spent_tokens, spent_microcents")
      .eq("id", agentId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error || !data) return null;
    const row = data as { spent_tokens?: unknown; spent_microcents?: unknown };
    const tokens = Number(row.spent_tokens);
    const microcents = Number(row.spent_microcents);
    return Number.isFinite(tokens) && Number.isFinite(microcents) ? { spentTokens: tokens, spentMicrocents: microcents } : null;
  } catch {
    return null;
  }
}
