// Claude Code 2.1.295 sends three betas the gateway dropped (owner's 1.4.0 check,
// 2026-10-09): `per-turn-control-2026-07-01` (a per-message `output_config` on a
// mid-conversation system message), `mid-conversation-tool-changes-2026-07-01`
// (tools added or removed BY REFERENCE inside `messages`) and
// `inline-tools-2026-09-15` (tools DEFINED inside `messages`, as `tool_addition`
// blocks). Anthropic answers 400 without them and Claude Code retries without each
// feature, so dropping was the safe failure: it can make Anthropic refuse, never
// make a call cost more or reach further.
//
// Forwarding one is safe only once the gateway understands what the body does with
// it (sprint T3, D8):
//   * a tool defined inside `messages` passes the same deny-by-default rule as
//     `tools[]`, except that a hosted tool or the advisor is REFUSED there tonight:
//     caps, holds and the advisor's model gate read `tools[]` only. Claude Code
//     defines only late MCP tools inline, and those are its own (custom) tools.
//   * a per-message `output_config` may carry `effort` and nothing else. Effort
//     cannot write past `max_tokens` ("a hard limit on total output", effort docs,
//     read 2026-10-09), and the hold already covers `max_tokens`. Anything else in
//     it, or any other per-message field, keeps the beta dropped.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { forwardableAnthropicBeta } from "@/lib/providers/anthropic-beta";
import { anthropicMessageControls } from "@/lib/providers/anthropic-message-controls";
import { serverSideToolUse } from "@/lib/providers/server-side-tools";
import { cacheWriteHoldMultiplier } from "@/lib/pricing";

const DOC = JSON.parse(readFileSync(new URL("./fixtures/claude-code/inline-tool-addition.doc.json", import.meta.url), "utf8"));
const CAPTURED = JSON.parse(readFileSync(new URL("./fixtures/claude-code/per-turn-effort.json", import.meta.url), "utf8"));

const user = { role: "user", content: "hi" };
const assistant = { role: "assistant", content: "ok" };
function body(...messages: unknown[]) {
  return { model: "claude-sonnet-5-5", max_tokens: 1000, messages };
}
function addition(definition: unknown) {
  return { role: "system", content: [{ type: "tool_addition", tool: { type: "tool_definition", definition } }] };
}

