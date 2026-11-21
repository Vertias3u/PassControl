// Core has no hosted memory ledger or memory hold.
export const HELD_MEMORY = "This gateway does not operate memory custody.";
export const HELD_MEMORY_UNKNOWN = HELD_MEMORY;
export async function memoryHoldReason(..._args: unknown[]): Promise<string | undefined> { return undefined; }
export async function memoryHoldView(..._args: unknown[]): Promise<{
  mode: "hold" | "withhold"; readable: boolean; held: boolean; pending: number;
  removals: number; integrity: string[]; paths: string[];
} | null> { return null; }
