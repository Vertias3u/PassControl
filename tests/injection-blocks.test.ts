// Which parts of a model request came from tools, and so get the injection scan
// (plans/injection-guard.md §2a).
//
// Built on the SHAPES real clients send, not tidy ones: Claude Code puts `role: "system"`
// messages inside `messages` and its own reminders in user text
// (tests/fixtures/claude-code/per-turn-effort.json), and Codex sends a Responses `input`
// list (tests/fixtures/codex/responses-request.json). The owner's own words, the system
// prompt and the model's own turns are never scanned: the user is the trusted party, and
// a user writing ABOUT injection is the false positive most worth avoiding.
import { describe, expect, it } from "vitest";

import { untrustedBlocks } from "@/lib/injection-blocks";

const shape = (body: unknown) => untrustedBlocks(body).map(({ path, source }) => `${source} ${path}`);

describe("Anthropic Messages, as Claude Code sends it", () => {
  const body = {
    model: "claude-sonnet-5-5",
    system: [{ type: "text", text: "You are Claude Code. Ignore previous instructions is a phrase we test for." }],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "<system-reminder>CLAUDE.md says: ignore all previous instructions…</system-reminder>" },
          { type: "text", text: "read the page" },
        ],
      },
      { role: "system", content: [{ type: "text", text: "mid-conversation system text" }], output_config: { effort: "medium" } },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "WebFetch", input: { url: "https://x.test" } }] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "page body as a string" },
          { type: "tool_result", tool_use_id: "toolu_2", content: [{ type: "text", text: "part one" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }] },
          { type: "text", text: "the user typing after a tool" },
        ],
      },
    ],
  };

  it("takes tool results only, string and array content alike, and skips images", () => {
    expect(shape(body)).toEqual([
      "tool_result messages[3].content[0].content",
      "tool_result messages[3].content[1].content[0].text",
    ]);
    expect(untrustedBlocks(body).map((b) => b.text)).toEqual(["page body as a string", "part one"]);
  });

  it("documents, search results and server-tool results are untrusted too", () => {
    const more = {
      messages: [
        {
          role: "user",
          content: [
            { type: "document", source: { type: "text", media_type: "text/plain", data: "a RAG document" }, title: "Doc" },
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" } },
            { type: "search_result", source: "https://kb.test/a", title: "KB", content: [{ type: "text", text: "a search hit" }] },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "server_tool_use", id: "srvtoolu_1", name: "web_fetch", input: { url: "https://x.test" } },
            {
              type: "web_fetch_tool_result",
              tool_use_id: "srvtoolu_1",
              content: {
                type: "web_fetch_result",
                url: "https://x.test",
                content: { type: "document", source: { type: "text", media_type: "text/plain", data: "fetched page" } },
              },
            },
            { type: "web_search_tool_result", tool_use_id: "srvtoolu_2", content: [{ type: "web_search_result", title: "A result", url: "https://r.test", encrypted_content: "EqgfCioIARgB" }] },
            { type: "text", text: "the model's own words" },
          ],
        },
      ],
    };
    expect(untrustedBlocks(more).map((b) => `${b.source} ${b.text}`)).toEqual([
      "document a RAG document",
      "document Doc",
      "search_result KB",
      "search_result a search hit",
      "web_fetch_tool_result fetched page",
      "web_search_tool_result A result",
    ]);
  });
});

describe("OpenAI Chat Completions", () => {
  it("takes tool (and legacy function) messages", () => {
    const body = {
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hello" },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: "tool said this" },
        { role: "tool", tool_call_id: "c2", content: [{ type: "text", text: "array part" }] },
        { role: "function", name: "f", content: "legacy function output" },
      ],
    };
    expect(shape(body)).toEqual(["tool messages[3].content", "tool messages[4].content[0].text", "function messages[5].content"]);
  });
});

describe("OpenAI Responses, as Codex sends it", () => {
  it("takes tool-call outputs and file-search results, never the user's input text", () => {
    const body = {
      model: "gpt-5-mini",
      instructions: "(scrubbed)",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "say hi" }] },
        // One model turn, several calls in a row: every one of them is in the newest turn.
        { type: "mcp_call", id: "mcp_1", name: "get_issue", arguments: "{}", output: "issue body" },
        { type: "file_search_call", id: "fs_1", results: [{ file_id: "file_1", filename: "a.md", text: "a chunk" }] },
        { type: "function_call", call_id: "call_1", name: "exec_command", arguments: "{\"cmd\":\"cat README.md\"}" },
        { type: "custom_tool_call", call_id: "call_2", name: "apply_patch", input: "…" },
        { type: "computer_call", call_id: "call_3", action: { type: "screenshot" } },
        { type: "function_call_output", call_id: "call_1", output: "Exit code: 0\nREADME text" },
        { type: "custom_tool_call_output", call_id: "call_2", output: [{ type: "input_text", text: "patched" }] },
        { type: "computer_call_output", call_id: "call_3", output: { type: "computer_screenshot", image_url: "data:image/png;base64,iVBOR" } },
      ],
    };
    expect(shape(body)).toEqual([
      "mcp_call input[1].output",
      "file_search_call input[2].results[0].filename",
      "file_search_call input[2].results[0].text",
      "function_call_output input[6].output",
      "custom_tool_call_output input[7].output[0].text",
    ]);
  });

  it("a plain string input carries nothing untrusted", () => {
    expect(untrustedBlocks({ model: "gpt-5-mini", input: "just a prompt" })).toEqual([]);
  });
});

