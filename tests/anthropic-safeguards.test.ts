// Auto mode's server-side safety checks behind PassControl (sprint P7, owner 2026-10-10:
// "build after one real check", then "lets do b": build it narrow, test-first).
//
// In auto mode Claude Code asks Anthropic to check risky tool calls inside the model
// call itself, at no charge, by sending a `safeguards` body field with beta
// `dangerous-tool-use-2026-09-03`. PassControl forwarded the field but dropped the beta,
// so Anthropic answered "400 safeguards: Extra inputs are not permitted" on every
// session's first call (seen live 2026-10-10), Claude Code fell back to its own
// classifier calls, and the agent's budget paid for those.
//
// The beta is forwarded only when every `safeguards` entry is a shape the gateway
// understands: `type: "dangerous_tool_use"` and an optional `classifier_context`
// object, nothing else. The context is the client's own description of its
// environment for the provider's classifier; it adds no tool, URL or model, and a
// verdict only reaches the client that asked. Anything else keeps the beta dropped,
// which is today's behaviour: a free 400, then Claude Code's billed fallback.
import { describe, expect, it } from "vitest";
import { forwardableAnthropicBeta } from "@/lib/providers/anthropic-beta";
import { anthropicMessageControls } from "@/lib/providers/anthropic-message-controls";

// The SHAPE Claude Code 2.1.296 sent on 2026-10-10 (captured against a local fake
// upstream; keys and value types kept, every value replaced with a placeholder).
const CONTEXT = {
  v: 1,
  permission_mode: "auto",
  platform: "macos",
  live_cwd: "/home/dev/project",
  home_dir: "/home/dev",
  rule_roots: { userSettings: "/home/dev/.claude/settings.json" },
  trusted_directories: { primary: { path: "/home/dev/project", resolved: {} }, additional: [], network: [], block_reads_outside_working_directories: false },
  rules: { allow: [{ rule: "Bash(echo:*)", source: "cliArg" }], deny: [], ask: [] },
  auto_mode: { allow: [], soft_deny: [], hard_deny: [], environment: [] },
  artifact_consent_holdback: false,
  case_insensitive_paths: true,
  restricted: false,
  is_remote_mode: false,
  classify_all_shell: false,
  user_identity: "dev",
  dropped: { allow: 0 },
  git_state: { cwd: "/home/dev/project", root: "/home/dev/project", branch: "main", default_branch: "main", status: {}, visibility: {} },
};
const CAPTURED = [{ type: "dangerous_tool_use", classifier_context: CONTEXT }];
const BETAS =
  "claude-code-20250219,per-turn-control-2026-07-01,dangerous-tool-use-2026-09-03,afk-mode-2026-01-31";

function body(safeguards?: unknown) {
  return {
    model: "claude-haiku-5-5",
    max_tokens: 100,
    messages: [{ role: "user", content: "hi" }],
    ...(safeguards === undefined ? {} : { safeguards }),
  };
}

describe("which safeguards the gateway understands", () => {
  it("understands what Claude Code sends", () => {
    expect(anthropicMessageControls(body(CAPTURED)).safeguards).toBe(true);
  });

  it("understands an entry with no context", () => {
    expect(anthropicMessageControls(body([{ type: "dangerous_tool_use" }])).safeguards).toBe(true);
  });

  it("says nothing to forward when the body asks for no checks", () => {
    expect(anthropicMessageControls(body()).safeguards).toBe(false);
  });

  it.each([
    ["an empty list", []],
    ["an object instead of a list", { type: "dangerous_tool_use" }],
    ["a string", "dangerous_tool_use"],
    ["null", null],
    ["an entry that is not an object", ["dangerous_tool_use"]],
    ["an entry that is a list", [[{ type: "dangerous_tool_use" }]]],
    ["an entry of another type", [{ type: "prompt_injection" }]],
    ["an entry with no type", [{ classifier_context: CONTEXT }]],
    ["a known entry beside an unknown one", [...CAPTURED, { type: "something_new" }]],
    ["an entry with an extra field", [{ type: "dangerous_tool_use", model: "claude-opus-5-5" }]],
    ["a context that is not an object", [{ type: "dangerous_tool_use", classifier_context: "x" }]],
    ["a context that is a list", [{ type: "dangerous_tool_use", classifier_context: [CONTEXT] }]],
    ["more entries than one request needs", Array.from({ length: 9 }, () => ({ type: "dangerous_tool_use" }))],
  ])("does not understand %s, so the beta stays dropped", (_label, safeguards) => {
    expect(anthropicMessageControls(body(safeguards)).safeguards).toBe(false);
  });

  it("reads a body that is not an object as nothing to forward", () => {
    expect(anthropicMessageControls(null).safeguards).toBe(false);
    expect(anthropicMessageControls([CAPTURED]).safeguards).toBe(false);
  });
});

describe("the dangerous-tool-use beta", () => {
  it("is forwarded only when the body's safeguards were understood", () => {
    expect(forwardableAnthropicBeta(BETAS, { safeguards: true }).header).toContain("dangerous-tool-use-2026-09-03");
    expect(forwardableAnthropicBeta(BETAS, { safeguards: false }).header).not.toContain("dangerous-tool-use");
    expect(forwardableAnthropicBeta(BETAS).header).not.toContain("dangerous-tool-use");
  });

  it("follows Claude Code's date moves within the family", () => {
    expect(forwardableAnthropicBeta("dangerous-tool-use-2027-01-15", { safeguards: true }).header).toBe("dangerous-tool-use-2027-01-15");
    expect(forwardableAnthropicBeta("dangerous-tool-use-20270115", { safeguards: true }).header).toBe("dangerous-tool-use-20270115");
  });

  it("does not let a suffix ride along on the family name", () => {
    expect(forwardableAnthropicBeta("dangerous-tool-use-2026-09-03-extra", { safeguards: true }).header).toBeNull();
  });

  it.each(["afk-mode-2026-01-31", "auto-mode-classifier-2026-07-16"])(
    "keeps %s dropped: no body field the gateway understands uses it",
    (beta) => {
      expect(forwardableAnthropicBeta(beta, { safeguards: true })).toEqual({ header: null, dropped: [beta] });
    }
  );
});
