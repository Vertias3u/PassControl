import { describe, expect, it, vi } from "vitest";
import { createToolGate } from "../tool-gate.mjs";

// Subscription mode, Phase 2: what the sidecar answers Claude Code's PreToolUse hook
// from the agent's tool rules, once the stop check has let the tool through.
//   deny       → permissionDecision "deny" (the turn goes on; Claude is told why)
//   ask        → permissionDecision "ask" (Claude Code's own terminal prompt)
//   ask_owner  → held while the owner is asked through the gateway; a yes lets
//                Claude Code's normal permission flow continue, anything else denies
// Rules never read fail open with a warning, as stops do. Rules this build cannot
// read deny every tool: the owner wrote them, and guessing would be worse.

const NOW = 1_000_000;
const rules = (list, extra = {}) => ({ read: { state: "ok", document: { rules: list, ...extra } }, at: NOW });
const bash = (command, extra = {}) => ({ hook_event_name: "PreToolUse", session_id: "sess-1", tool_name: "Bash", tool_input: { command }, ...extra });

function gate(overrides = {}) {
  const askOwner = vi.fn(async () => ({ state: "approved" }));
  const onDecision = vi.fn();
  const g = createToolGate({ askOwner, onDecision, now: () => NOW, dashboardUrl: "https://gw.example/dashboard", ...overrides });
  return { g, askOwner: overrides.askOwner ?? askOwner, onDecision: overrides.onDecision ?? onDecision };
}
const decision = (out) => out.hookSpecificOutput?.permissionDecision ?? null;

describe("tool rules at PreToolUse", () => {
  it("lets through what no rule names, and records nothing", async () => {
    const { g, onDecision } = gate();
    expect(await g.decide(bash("git status"), rules([{ tool: "Bash", command: "git push*", effect: "deny" }]), 600)).toEqual({});
    expect(onDecision).not.toHaveBeenCalled();
  });

  it("lets everything through when the agent has no rules", async () => {
    const { g } = gate();
    expect(await g.decide(bash("rm -rf /"), { read: { state: "none" }, at: NOW }, 600)).toEqual({});
  });

  it("denies what a deny rule names, says which rule, and records it without the command", async () => {
    const { g, onDecision } = gate();
    const out = await g.decide(bash("cd x && git push --force"), rules([{ tool: "Bash", command: "git push*", effect: "deny" }]), 600);
    expect(decision(out)).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/rule 1/);
    expect(out.continue).toBeUndefined();
    expect(onDecision).toHaveBeenCalledWith({ session: "sess-1", agent: null, tool: "Bash", decision: "deny", ruleIndex: 0, waitMs: 0 });
    expect(JSON.stringify(onDecision.mock.calls)).not.toContain("push");
  });

  it("hands an ask rule to Claude Code's own prompt", async () => {
    const { g, onDecision } = gate();
    const out = await g.decide(bash("npm publish"), rules([{ tool: "Bash", command: "npm publish*", effect: "ask" }]), 600);
    expect(decision(out)).toBe("ask");
    expect(onDecision).toHaveBeenCalledWith(expect.objectContaining({ decision: "ask", ruleIndex: 0 }));
  });

  it("names a sub-agent in the record when the hook fires inside one", async () => {
    const { g, onDecision } = gate();
    await g.decide(bash("git push", { agent_id: "agent-7" }), rules([{ tool: "Bash", effect: "deny" }]), 600);
    expect(onDecision).toHaveBeenCalledWith(expect.objectContaining({ agent: "agent-7" }));
  });

  it("denies every tool when the rules cannot be read by this build", async () => {
    const { g, onDecision } = gate();
    const out = await g.decide(bash("ls"), { read: { state: "invalid" }, at: NOW }, 600);
    expect(decision(out)).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/tool rules.*https:\/\/gw\.example\/dashboard/);
    expect(onDecision).toHaveBeenCalledWith(expect.objectContaining({ decision: "rules_invalid", ruleIndex: null }));
  });

  it("fails open, with a warning at most once a minute, when the rules were never read", async () => {
    const { g } = gate();
    const first = await g.decide(bash("git push"), null, 600);
    expect(decision(first)).toBeNull();
    expect(first.systemMessage).toMatch(/tool rules/);
    expect(await g.decide(bash("git push"), { read: { state: "unknown" }, at: NOW }, 600)).toEqual({});
  });
});

