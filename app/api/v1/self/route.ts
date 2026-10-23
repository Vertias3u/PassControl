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
// A caller that names its session the way Claude Code does on every call
// (`x-claude-code-session-id`) is told when THAT session was stopped, with the
// proxy's own message: the `/passcontrol` plugin asks here, and without it a
// stopped session read as healthy while every call was refused.
//
// `pace` says when the first limit is reached at the agent's current rate, or null
// when there is nothing honest to say (lib/budget-pace.ts).
//
// `pause` is the owner's soft pause line (0087), or null with none: whether the
// proxy would refuse the next call for it, and until when the owner let it go on
// (lib/budget-pause.ts). Without it, the status line said "runs out at 16:00" while
// every call got a 402.
//
// Deliberately absent from the answer: the policy and its shadow (deny rules are
// the owner's), fallbacks, endpoints, key ids and anything about the owner.
//
// One exception, on request only: `?include=tool_rules` adds the agent's TOOL rules
// (0085, subscription mode). The sidecar decides Claude Code's PreToolUse hook from
// them, locally and in milliseconds, so it has to hold them, and it reads them on the
// agent-wide /self ask it already makes (no extra call per session). The governed
// agent can therefore read its own tool rules: they are guard rails, not a secret
// (a deliberate choice, recorded 2026-10-12). Never the policy, never the service rules.
export const runtime = "edge";

import { budgetPace } from "@/lib/budget-pace";
import { pauseStatus } from "@/lib/budget-pause";
import { switchModelProblem } from "@/lib/cheaper-model";
import { budgetView, readPeriodCounted, readRecentSpend, type PeriodInput } from "@/lib/budget-view";
import { evaluateGate } from "@/lib/gate";
import {
  authenticateGatewayRequest,
  enforceSenderConstraint,
  principalSuspended,
} from "@/lib/gateway/authenticate";
import { readClientLineage, sessionStoppedMessage } from "@/lib/client-lineage";
import { err, errMessage } from "@/lib/gateway/responses";
import { MICROCENTS_PER_CENT } from "@/lib/pricing";
import { rateLimit } from "@/lib/ratelimit";
import { readKillState, withRecordedSessionStop } from "@/lib/state/killswitch";
import { readPauseLiftEnd } from "@/lib/state/pause";
import { readCurrentAgentPolicyAndShadow } from "@/lib/state/policy";
import { isSuspended, readBudgetSnapshot } from "@/lib/state/redis";
import { readToolRules } from "@/lib/tool-rules";

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
  // opaque answer: a caller cannot probe which control it tripped. A stopped
  // session is the one the proxy names, so this names it too.
  const session = readClientLineage(req.headers)?.session ?? null;
  const [kill, suspendRead] = await Promise.all([readKillState(userId), isSuspended(agentId, session)]);
  const redisSuspended = withRecordedSessionStop(suspendRead, kill, agentId, session);
  const revocation = evaluateGate({
    agentId,
    killState: kill,
    suspended: Boolean(redisSuspended) || principalSuspended(principal),
    provider: "self",
    method: "GET",
    path: ["self"],
    model: "",
  });
  if (revocation.deniedBy === "suspend" && redisSuspended === "session" && session && !principalSuspended(principal)) {
    return errMessage(403, "blocked_suspended", sessionStoppedMessage(session));
  }
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

  // ── 5. Pace: when the first limit is reached at the current rate (1.6.0). A
  // limit with no period is projected from the ledger's last day, read only when
  // there is such a limit, so an agent with a daily limit alone costs no query.
  const budget = budgetView({ capTokens, capMicrocents, snapshot, mirror, period, nowMs });
  const recent = budget.cost || budget.tokens ? await readRecentSpend(agentId, nowMs) : null;
  const pace = budgetPace(budget, recent, nowMs);
  // The same counters the proxy pauses on: `used` is never taken from the mirror.
  const pauseAt = policy.pause?.known ? policy.pause.percent : null;
  const switchTo = policy.pause?.known ? (policy.pause.switchTo ?? null) : null;
  // The gateway judges the switch against the scope the call carries; one this
  // credential's scope no longer allows is refused there, so it is a pause here.
  const switchUsable = switchTo !== null && switchModelProblem(principal.scopes, switchTo) === null;
  const pause =
    pauseAt == null ? null : await pauseStatus(budget, pauseAt, () => readPauseLiftEnd(agentId, nowMs), switchTo, switchUsable);

  const wantsToolRules = new URL(req.url).searchParams.get("include") === "tool_rules";
  const toolRules = wantsToolRules ? await readToolRules(db, agentId, userId) : undefined;

  return new Response(
    JSON.stringify({
      agent_id: agentId,
      // The credential class, as receipts name it: a Direct Agent Key is never a passport.
      auth: principal.kind === "passport" ? "passport" : "direct_key",
      scope: principal.scopes,
      budget,
      pace,
      pause,
      as_of: new Date(nowMs).toISOString(),
      ...(toolRules ? { tool_rules: toolRules } : {}),
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