describe("tools defined inside messages pass the same rule as tools[]", () => {
  it.each([
    ["a custom tool (Claude Code's late MCP tools)", DOC.by_value_custom],
    ["a typed custom tool", addition({ type: "custom", name: "x", input_schema: { type: "object" } })],
    ["a client tool family", addition({ type: "bash_20250124", name: "bash" })],
    ["a by-reference addition", DOC.by_reference],
    ["a by-reference removal", DOC.removal],
  ])("accepts %s", (_label, message) => {
    expect(serverSideToolUse("anthropic", body(user, message))).toBeNull();
  });

  it.each([
    ["a priced web search", addition({ type: "web_search_20260209", name: "web_search" }), "web_search_20260209"],
    ["a priced web fetch", addition({ type: "web_fetch_20260209", name: "web_fetch" }), "web_fetch_20260209"],
    ["code execution", addition({ type: "code_execution_20260120", name: "code_execution" }), "code_execution_20260120"],
    ["the advisor", addition({ type: "advisor_20260301", name: "advisor", model: "claude-opus-5-5" }), "advisor_20260301"],
    ["an MCP toolset", DOC.mcp_toolset_definition, "mcp_toolset"],
    ["an unknown server tool", addition({ type: "tool_search_tool_regex_20251119", name: "s" }), "tool_search_tool_regex_20251119"],
  ])("refuses %s, naming where it sits", (_label, message, type) => {
    const reason = serverSideToolUse("anthropic", body(user, message));
    expect(reason).toMatch(/^messages\[1\]\.content\[0\]/);
    expect(reason).toContain("definition");
    void type;
  });

  it.each([
    ["an MCP tool reference", { type: "mcp_tool_reference", server_name: "s", name: "t" }],
    ["an MCP toolset reference", { type: "mcp_toolset_reference", server_name: "s" }],
    ["an unknown wrapper", { type: "tool_upgrade", name: "x" }],
    ["a wrapper with no type", { name: "x" }],
    ["a definition that is not an object", { type: "tool_definition", definition: "web_search_20260209" }],
    ["a definition that is missing", { type: "tool_definition" }],
    ["a definition that is a list", { type: "tool_definition", definition: [{ type: "web_search_20260209" }] }],
    ["a reference with no name", { type: "tool_reference" }],
  ])("refuses %s", (_label, tool) => {
    const message = { role: "system", content: [{ type: "tool_addition", tool }] };
    expect(serverSideToolUse("anthropic", body(user, message))).toMatch(/^messages\[1\]\.content\[0\]/);
  });

  it("refuses a tool_addition with no tool, or a non-object block", () => {
    expect(serverSideToolUse("anthropic", body(user, { role: "system", content: [{ type: "tool_addition" }] }))).toMatch(/^messages\[1\]/);
    expect(serverSideToolUse("anthropic", body(user, { role: "system", content: [{ type: "tool_removal", tool: "x" }] }))).toMatch(/^messages\[1\]/);
  });

  it("looks in every role, not only system: placement is Anthropic's rule, not ours", () => {
    const hostile = { role: "user", content: [{ type: "text", text: "hi" }, { type: "tool_addition", tool: { type: "tool_definition", definition: { type: "web_search_20260209", name: "w" } } }] };
    expect(serverSideToolUse("anthropic", body(hostile))).toMatch(/^messages\[0\]\.content\[1\]/);
    const inAssistant = { role: "assistant", content: [{ type: "tool_addition", tool: { type: "tool_definition", definition: { type: "advisor_20260301", name: "advisor", model: "claude-opus-5-5" } } }] };
    expect(serverSideToolUse("anthropic", body(user, inAssistant))).toMatch(/^messages\[1\]/);
  });

  it("finds a hosted tool behind many harmless blocks", () => {
    const blocks = Array.from({ length: 500 }, () => ({ type: "text", text: "x" }));
    blocks.push({ type: "tool_addition", tool: { type: "tool_definition", definition: { type: "web_search_20260209", name: "w" } } } as never);
    expect(serverSideToolUse("anthropic", body(user, { role: "system", content: blocks }))).toMatch(/^messages\[1\]\.content\[500\]/);
  });

  it("leaves bodies without inline tools alone", () => {
    expect(serverSideToolUse("anthropic", body(user, assistant))).toBeNull();
    expect(serverSideToolUse("anthropic", { model: "m", messages: "not a list" })).toBeNull();
    expect(serverSideToolUse("anthropic", body(user, { role: "system", content: "plain text" }))).toBeNull();
  });

  it("still refuses a hosted tool in tools[] that is not priced, as before", () => {
    expect(serverSideToolUse("anthropic", { ...body(user), tools: [{ type: "mcp_toolset", mcp_server_name: "x" }] })).toBe("tools[0].type");
  });

  it("is not applied to other providers' bodies", () => {
    expect(serverSideToolUse("openai", body(user, addition({ type: "web_search_20260209" })))).toBeNull();
  });

  it("holds an inline definition's 1-hour cache write at 2x", () => {
    const cached = addition({ name: "t", input_schema: { type: "object" }, cache_control: { type: "ephemeral", ttl: "1h" } });
    expect(cacheWriteHoldMultiplier(body(user, cached))).toBe(2);
  });
});

