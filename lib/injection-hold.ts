// Injection guard Phase 2: why the hold puts an action to the owner, for the two
// gateway doors that hold (a /svc write and a Claude Code tool through
// POST /api/v1/tool-approvals). One answer for both, from the gateway's own policy
// read and taint store, never from the request.
//
// Each unknown has its declared side (plans/injection-guard.md §4):
//  - the taint store unreadable → held: the approval store already fails closed, and
//    the cost is one question the owner did not need;
//  - the policy unreadable → held only for an agent KNOWN to be in hold mode (owner,
//    2026-10-30, "1b"), and a live taint is that knowledge: one exists only in hold
//    mode. No taint, or no taint store either, and the action goes, POLICY_FAIL_CLOSED
//    or not: a policy outage must not put every tenant's writes to their owners.
import { POLICY_UNREADABLE } from "@/lib/gate";
import { injectionGuardMode } from "@/lib/scope";
import { readTaint } from "@/lib/state/taint";

export const HELD_TAINTED =
  "Held by the injection guard: this agent recently read text that looked like a prompt injection. Approve only if you expected this.";
export const HELD_UNKNOWN =
  "Held by the injection guard: whether this agent read a possible prompt injection could not be checked. Approve only if you expected this.";

/** The owner-facing reason the hold applies, or undefined when it does not. */
export async function injectionHoldReason(policy: unknown, agentId: string, nowMs: number): Promise<string | undefined> {
  if (policy === POLICY_UNREADABLE) {
    try {
      return (await readTaint(agentId, nowMs)) ? HELD_TAINTED : undefined;
    } catch {
      return undefined;
    }
  }
  if (injectionGuardMode(policy) !== "hold") return undefined;
  try {
    return (await readTaint(agentId, nowMs)) ? HELD_TAINTED : undefined;
  } catch {
    return HELD_UNKNOWN;
  }
}

/**
 * The longest the proxy holds back a hold-mode agent's answer for the taint its own
 * strong finding writes (owner, 2026-10-30, "3 fix"). Past it the answer goes and the
 * write carries on behind it: a slow findings table must not stall the agent's model.
 */
export const PROXY_TAINT_WAIT_MS = 2_000;
