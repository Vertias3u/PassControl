// Anthropic reports hosted-tool use in `usage.server_tool_use`, and with a hosted
// tool the totals that matter arrive LAST: search and fetch results become input
// tokens while the call runs, so the final `message_delta` carries input, cache and
// tool counts that `message_start` could not know. The tally read input only from
// `message_start`, which would charge a searching call for its prompt alone.
// Counts are cumulative, so the larger figure is kept.
import { describe, expect, it } from "vitest";
import { createUsageTransform, usageFromJson } from "@/lib/usage/parseStream";

const enc = (s: string) => new TextEncoder().encode(s);

async function settleStream(lines: string[]) {
  const { stream, settled } = createUsageTransform("anthropic");
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const l of lines) controller.enqueue(enc(l));
      controller.close();
    },
  });
  const reader = source.pipeThrough(stream).getReader();
  while (!(await reader.read()).done) {
    /* drain */
  }
  return settled;
}

describe("Anthropic hosted-tool usage", () => {
  it("reads server_tool_use from a buffered response", () => {
    const u = usageFromJson("anthropic", {
      usage: {
        input_tokens: 105,
        output_tokens: 239,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        server_tool_use: { web_search_requests: 2, web_fetch_requests: 1, code_execution_requests: 3 },
      },
    });
    expect(u.hostedTools).toEqual({ webSearch: 2, webFetch: 1, codeExecution: 3 });
    expect(u.inputTokens).toBe(105);
  });

  it("takes the final message_delta's input, cache and tool counts in a stream", async () => {
    const out = await settleStream([
      'data: {"type":"message_start","message":{"usage":{"input_tokens":50,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}\n\n',
      'data: {"type":"message_delta","usage":{"input_tokens":6039,"output_tokens":931,"cache_read_input_tokens":7123,"cache_creation_input_tokens":7345,"server_tool_use":{"web_search_requests":1}}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ]);
    expect(out.usage).toMatchObject({ inputTokens: 6039, outputTokens: 931, cacheReadTokens: 7123, cacheWriteTokens: 7345 });
    expect(out.usage.hostedTools).toEqual({ webSearch: 1, webFetch: 0, codeExecution: 0 });
    expect(out.complete).toBe(true);
  });

  it("never lowers a count a later event reports smaller", async () => {
    const out = await settleStream([
      'data: {"type":"message_start","message":{"usage":{"input_tokens":900,"output_tokens":1,"cache_read_input_tokens":10,"cache_creation_input_tokens":20}}}\n\n',
      'data: {"type":"message_delta","usage":{"input_tokens":5,"output_tokens":42}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ]);
    expect(out.usage).toMatchObject({ inputTokens: 900, outputTokens: 42, cacheReadTokens: 10, cacheWriteTokens: 20 });
    expect(out.usage.hostedTools).toBeUndefined();
  });

  it("leaves a response with no tool use exactly as before", () => {
    const u = usageFromJson("anthropic", { usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
    expect(u.hostedTools).toBeUndefined();
  });
});

// Live 2026-10-07: a code execution call reported `server_tool_use` with web
// counts only, no `code_execution_requests`, so a charge read from usage alone
// was $0. The executions are the `server_tool_use` content blocks Anthropic
// streams (`bash_code_execution` here; also `code_execution` and
// `text_editor_code_execution`). Counted from those; the larger figure wins.
describe("Anthropic code execution is counted from its content blocks", () => {
  it("counts each code-execution server_tool_use block in a stream", async () => {
    const out = await settleStream([
      'data: {"type":"message_start","message":{"usage":{"input_tokens":2000,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}\n\n',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"server_tool_use","id":"srvtoolu_1","name":"bash_code_execution","input":{}}}\n\n',
      'data: {"type":"content_block_start","index":2,"content_block":{"type":"bash_code_execution_tool_result","tool_use_id":"srvtoolu_1","content":{}}}\n\n',
      'data: {"type":"content_block_start","index":3,"content_block":{"type":"server_tool_use","id":"srvtoolu_2","name":"text_editor_code_execution","input":{}}}\n\n',
      'data: {"type":"content_block_start","index":4,"content_block":{"type":"server_tool_use","id":"srvtoolu_3","name":"web_search","input":{}}}\n\n',
      'data: {"type":"message_delta","usage":{"input_tokens":4624,"output_tokens":107,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"server_tool_use":{"web_search_requests":1,"web_fetch_requests":0}}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ]);
    expect(out.usage.hostedTools).toEqual({ webSearch: 1, webFetch: 0, codeExecution: 2 });
  });

  it("counts them in a buffered response too", () => {
    const u = usageFromJson("anthropic", {
      content: [
        { type: "server_tool_use", id: "s1", name: "code_execution", input: {} },
        { type: "code_execution_tool_result", tool_use_id: "s1", content: {} },
        { type: "text", text: "1048576" },
      ],
      usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 } },
    });
    expect(u.hostedTools).toEqual({ webSearch: 0, webFetch: 0, codeExecution: 1 });
  });
});
