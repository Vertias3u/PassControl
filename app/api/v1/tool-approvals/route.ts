// POST /api/v1/tool-approvals — ask the agent's owner about one Claude Code tool call
// (subscription mode, Phase 2).
//
// A Claude Pro/Max session runs its tools on the user's machine. The sidecar decides
// Claude Code's PreToolUse hook from the agent's tool rules (0085), and a rule with
// `ask_owner` holds the tool while the owner is asked. The owner's alert destination
// is in Vault, so the asking happens here, through the same store and prompts as a
// service call's "Ask me first" (lib/approvals/gate.ts): one wait of a few seconds per
// request, and the sidecar asks again until the owner answers or its own wait ends.
//
// The agent plane, through /self's door: verify, sender proof, kill and suspend, its
// own rate limit (`toolapv:<agent>`). The tenant and agent come from the credential
// only. The gateway then RE-EVALUATES the rules with the same matcher the sidecar uses
// (cli/tool-rules.mjs) and refuses unless they put this input to the owner, so an
// agent cannot ask its owner arbitrary questions through this door.
//
// What the owner approves is the WHOLE tool input they are shown, in this session, for
// this agent, once: never just the piece a rule matched, or approving `git push` would
// approve `git push && curl … | sh`. An input larger than the owner can be shown is
// refused rather than asked about in part.
//
// The injection guard's hold (Phase 2, owner 2026-10-30) is the one other way in: while
// this agent is tainted in `hold` mode, a risky tool (cli/injection-hold.mjs) is put to
// the owner even with no ask_owner rule. Decided from the gateway's OWN policy read and
// taint store, never from anything in the request, so it widens the door only for
// those tools, in that mode, while that agent is tainted. An explicit deny still wins,
// and rules this build cannot read still refuse. The unknowns are lib/injection-hold.ts's.
export const runtime = "edge";

import { evaluateGate } from "@/lib/gate";
import { heldUnderTaint } from "@/cli/injection-hold.mjs";
import { evaluateToolRules, parseToolRules } from "@/cli/tool-rules.mjs";
import { approvalWaitMs, awaitApproval, existingApproval } from "@/lib/approvals/gate";
import {
  authenticateGatewayRequest,
  enforceSenderConstraint,
  principalSuspended,
} from "@/lib/gateway/authenticate";
import { err, errMessage } from "@/lib/gateway/responses";
import { readBoundedBody } from "@/lib/http/bounded-body";
import { rateLimit } from "@/lib/ratelimit";
import { APPROVAL_PREVIEW_MAX } from "@/lib/state/approvals";
import { readKillState } from "@/lib/state/killswitch";
import { readCurrentAgentPolicyAndShadow } from "@/lib/state/policy";
import { isSuspended } from "@/lib/state/redis";
import { HELD_TAINTED, HELD_UNKNOWN, injectionHoldReason } from "@/lib/injection-hold";
import { injectionGuardMode } from "@/lib/scope";

