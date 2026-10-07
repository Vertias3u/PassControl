// Anthropic runs some tools on its own servers and bills them per use, outside
// token usage (web search, web fetch, code execution), or reaches places the
// agent named (an MCP toolset, `mcp_servers`). The server-side tool rule had no
// Anthropic entry, so none of these were inspected. Same rule as OpenAI's:
// deny-by-default, passing only tools the AGENT executes, from the installed
// SDK's `BetaToolUnion` (@anthropic-ai/sdk 0.112.4,
// resources/beta/messages/messages.d.ts).
//
// Claude Code's own 27 tools are all untyped custom tools (captured 2026-10-07),
// so this refuses nothing it sends.
//
// Revised the same day (DECISIONS 2026-10-07): hosted tools with a published
// per-use price (web search, web fetch, code execution) are ACCEPTED in their
// exact SDK versions and priced (tests/hosted-tools-anthropic.test.ts). Unpriced
// ones, those that reach servers the agent names, and unknown versions stay refused.
import { describe, expect, it } from "vitest";
import { serverSideToolUse } from "@/lib/providers/server-side-tools";

const custom = { name: "Read", description: "d", input_schema: { type: "object" } };

describe("Anthropic: tools the agent executes pass", () => {
  it.each([
    ["no tools", {}],
    ["an untyped custom tool, as Claude Code sends", { tools: [custom] }],
    ["type custom", { tools: [{ ...custom, type: "custom" }] }],
    ["type null", { tools: [{ ...custom, type: null }] }],
    ["bash", { tools: [{ type: "bash_20250124", name: "bash" }] }],
    ["computer", { tools: [{ type: "computer_20251124", name: "computer" }] }],
    ["text editor", { tools: [{ type: "text_editor_20250728", name: "str_replace_based_edit_tool" }] }],
    ["memory", { tools: [{ type: "memory_20250818", name: "memory" }] }],
    ["a later bash version", { tools: [{ type: "bash_20270101", name: "bash" }] }],
    ["Claude Code's context_management", { tools: [custom], context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] } }],
    ["web search (priced)", { tools: [{ type: "web_search_20250305", name: "web_search" }] }],
    ["web search with dynamic filtering (priced)", { tools: [{ type: "web_search_20260318", name: "web_search" }] }],
    ["web fetch (priced)", { tools: [{ type: "web_fetch_20250910", name: "web_fetch" }] }],
    ["code execution (priced)", { tools: [{ type: "code_execution_20250825", name: "code_execution" }] }],
    ["a code execution container reused across turns", { tools: [{ type: "code_execution_20250825", name: "code_execution" }], container: "container_1" }],
  ])("allows %s", (_name, body) => {
    expect(serverSideToolUse("anthropic", body)).toBeNull();
  });
});

describe("Anthropic: unpriced hosted tools and anything ambiguous are refused", () => {
  it.each([
    ["the advisor tool", { tools: [{ type: "advisor_20260301", name: "advisor" }] }],
    ["tool search", { tools: [{ type: "tool_search_tool_bm25_20251119", name: "tool_search" }] }],
    ["an MCP toolset", { tools: [{ type: "mcp_toolset", mcp_server_name: "x" }] }],
    ["an unpriced tool after a custom one", { tools: [custom, { type: "advisor_20260301", name: "advisor" }] }],
    ["a web search version PassControl has not priced", { tools: [{ type: "web_search_20270101", name: "web_search" }] }],
    ["a code execution version PassControl has not priced", { tools: [{ type: "code_execution_20270101", name: "code_execution" }] }],
    ["an unknown type", { tools: [{ type: "something_new_20270101", name: "x" }] }],
    ["a client family name with a suffix glued on", { tools: [{ type: "bash_20250124_hosted", name: "x" }] }],
    ["a non-object tool", { tools: ["web_search"] }],
    ["tools that are not a list", { tools: { type: "custom" } }],
    ["remote MCP servers", { mcp_servers: [{ type: "url", url: "https://x", name: "x" }] }],
  ])("refuses %s", (_name, body) => {
    expect(serverSideToolUse("anthropic", body)).not.toBeNull();
  });
});
