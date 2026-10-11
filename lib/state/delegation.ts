// Bet D: the hot-path copy of delegation revocations (plans/delegation-design.md §9, §13).
//
// Postgres is the record (delegation_revocations, agents.delegations_valid_after, 0081)
// and the exchange route reads it before minting every visa. These Redis keys let the
// PROXY refuse a revoked delegation inside a visa's lifetime too. If they are lost, a
// worker keeps working only until its current visa expires (5 minutes by default): the
// next exchange reads Postgres.
//
// A READ FAILURE THROWS, and the proxy refuses on it (owner decision P2.3: fail closed).
// That is deliberately NOT the kill switch's fail-open posture: a delegation is a
// narrower, derived credential, and an unreadable revocation for it is an unreadable
// credential. Trust boundary 3's asymmetry is chosen here, not inherited.
import { redis } from "./redis";

const JTI = /^[A-Za-z0-9_-]{16,64}$/;
/** Longer than any link can live (24 h) plus skew: past that a revoked jti is dead anyway. */
export const DELEGATION_REVOCATION_TTL_S = 25 * 3600;

function revKey(agentId: string, jti: string): string {
  if (!JTI.test(jti)) throw new Error("invalid_delegation_jti");
  return `dlrev:${agentId}:${jti}`;
}
const wmKey = (agentId: string) => `dlwm:${agentId}`;

/**
 * True when any link is revoked, or was issued at or before the agent's watermark.
 * One MGET for the whole chain. Throws when Redis cannot answer.
 */
export async function readDelegationRevocation(
  agentId: string,
  links: readonly { dlg: string; iat: number }[]
): Promise<boolean> {
  const values = await redis().mget<(string | number | null)[]>(wmKey(agentId), ...links.map((l) => revKey(agentId, l.dlg)));
  const [wm, ...revoked] = values;
  if (revoked.some((v) => v !== null && v !== undefined)) return true;
  if (wm === null || wm === undefined) return false;
  const watermark = Number(wm);
  // A watermark that does not parse is treated as covering everything: closed.
  if (!Number.isFinite(watermark)) return true;
  return links.some((l) => l.iat <= watermark);
}

export async function revokeDelegation(agentId: string, jti: string): Promise<void> {
  await redis().set(revKey(agentId, jti), "1", { ex: DELEGATION_REVOCATION_TTL_S });
}

const RAISE_WM_LUA = `
local cur = tonumber(redis.call('GET', KEYS[1]) or '0')
local next = tonumber(ARGV[1])
if next > cur then redis.call('SET', KEYS[1], ARGV[1]) end
return 1
`;

/** Forward only, as the column it mirrors. */
export async function raiseDelegationWatermark(agentId: string, seconds: number): Promise<void> {
  await redis().eval(RAISE_WM_LUA, [wmKey(agentId)], [String(Math.floor(seconds))]);
}