const TOOL_APPROVAL_RATE_LIMIT = Number(process.env.TOOL_APPROVAL_RATE_LIMIT ?? "30");
const RATE_WINDOW_S = 60;
const MAX_BODY_BYTES = 32 * 1024;
const ROUTE = "api.tool_approvals";
// What the gateway accepts as a declared session (lib/client-lineage.ts).
const DECLARED_SESSION = /^[A-Za-z0-9._:-]{1,128}$/;
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** JSON with every object's keys sorted, so the same input always reads the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function POST(req: Request): Promise<Response> {
  // ── 1. Authenticate: the provider argument is a log label only.
  const authentication = await authenticateGatewayRequest(req, "tool-approvals", ROUTE);
  if (!authentication.ok) return authentication.response;
  const { principal, db, credentialToken } = authentication;
  const { agentId, userId } = principal;

  let policy: Awaited<ReturnType<typeof readCurrentAgentPolicyAndShadow>> | null = null;
  if (principal.kind === "passport") {
    policy = await readCurrentAgentPolicyAndShadow(db, userId, agentId);
    const sender = await enforceSenderConstraint(req, credentialToken, principal, policy);
    if (!sender.ok) return sender.response;
  }

  // ── 2. Kill and suspend, with the proxy's opaque answer: a stopped agent asks nobody.
  const [kill, suspended] = await Promise.all([readKillState(userId), isSuspended(agentId, null)]);
  const revocation = evaluateGate({
    agentId,
    killState: kill,
    suspended: Boolean(suspended) || principalSuspended(principal),
    provider: "tool-approvals",
    method: "POST",
    path: ["tool-approvals"],
    model: "",
  });
  if (revocation.deniedBy === "kill" || revocation.deniedBy === "suspend") return err(403, "blocked_suspended");

  // ── 3. Its own rate limit.
  const limited = await rateLimit(`toolapv:${agentId}`, TOOL_APPROVAL_RATE_LIMIT, RATE_WINDOW_S);
  if (!limited.success) {
    return new Response(JSON.stringify({ error: "rate_limited" }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": String(RATE_WINDOW_S) },
    });
  }

  // ── 4. The tool call, bounded before it is parsed.
  const body = await readBoundedBody(req, MAX_BODY_BYTES);
  if (!body.ok) return err(413, "tool_approval_too_large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    return err(400, "invalid_tool_approval");
  }
  if (!isRecord(parsed)) return err(400, "invalid_tool_approval");
  const { session, tool_name: toolName, tool_input: toolInput, cwd } = parsed;
  if (typeof toolName !== "string" || !TOOL_NAME.test(toolName) || !isRecord(toolInput)) return err(400, "invalid_tool_approval");
  if (session !== undefined && session !== null && (typeof session !== "string" || !DECLARED_SESSION.test(session))) {
    return err(400, "invalid_tool_approval");
  }
  if (cwd !== undefined && (typeof cwd !== "string" || cwd.length > 4096)) return err(400, "invalid_tool_approval");

  // ── 5. The agent's own rules, re-evaluated here.
  let rawRules: unknown = null;
  let agentName = "an agent";
  try {
    const { data, error } = await db
      .from("agents")
      .select("tool_rules, name")
      .eq("id", agentId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error && error.code !== "42703") throw error;
    const row = (data ?? null) as { tool_rules?: unknown; name?: unknown } | null;
    rawRules = row?.tool_rules ?? null;
    if (typeof row?.name === "string" && row.name) agentName = row.name;
  } catch {
    return err(503, "tool_rules_unavailable");
  }
  const rules = parseToolRules(rawRules);
  const verdict = rules.ok ? evaluateToolRules(rules, { tool_name: toolName, tool_input: toolInput, cwd }) : { effect: null };
  // Once a hold is cleared, the sidecar's next ask about a tool still waiting finds the
  // question the hold asked: Approvals tells the owner it still waits for Approve or
  // Deny, so their answer decides it (1.7.0 e2e, F3).
  let heldBecause: string | undefined;
  let askedBefore = false;
  if (rules.ok && verdict.effect !== "ask_owner" && verdict.effect !== "deny" && heldUnderTaint(toolName)) {
    policy ??= await readCurrentAgentPolicyAndShadow(db, userId, agentId);
    heldBecause = await injectionHoldReason(policy.policy, agentId, Date.now());
    askedBefore = !heldBecause && injectionGuardMode(policy.policy) === "hold";
  }
  const asks = verdict.effect === "ask_owner" || heldBecause !== undefined;
  const notAsked = () => errMessage(409, "not_ask_owner", "This agent's tool rules do not put this tool call to its owner.");
  if (!asks && !askedBefore) return notAsked();

  // ── 6. Ask, about exactly what the owner is shown.
  const preview = toolName === "Bash" && typeof toolInput.command === "string" ? toolInput.command : canonical(toolInput);
  // Too large to ask about, so none was asked before either.
  if (preview.length > APPROVAL_PREVIEW_MAX) return asks ? err(413, "tool_approval_too_large") : notAsked();
  const fingerprint = await sha256Hex(
    canonical(["pc-tool-approval-v1", userId, agentId, typeof session === "string" ? session : "", toolName, toolInput])
  );
  const request = {
    userId, agentId, service: "claude-code", method: "TOOL", path: toolName, preview, fingerprint,
    ...(heldBecause === HELD_TAINTED ? { hold: "injection_tainted" as const }
      : heldBecause === HELD_UNKNOWN ? { hold: "injection_unknown" as const } : {}),
  };
  const approval = !asks ? await existingApproval(request) : await awaitApproval({
    request,
    prompt: {
      agentName,
      serviceLabel: "a local tool", // Claude Code's or Codex's: the sidecar serves both
      method: "TOOL",
      path: toolName,
      preview,
      dashboardUrl: `${new URL(req.url).origin}/dashboard/approvals`,
      // The store holds a question 15 minutes, but the sidecar refuses the tool at
      // the agent's own wait: say that one.
      waitNote: `The tool waits up to ${rules.ok ? rules.approvalWaitS : 0} seconds for your answer, then is refused.`,
      ...(heldBecause ? { heldBecause, offerClear: heldBecause === HELD_TAINTED } : {}),
    },
    waitMs: approvalWaitMs(),
  });
  if (approval.state === "none") return notAsked();
  if (approval.state === "unavailable") {
    return errMessage(503, "approval_unavailable", "The owner's approval could not be checked. Try again shortly.");
  }
  return new Response(JSON.stringify({ state: approval.state }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
