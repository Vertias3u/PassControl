import { redis } from "@/lib/state/redis";

// Its own module, not lib/state/holds.ts: the proxy asks this BEFORE the hold, and the hold's
// script stays the only thing that reads or moves the snapshot itself.

/** The key holds.ts writes the period snapshot under (`k.pbase`); a test pins the two together. */
export const periodSnapshotKey = (agentId: string): string => `pbase:${agentId}`;

/**
 * Whether Redis holds a period snapshot (a last-enforced periodic limit) for this agent. The
 * proxy asks only when it could not read the agent's limit, Postgres never recorded budget
 * state for it, and nothing else makes it budgeted (review 2026-11-21, finding 1). An
 * unreadable answer says yes: the fenced hold then runs as before, and an unreachable Redis
 * refuses it there anyway.
 */
export async function hasPeriodSnapshot(agentId: string): Promise<boolean> {
  try {
    return (await redis().exists(periodSnapshotKey(agentId))) > 0;
  } catch {
    return true;
  }
}
