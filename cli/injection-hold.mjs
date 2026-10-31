// Injection guard Phase 2, `hold`: which tools wait for the owner while an agent is
// tainted (owner, 2026-10-30; plans/injection-guard.md §4).
//
// Shared by the sidecar's tool gate and the gateway's re-check in
// POST /api/v1/tool-approvals, so what the sidecar holds is exactly what the gateway
// will put to the owner. Reading goes on: Read, Glob and Grep pass. Acting waits:
// running a command, writing a file, fetching a URL (a URL can carry data out) and any
// MCP tool. An explicit deny rule still wins, as everywhere in the rule language.
// `apply_patch` is Codex's file edit (its shell arrives as `Bash`; seen live, Codex
// 0.163, 2026-10-30).

export const INJECTION_HOLD_TOOLS = new Set(["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit", "WebFetch", "apply_patch"]);

/** True for a tool a tainted agent may not run without the owner. */
export function heldUnderTaint(toolName) {
  if (typeof toolName !== "string") return false;
  if (INJECTION_HOLD_TOOLS.has(toolName)) return true;
  // `mcp__<server>__<tool>`: anything past the prefix.
  return toolName.startsWith("mcp__") && toolName.length > "mcp__".length;
}

/**
 * The verdict while tainted: a held tool is put to the owner unless a rule already
 * denies it or already asks the owner. Any other verdict comes back unchanged.
 */
export function underTaint(verdict, toolName) {
  if (!heldUnderTaint(toolName)) return verdict;
  if (verdict?.effect === "deny" || verdict?.effect === "ask_owner") return verdict;
  return { effect: "ask_owner", reason: "injection_taint" };
}
