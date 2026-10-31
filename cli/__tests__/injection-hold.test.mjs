import { describe, expect, it } from "vitest";
import { heldUnderTaint, INJECTION_HOLD_TOOLS, underTaint } from "../injection-hold.mjs";

// Injection guard Phase 2 (owner, 2026-10-30): while an agent is tainted, the risky
// tools wait for the owner. One definition, read by the sidecar's tool gate and by the
// gateway's re-check in POST /api/v1/tool-approvals, so the two can never disagree about
// what may be put to the owner.

describe("heldUnderTaint", () => {
  it.each(["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit", "WebFetch", "mcp__github__create_pr", "mcp__x__y"])("holds %s", (tool) => {
    expect(heldUnderTaint(tool)).toBe(true);
  });

  it.each(["Read", "Glob", "Grep", "WebSearch", "TodoWrite", "Task", "mcp_", "mcp__", "bash", "", "Bashful"])("lets %s through", (tool) => {
    expect(heldUnderTaint(tool)).toBe(false);
  });

  // Codex names its file edit `apply_patch` at PreToolUse (seen live, Codex 0.163,
  // 2026-10-30): a tainted Codex agent wrote a file while its `echo` was held.
  it("holds Codex's apply_patch, the file edit Claude Code calls Write and Edit", () => {
    expect(heldUnderTaint("apply_patch")).toBe(true);
  });

  it("names exactly the owner's set", () => {
    expect([...INJECTION_HOLD_TOOLS].sort()).toEqual(["Bash", "Edit", "MultiEdit", "NotebookEdit", "WebFetch", "Write", "apply_patch"]);
  });

  it("is not fooled by a non-string", () => {
    expect(heldUnderTaint(undefined)).toBe(false);
    expect(heldUnderTaint({ toString: () => "Bash" })).toBe(false);
  });
});

describe("underTaint: the verdict while tainted", () => {
  const deny = { effect: "deny", ruleIndex: 0, subject: "git push" };
  const ask = { effect: "ask", ruleIndex: 1, subject: "rm" };
  const askOwner = { effect: "ask_owner", ruleIndex: 2, subject: "x" };
  const none = { effect: null };

  it("an explicit deny still wins (strictest wins)", () => {
    expect(underTaint(deny, "Bash")).toBe(deny);
  });

  it("a risky tool with no rule, or an ask rule, is put to the owner, and says why", () => {
    expect(underTaint(none, "Bash")).toEqual({ effect: "ask_owner", reason: "injection_taint" });
    expect(underTaint(ask, "Write")).toEqual({ effect: "ask_owner", reason: "injection_taint" });
  });

  it("an ask_owner rule stays the rule's own", () => {
    expect(underTaint(askOwner, "Bash")).toBe(askOwner);
  });

  it("a tool outside the set keeps its verdict", () => {
    expect(underTaint(none, "Read")).toBe(none);
    expect(underTaint(ask, "Grep")).toBe(ask);
  });
});
