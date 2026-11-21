// The cascading stop is hosted-only. In Core a stop ends nothing beyond refusing calls.
export type CascadeScope =
  | { trigger: "kill_switch"; userId: string }
  | { trigger: "session"; userId: string; agentId: string; session: string }
  | { trigger: "service"; userId: string; service: string }
  | { trigger: "mission_end"; userId: string; missionId: string }
  | { trigger: "budget_pause"; userId: string; agentId: string };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CascadeDb = { from(table: string): any; rpc(name: string, args: Record<string, unknown>): any };
export function cascadeMode(): "live" | "shadow" { return "shadow"; }
export async function runCascade(..._args: unknown[]): Promise<null> { return null; }
export function scheduleCascade(_scope: CascadeScope): void {}
export function schedulePauseCascade(_userId: string, _agentId: string): void {}
export async function retryEndings(..._args: unknown[]): Promise<null> { return null; }
export async function reconcileEndings(..._args: unknown[]): Promise<null> { return null; }
