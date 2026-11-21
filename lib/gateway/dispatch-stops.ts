import { authenticateDirectAgentKey } from "@/lib/auth/direct-key";
import type { GatewayPrincipal } from "@/lib/gateway/authenticate";
import { resolveCallMission, type CallMission } from "@/lib/mission/gate";
import { readDelegationRevocation } from "@/lib/state/delegation";
import { readKillState, withRecordedSessionStop } from "@/lib/state/killswitch";
import { isSuspended } from "@/lib/state/redis";
import type { writeLog } from "@/lib/log";

// Ordinary calls reuse admission's authority reads; slow uploads and approval
// waits exceeding two seconds must refresh them before their first dispatch.
export const DISPATCH_AUTHORITY_MAX_AGE_MS = 2_000;

type Refusal = {
  status: number;
  code: string;
  audit: Parameters<typeof writeLog>[0]["status"];
  message?: string;
  session?: boolean;
};

/** Signed claims are already verified at admission. This local clock check
 * adds no authority reads and never advances their freshness stamps. */
export function passportExpiryRefusal(principal: GatewayPrincipal): Refusal | undefined {
  if (principal.kind !== "passport") return undefined;
  const nowS = Math.floor(Date.now() / 1000);
  if ((principal.visaExpiresAt !== undefined && principal.visaExpiresAt <= nowS)
    || principal.delegation?.links.some(link => link.exp <= nowS)) {
    return principal.delegation
      ? { status: 403, code: "invalid_visa", audit: "blocked_policy" }
      : { status: 401, code: "invalid_visa", audit: "blocked_policy" };
  }
  return undefined;
}

/** One reader for every dispatch path. Redis readers retain their own fail
 * posture (including Cloud configuration); credential/mission/delegation reads
 * retain their admission fail-closed posture. No bearer or provider key escapes.
 */
export function dispatchStopChecker(input: {
  db: Parameters<typeof authenticateDirectAgentKey>[0] & Parameters<typeof resolveCallMission>[0]["db"];
  principal: GatewayPrincipal;
  credentialToken: string;
  session: string | null;
  service?: string;
  missionOnly?: boolean;
  admissionMission: CallMission;
  authenticatedAt: number;
  missionReadAt: number;
  delegationReadAt?: number;
}) {
  const { principal, db } = input;
  let authenticatedAt = input.authenticatedAt;
  let missionReadAt = input.missionReadAt;
  let delegationReadAt = input.delegationReadAt ?? input.authenticatedAt;
  return async (forceAuthority = false, redisOnly = false) => {
    const now = Date.now();
    const readAuthority = async (): Promise<Refusal | undefined> => {
      const expiry = passportExpiryRefusal(principal);
      if (expiry) return expiry;
      if (redisOnly) return undefined;
      if (principal.kind === "direct_key" && (forceAuthority || now - authenticatedAt > DISPATCH_AUTHORITY_MAX_AGE_MS)) {
        try {
          const fresh = await authenticateDirectAgentKey(db, input.credentialToken);
          if (!fresh || fresh.keyId !== principal.keyId || fresh.agentId !== principal.agentId || fresh.userId !== principal.userId) {
            return { status: 401, code: "invalid_credential", audit: "blocked_policy" };
          }
          if (fresh.suspended) return { status: 403, code: "blocked_suspended", audit: "blocked_suspended" };
          authenticatedAt = now;
        } catch {
          return { status: 503, code: "authentication_unavailable", audit: "blocked_policy" };
        }
      }
      if (forceAuthority || now - missionReadAt > DISPATCH_AUTHORITY_MAX_AGE_MS) {
        const fresh = await resolveCallMission({ db, principal, missionOnly: input.missionOnly, nowS: Math.floor(Date.now() / 1000) });
        if (fresh.kind === "refuse") return { ...fresh, audit: "blocked_policy" };
        if (fresh.kind === "between" && input.admissionMission.kind !== "between") return { status: 403, code: "mission_required", audit: "blocked_policy" };
        // A worker/direct key cannot silently leave the mission whose ledger and
        // policy admitted this attempt, even when the active-record lookup is now empty.
        // Shadow mode enforces nothing (lib/mission/gate.ts), here as at admission: only a
        // mission that admitted this call with authority, an enforced one or one the visa
        // carries, holds it to that mission (review 2026-11-21, finding 2).
        const carriedMission = principal.kind === "passport" && principal.mission !== undefined;
        if (input.admissionMission.kind === "bound" && (input.admissionMission.enforce || carriedMission)) {
          if (fresh.kind !== "bound") return { status: 403, code: "mission_ended", audit: "blocked_policy" };
          if (fresh.record.id !== input.admissionMission.record.id || fresh.record.currentHash !== input.admissionMission.record.currentHash) {
            return { status: 401, code: "mission_revision_stale", audit: "blocked_policy" };
          }
        } else if (fresh.kind === "bound" && fresh.enforce) {
          return { status: 401, code: "mission_visa_required", audit: "blocked_policy" };
        }
        missionReadAt = now;
      }
      if (principal.kind === "passport" && principal.delegation && (forceAuthority || now - delegationReadAt > DISPATCH_AUTHORITY_MAX_AGE_MS)) {
        try {
          if (await readDelegationRevocation(principal.agentId, principal.delegation.links)) {
            return { status: 403, code: "delegation_revoked", audit: "blocked_delegation_revoked" };
          }
          delegationReadAt = now;
        } catch {
          return { status: 503, code: "delegation_state_unavailable", audit: "blocked_delegation_unavailable" };
        }
      }
      return undefined;
    };
    const authorityRefusal = await readAuthority();
    // Read Redis last: even a stop armed during a slow authority lookup must
    // win before dispatch. These same readers supply admission's fail posture.
    const [killState, suspendRead] = await Promise.all([
      readKillState(principal.userId, input.service ? { service: input.service } : {}),
      isSuspended(principal.agentId, input.session),
    ]);
    const redisSuspended = withRecordedSessionStop(suspendRead, killState, principal.agentId, input.session);
    const principalSuspended = principal.kind === "direct_key" && principal.suspended;
    const suspended = redisSuspended !== false || principalSuspended;
    const result = (refusal?: Refusal) => ({ killState, suspended, refusal });
    if (killState.platformKill || killState.userKill || killState.denylist.includes(principal.agentId) || killState.serviceKill) {
      return result({ status: 403, code: "blocked_suspended", audit: "blocked_killed" });
    }
    if (suspended) {
      return result({ status: 403, code: "blocked_suspended", audit: "blocked_suspended", session: redisSuspended === "session" && !principalSuspended });
    }
    return result(authorityRefusal);
  };
}
