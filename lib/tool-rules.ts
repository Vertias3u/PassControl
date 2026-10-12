// An agent's tool rules (0085), read for the gateway. The rule language and its
// matcher live in cli/tool-rules.mjs, shared with the sidecar so the two never
// disagree; this file only reads the column.
import { parseToolRules } from "@/cli/tool-rules.mjs";

export type ToolRulesRead =
  | { state: "ok"; document: unknown }
  | { state: "none" }
  | { state: "invalid" }
  | { state: "unknown" };

type AgentsReader = { from: (table: string) => unknown };
type Query = {
  select: (columns: string) => Query;
  eq: (column: string, value: string) => Query;
  maybeSingle: () => PromiseLike<{ data: { tool_rules?: unknown } | null; error: { code?: string } | null }>;
};

/**
 * This tenant's agent's tool rules. `none` when it has none or the database predates
 * 0085 (no column, so none can exist); `invalid` when this build cannot read the
 * document, which is never handed out; `unknown` when the read failed.
 */
export async function readToolRules(db: AgentsReader, agentId: string, userId: string): Promise<ToolRulesRead> {
  try {
    const { data, error } = await (db.from("agents") as Query)
      .select("tool_rules")
      .eq("id", agentId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) return error.code === "42703" ? { state: "none" } : { state: "unknown" };
    const document = data?.tool_rules ?? null;
    if (document === null) return { state: "none" };
    return parseToolRules(document).ok ? { state: "ok", document } : { state: "invalid" };
  } catch {
    return { state: "unknown" };
  }
}