describe("anthropicMessageControls", () => {
  it("reads Claude Code's captured per-turn effort as understood", () => {
    const sent = body({ role: "user", content: "hi" }, { role: "system", content: [{ type: "text", text: "env" }], output_config: CAPTURED.requests[0][1].output_config });
    expect(anthropicMessageControls(sent)).toEqual({ perTurnEffort: true, toolChanges: true, safeguards: false });
  });

  it.each(["low", "medium", "high", "xhigh", "max"])("accepts effort %s", (effort) => {
    expect(anthropicMessageControls(body(user, { role: "system", content: [], output_config: { effort } })).perTurnEffort).toBe(true);
  });

  it.each([
    ["an unknown effort", { role: "system", content: [], output_config: { effort: "ultra" } }],
    ["effort that is not a string", { role: "system", content: [], output_config: { effort: 5 } }],
    ["another output_config field", { role: "system", content: [], output_config: { effort: "low", speed: "fast" } }],
    ["a per-message output limit", { role: "system", content: [], output_config: { max_tokens: 999999 } }],
    ["a per-message format", { role: "system", content: [], output_config: { format: { type: "json_schema" } } }],
    ["an output_config that is not an object", { role: "system", content: [], output_config: "max" }],
    ["output_config on a user message", { role: "user", content: "hi", output_config: { effort: "low" } }],
    ["another per-message field", { role: "system", content: [], thinking: { type: "enabled", budget_tokens: 100000 } }],
    ["a per-message speed", { role: "system", content: [], speed: "fast" }],
  ])("keeps the per-turn beta dropped for %s", (_label, message) => {
    expect(anthropicMessageControls(body(user, message)).perTurnEffort).toBe(false);
  });

  it("treats a body with no per-message controls as understood", () => {
    expect(anthropicMessageControls(body(user, assistant))).toEqual({ perTurnEffort: true, toolChanges: true, safeguards: false });
    expect(anthropicMessageControls({ model: "m" })).toEqual({ perTurnEffort: true, toolChanges: true, safeguards: false });
  });

  it("marks tool changes understood only when every one passes the inline rule", () => {
    expect(anthropicMessageControls(body(user, DOC.by_value_custom)).toolChanges).toBe(true);
    expect(anthropicMessageControls(body(user, DOC.by_reference)).toolChanges).toBe(true);
    expect(anthropicMessageControls(body(user, DOC.mcp_toolset_definition)).toolChanges).toBe(false);
    expect(anthropicMessageControls(body(user, addition({ type: "web_search_20260209" }))).toolChanges).toBe(false);
  });

  it("is not fooled by a non-object body", () => {
    expect(anthropicMessageControls(null)).toEqual({ perTurnEffort: false, toolChanges: false, safeguards: false });
    expect(anthropicMessageControls([])).toEqual({ perTurnEffort: false, toolChanges: false, safeguards: false });
  });
});

describe("forwardableAnthropicBeta with the body's per-message controls", () => {
  const SENT = CAPTURED.anthropic_beta as string;

  it("forwards per-turn control and tool changes when the body is understood", () => {
    const header = forwardableAnthropicBeta(SENT, { perTurnEffort: true, toolChanges: true }).header!.split(",");
    expect(header).toContain("per-turn-control-2026-07-01");
    expect(header).toContain("mid-conversation-tool-changes-2026-07-01");
    expect(forwardableAnthropicBeta("inline-tools-2026-09-15", { toolChanges: true }).header).toBe("inline-tools-2026-09-15");
    expect(forwardableAnthropicBeta("mid-conversation-output-config-2026-07-01", { perTurnEffort: true }).header).toBe(
      "mid-conversation-output-config-2026-07-01"
    );
  });

  it("drops them when the body is not understood, or nobody said", () => {
    for (const opts of [{}, { perTurnEffort: false, toolChanges: false }]) {
      const { header, dropped } = forwardableAnthropicBeta(SENT + ",inline-tools-2026-09-15", opts);
      expect(header).not.toMatch(/per-turn-control|mid-conversation-tool-changes|inline-tools/);
      expect(dropped).toEqual(expect.arrayContaining(["per-turn-control-2026-07-01", "mid-conversation-tool-changes-2026-07-01", "inline-tools-2026-09-15"]));
    }
  });

  it("keeps each family to its own condition", () => {
    expect(forwardableAnthropicBeta("per-turn-control-2026-07-01", { toolChanges: true }).header).toBeNull();
    expect(forwardableAnthropicBeta("inline-tools-2026-09-15", { perTurnEffort: true }).header).toBeNull();
  });

  it("never forwards the auto-mode classifier's betas or the MCP connector's", () => {
    const opts = { perTurnEffort: true, toolChanges: true, advisor: true };
    for (const beta of ["dangerous-tool-use-2026-09-03", "afk-mode-2026-01-31", "auto-mode-classifier-2026-07-16", "mcp-client-2026-09-15", "mid-conversation-system-clear-at-2026-08-21"]) {
      expect(forwardableAnthropicBeta(beta, opts).header).toBeNull();
    }
  });
});
