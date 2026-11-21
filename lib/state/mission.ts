// Core has no mission counters or observations. Never grant a subagent claim.
export async function claimMissionSubagent(..._args: unknown[]): Promise<"claimed" | "full" | "missing"> { return "missing"; }
export async function recordMissionDecision(..._args: unknown[]): Promise<void> {}