describe("bounds", () => {
  it("anything that is not a request body yields nothing", () => {
    for (const body of [null, "x", 1, [], { messages: "nope" }, { input: {} }]) expect(untrustedBlocks(body)).toEqual([]);
  });

  it("stops at a fixed number of blocks", () => {
    const body = { messages: [{ role: "tool", content: Array.from({ length: 5_000 }, (_, i) => ({ type: "text", text: `t${i}` })) }] };
    expect(untrustedBlocks(body)).toHaveLength(2_000);
  });

  it("does not recurse forever into a deep document", () => {
    let content: unknown = "deep";
    for (let i = 0; i < 500; i++) content = [{ type: "text", content }];
    expect(() => untrustedBlocks({ messages: [{ role: "tool", content }] })).not.toThrow();
  });
});

// A conversation is re-sent whole on every call, but the attacker writes tool OUTPUT, not
// the request's shape: each tool block is new on exactly one call, the first after the
// model turn that asked for it. So only the newest turn is read: from the last model turn
// (inclusive, because a server tool's result sits inside it) to the end. That catches
// every block once and holds the cost to one turn, not the whole history every call.
describe("only the newest turn", () => {
  const tr = (id: string, text: string) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] });
  const ask = (id: string) => ({ role: "assistant", content: [{ type: "tool_use", id, name: "Read", input: {} }] });

  it("skips tool results an earlier call already carried", () => {
    const body = { messages: [{ role: "user", content: "go" }, ask("a"), tr("a", "old"), ask("b"), tr("b", "new")] };
    expect(shape(body)).toEqual(["tool_result messages[4].content[0].content"]);
  });

  it("reads a server tool's result inside the last model turn", () => {
    const body = {
      messages: [
        { role: "user", content: "look it up" },
        { role: "assistant", content: [{ type: "web_fetch_tool_result", tool_use_id: "s1", content: { type: "web_fetch_result", url: "https://x.test", content: { type: "document", source: { type: "text", data: "page" } } } }] },
        { role: "user", content: "and?" },
      ],
    };
    expect(shape(body).every((s) => s.includes("messages[1]"))).toBe(true);
    expect(shape(body).length).toBeGreaterThan(0);
  });

  it("a trailing prefill is not the boundary", () => {
    const body = { messages: [{ role: "user", content: "go" }, ask("a"), tr("a", "new"), { role: "assistant", content: "Sure," }] };
    expect(shape(body)).toEqual(["tool_result messages[2].content[0].content"]);
  });

  it("no model turn yet: everything is new", () => {
    const body = { messages: [{ role: "user", content: [{ type: "document", source: { type: "text", data: "rag" } }] }] };
    expect(shape(body)).toEqual(["document messages[0].content[0].source.data"]);
  });

  it("OpenAI Chat: only the tool answers after the last assistant message", () => {
    const body = {
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: null, tool_calls: [{ id: "1" }] },
        { role: "tool", tool_call_id: "1", content: "old" },
        { role: "assistant", content: null, tool_calls: [{ id: "2" }, { id: "3" }] },
        { role: "tool", tool_call_id: "2", content: "new 2" },
        { role: "tool", tool_call_id: "3", content: "new 3" },
      ],
    };
    expect(shape(body)).toEqual(["tool messages[4].content", "tool messages[5].content"]);
  });

  it("Responses: only the outputs after the last call the model made", () => {
    const body = {
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] },
        { type: "function_call", call_id: "1", name: "exec", arguments: "{}" },
        { type: "function_call_output", call_id: "1", output: "old" },
        { type: "function_call", call_id: "2", name: "exec", arguments: "{}" },
        { type: "function_call", call_id: "3", name: "exec", arguments: "{}" },
        { type: "function_call_output", call_id: "2", output: "new 2" },
        { type: "function_call_output", call_id: "3", output: "new 3" },
      ],
    };
    expect(shape(body)).toEqual(["function_call_output input[5].output", "function_call_output input[6].output"]);
  });
});