describe("asking the owner", () => {
  const owner = rules([{ tool: "Bash", command: "git push*", effect: "ask_owner" }], { approval_wait_s: 90 });

  it("waits for the owner's yes, then lets Claude Code's own permission flow decide", async () => {
    const { g, askOwner, onDecision } = gate();
    expect(await g.decide(bash("git push origin"), owner, 600)).toEqual({});
    expect(askOwner).toHaveBeenCalledWith(
      expect.objectContaining({ tool_name: "Bash" }),
      { ruleIndex: 0, subject: "git push origin", session: "sess-1", waitMs: 90_000 }
    );
    expect(onDecision).toHaveBeenCalledWith(expect.objectContaining({ decision: "owner_approved", ruleIndex: 0 }));
  });

  it.each([
    ["denied", "owner_denied", /said no/],
    ["timeout", "owner_timeout", /did not answer within 90 s/],
    ["unavailable", "owner_unavailable", /could not be reached/],
    ["full", "owner_unavailable", /too many questions/],
    ["refused", "owner_unavailable", /did not agree/],
    ["too_large", "owner_unavailable", /too large to show/],
  ])("denies when the answer is %s", async (state, recorded, reason) => {
    const askOwner = vi.fn(async () => ({ state }));
    const { g, onDecision } = gate({ askOwner });
    const out = await g.decide(bash("git push"), owner, 600);
    expect(decision(out)).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(reason);
    expect(onDecision).toHaveBeenCalledWith(expect.objectContaining({ decision: recorded }));
  });

  it("denies when asking throws", async () => {
    const askOwner = vi.fn(async () => {
      throw new Error("boom");
    });
    const { g } = gate({ askOwner });
    expect(decision(await g.decide(bash("git push"), owner, 600))).toBe("deny");
  });

  it("never waits longer than the hook will: the wait ends 30 s before Claude Code gives up", async () => {
    const { g, askOwner } = gate();
    await g.decide(bash("git push"), rules([{ tool: "Bash", effect: "ask_owner" }], { approval_wait_s: 540 }), 120);
    expect(askOwner.mock.calls[0][1].waitMs).toBe(90_000);
  });

  it("refuses at once, without asking, under a Phase 1 hook that would time out and let the tool run", async () => {
    const { g, askOwner, onDecision } = gate();
    for (const timeout of [null, 5, 39]) {
      const out = await g.decide(bash("git push"), owner, timeout);
      expect(decision(out)).toBe("deny");
      expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/configure claude-code --subscription --write/);
    }
    expect(askOwner).not.toHaveBeenCalled();
    expect(onDecision).toHaveBeenCalledWith(expect.objectContaining({ decision: "owner_unavailable" }));
  });

  it("does not ask the owner about something a deny rule already refuses", async () => {
    const { g, askOwner } = gate();
    const both = rules([
      { tool: "Bash", command: "git push*", effect: "ask_owner" },
      { tool: "Bash", command: "git push --force*", effect: "deny" },
    ]);
    expect(decision(await g.decide(bash("git push --force"), both, 600))).toBe("deny");
    expect(askOwner).not.toHaveBeenCalled();
  });
});

it("answers only PreToolUse", async () => {
  const { g } = gate();
  expect(await g.decide({ hook_event_name: "UserPromptSubmit" }, rules([{ tool: "Bash", effect: "deny" }]), 600)).toEqual({});
});
