// Redis keys shared by the kill switch (killswitch.ts) and the per-agent state
// (redis.ts). One definition, so the kill switch's reload from its durable record
// (0083) writes exactly the key the gateway's suspension read looks for.

/** One declared session's stop (sprint T8). */
export const sessionStopKey = (agentId: string, sessionId: string) => `session_stop:${agentId}:${sessionId}`;
