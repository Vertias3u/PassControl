// 1.7.1 (external review P6): a block format the injection guard has no rule for
// (lib/injection-blocks.ts, `unknownTypes`) is said, so the operator sees what the guard
// cannot read. Once an hour per agent and format: a new provider block type would
// otherwise say so on every call. Telemetry only: it never holds, never records a
// finding, never touches the receipt, and a store that cannot be read says nothing.
import { captureGuardEvent } from "@/lib/observability";
import { redis } from "@/lib/state/redis";

export const COVERAGE_NOTE_SECONDS = 3600;

export async function noteUnknownCoverage(agentId: string, types: readonly string[]): Promise<void> {
  try {
    const fresh: string[] = [];
    for (const type of types) {
      if ((await redis().set(`injcov:${agentId}:${type}`, "1", { nx: true, ex: COVERAGE_NOTE_SECONDS })) === "OK") fresh.push(type);
    }
    if (fresh.length === 0) return;
    await captureGuardEvent("proxy.injection_coverage_unknown", { route: "api.proxy", agentId, code: `types:${fresh.join(",")}` });
  } catch {
    // Telemetry is never the reason anything fails.
  }
}
