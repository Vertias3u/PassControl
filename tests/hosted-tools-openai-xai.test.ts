// OpenAI's and xAI's hosted tools, priced instead of refused (owner, DECISIONS
// 2026-10-07). Built from the documented shapes only: no real OpenAI or xAI call
// has been made with these tools yet, and the public note says so until one is.
//
// OpenAI, developers.openai.com/api/docs/pricing (read 2026-10-07):
//   web search            $10 / 1k calls; the preview tools $25 / 1k on non-reasoning
//                         models (charged at $25 here whatever the model)
//   file search           $2.50 / 1k calls
//   code interpreter and  per 20-minute session by memory tier: 1g $0.03, 4g $0.12,
//   hosted shell          16g $0.48, 64g $1.92; billed by the minute, 5-minute minimum
//   The response's usage has no tool counts: they are the output items
//   (web_search_call, file_search_call, code_interpreter_call, shell_call), and
//   `max_tool_calls` caps all built-in tool calls together (openai 6.49.0 types).
//
// xAI, docs.x.ai/developers/pricing.md and tools/tool-usage-details.md (read
// 2026-10-07): web search $5 / 1k, X search $5 / 1k posts and $10 / 1k profiles,
// code execution $5 / 1k, collections search $2.50 / 1k; failed calls unbilled;
// counts in usage.server_side_tool_usage_details, and usage.cost_in_usd_ticks is
// the exact charge (10^10 ticks per dollar). xAI has no per-call cap field
// (`max_turns` limits rounds), so nothing is injected and the hold assumes the
// default number of calls; settlement takes the larger of computed and reported.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOOL_CAP,
  SEARCH_RESULT_TOKEN_ALLOWANCE,
  X_SEARCH_POSTS_ALLOWANCE,
  hostedToolPlan,
  hostedToolReserve,
  hostedToolUseCost,
  totalWithHostedTools,
  withDefaultToolCaps,
} from "@/lib/providers/hosted-tools";
import { costMicrocents, unpricedRequestOption } from "@/lib/pricing";
import { serverSideToolUse } from "@/lib/providers/server-side-tools";
import { usageFromJson, createUsageTransform } from "@/lib/usage/parseStream";

const CENT = 1_000_000; // microcents
const fn = { type: "function", name: "f", parameters: { type: "object" } };

describe("OpenAI: which hosted tools pass", () => {
  it.each([
    ["web_search", { tools: [{ type: "web_search" }] }],
    ["a dated web_search", { tools: [{ type: "web_search_2025_08_26" }] }],
    ["web_search_preview", { tools: [{ type: "web_search_preview" }] }],
    ["file_search", { tools: [{ type: "file_search", vector_store_ids: ["vs_1"] }] }],
    ["code_interpreter in an auto container", { tools: [{ type: "code_interpreter", container: { type: "auto", memory_limit: "4g" } }] }],
    ["code_interpreter reusing a container", { tools: [{ type: "code_interpreter", container: "cntr_1" }] }],
    ["shell in an auto container", { tools: [{ type: "shell", environment: { type: "container_auto" } }] }],
    ["shell in a referenced container", { tools: [{ type: "shell", environment: { type: "container_reference", container_id: "cntr_1" } }] }],
    ["a hosted tool after a function", { tools: [fn, { type: "web_search" }] }],
  ])("allows %s", (_n, body) => {
    expect(serverSideToolUse("openai", body)).toBeNull();
  });

  it.each([
    ["image_generation", { tools: [{ type: "image_generation" }] }],
    ["mcp", { tools: [{ type: "mcp", server_label: "s", server_url: "https://x" }] }],
    ["tool_search on the server", { tools: [{ type: "tool_search", execution: "server" }] }],
    ["an unknown web search version", { tools: [{ type: "web_search_2027_01_01" }] }],
    ["shell with no environment", { tools: [{ type: "shell" }] }],
  ])("still refuses %s", (_n, body) => {
    expect(serverSideToolUse("openai", body)).not.toBeNull();
  });

  it("leaves Azure on the old refusal: nobody has priced its hosted tools", () => {
    expect(serverSideToolUse("azure", { tools: [{ type: "web_search" }] })).not.toBeNull();
  });
});

describe("OpenAI: cap, hold and charge", () => {
  it("adds max_tool_calls 5 under a dollar limit, and only then", () => {
    const body = { model: "gpt-5-mini", tools: [{ type: "web_search" }] };
    expect(withDefaultToolCaps("openai", body, true)).toEqual({ ...body, max_tool_calls: DEFAULT_TOOL_CAP });
    expect(withDefaultToolCaps("openai", body, false)).toBe(body);
    const capped = { ...body, max_tool_calls: 30 };
    expect(withDefaultToolCaps("openai", capped, true)).toBe(capped);
    const plain = { tools: [fn] };
    expect(withDefaultToolCaps("openai", plain, true)).toBe(plain);
  });

  it("holds every capped call at the dearest tool present, plus result tokens", () => {
    const plan = hostedToolPlan("openai", { max_tool_calls: 3, tools: [{ type: "file_search", vector_store_ids: ["v"] }, { type: "web_search_preview" }] })!;
    const tokens = 3 * SEARCH_RESULT_TOKEN_ALLOWANCE;
    expect(hostedToolReserve(plan, "gpt-5-mini", "openai")).toEqual({
      tokens,
      microcents: 3 * 2.5 * CENT + costMicrocents("gpt-5-mini", tokens, 0, "openai"),
    });
  });

  it("holds one 20-minute session per container tool, at its memory tier", () => {
    const plan = hostedToolPlan("openai", { max_tool_calls: 1, tools: [{ type: "code_interpreter", container: { type: "auto", memory_limit: "4g" } }] })!;
    // 20 minutes at $0.12 per 20 minutes, plus the one capped call's tokens.
    expect(hostedToolReserve(plan, "gpt-5-mini", "openai").microcents).toBe(
      12 * CENT + costMicrocents("gpt-5-mini", SEARCH_RESULT_TOKEN_ALLOWANCE, 0, "openai")
    );
  });

  it("charges each search and file search, and each container once per call by the minute", () => {
    const plan = hostedToolPlan("openai", { tools: [{ type: "web_search" }, { type: "code_interpreter", container: { type: "auto" } }] })!;
    const use = { webSearch: 2, webFetch: 0, codeExecution: 0, fileSearch: 1, containers: ["c1", "c1", "c2"] };
    // 2 × 1¢ + 1 × 0.25¢ + 2 containers × 5-minute minimum at 1g ($0.0015 a minute).
    expect(hostedToolUseCost("openai", use, plan, 60_000)).toBe(2 * CENT + 0.25 * CENT + 2 * 5 * 150_000);
  });

  it("prices a preview search at $25 per 1k", () => {
    const plan = hostedToolPlan("openai", { tools: [{ type: "web_search_preview" }] })!;
    expect(hostedToolUseCost("openai", { webSearch: 4, webFetch: 0, codeExecution: 0 }, plan, 0)).toBe(4 * 2.5 * CENT);
  });

  it("refuses a reused container under a dollar limit: its memory tier is unknown", () => {
    expect(unpricedRequestOption("openai", { tools: [{ type: "code_interpreter", container: "cntr_1" }] })).toBe("container");
    expect(unpricedRequestOption("openai", { tools: [{ type: "shell", environment: { type: "container_reference", container_id: "c" } }] })).toBe("container");
    expect(unpricedRequestOption("openai", { tools: [{ type: "code_interpreter", container: { type: "auto" } }] })).toBeNull();
  });

  it("counts the tool calls in a Responses body and in its terminal stream event", async () => {
    const response = {
      status: "completed",
      usage: { input_tokens: 10, output_tokens: 5 },
      output: [
        { type: "web_search_call", action: { type: "search" }, status: "completed" },
        { type: "web_search_call", action: { type: "open_page" }, status: "completed" },
        { type: "file_search_call" },
        { type: "code_interpreter_call", container_id: "c1" },
        { type: "shell_call", environment: { type: "container_reference", container_id: "c2" } },
        { type: "message" },
      ],
    };
    expect(usageFromJson("openai", response, "responses").hostedTools).toEqual({
      webSearch: 2, webFetch: 0, codeExecution: 0, fileSearch: 1, containers: ["c1", "c2"],
    });

    const { stream, settled } = createUsageTransform("openai", "responses");
    const reader = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "response.completed", response })}\n\n`));
        c.close();
      },
    }).pipeThrough(stream).getReader();
    while (!(await reader.read()).done) {
      /* drain */
    }
    expect((await settled).usage.hostedTools?.webSearch).toBe(2);
  });

  it("leaves a Responses call with no tool items unchanged", () => {
    expect(usageFromJson("openai", { status: "completed", usage: { input_tokens: 1, output_tokens: 1 }, output: [{ type: "message" }] }, "responses").hostedTools).toBeUndefined();
  });
});

describe("xAI: which hosted tools pass", () => {
  it.each([
    ["web_search", { tools: [{ type: "web_search" }] }],
    ["x_search", { tools: [fn, { type: "x_search" }] }],
    ["code_interpreter", { tools: [{ type: "code_interpreter" }] }],
    ["file_search (collections)", { tools: [{ type: "file_search", vector_store_ids: ["c"] }] }],
  ])("allows %s", (_n, body) => {
    expect(serverSideToolUse("xai", body)).toBeNull();
  });

  it.each([
    ["mcp", { tools: [{ type: "mcp", server_url: "https://x" }] }],
    ["image_generation", { tools: [{ type: "image_generation" }] }],
    ["search_parameters", { search_parameters: { mode: "auto" } }],
  ])("still refuses %s", (_n, body) => {
    expect(serverSideToolUse("xai", body)).not.toBeNull();
  });
});

describe("xAI: hold and charge", () => {
  it("injects nothing: xAI has no per-call cap field", () => {
    const body = { tools: [{ type: "web_search" }] };
    expect(withDefaultToolCaps("xai", body, true)).toBe(body);
  });

  it("holds the default number of calls per tool, X search by an allowance of posts", () => {
    const plan = hostedToolPlan("xai", { tools: [{ type: "web_search" }, { type: "x_search" }] })!;
    const tokens = 2 * DEFAULT_TOOL_CAP * SEARCH_RESULT_TOKEN_ALLOWANCE;
    expect(hostedToolReserve(plan, "grok-4.3", "xai")).toEqual({
      tokens,
      microcents:
        DEFAULT_TOOL_CAP * 0.5 * CENT +
        DEFAULT_TOOL_CAP * X_SEARCH_POSTS_ALLOWANCE * 0.5 * CENT +
        costMicrocents("grok-4.3", tokens, 0, "xai"),
    });
  });

  it("reads tool counts and the exact charge from usage", () => {
    const u = usageFromJson(
      "xai",
      {
        status: "completed",
        usage: {
          input_tokens: 32,
          output_tokens: 9,
          total_tokens: 151,
          cost_in_usd_ticks: 37_756_000,
          server_side_tool_usage_details: { web_search_calls: 1, x_search_calls: 2, x_posts_fetched: 44, x_users_fetched: 3, code_interpreter_calls: 0, file_search_calls: 1 },
        },
      },
      "responses"
    );
    // 37,756,000 ticks is $0.0037756 (the docs' own example), 377,560 microcents.
    expect(u.hostedTools).toEqual({
      webSearch: 1, webFetch: 0, codeExecution: 0, fileSearch: 1, xSearch: 2, xPosts: 44, xUsers: 3, reportedMicrocents: 377_560,
    });
  });

  it("charges posts, profiles and calls, and settles at the larger of computed and reported", () => {
    const use = { webSearch: 1, webFetch: 0, codeExecution: 1, fileSearch: 1, xPosts: 44, xUsers: 3 };
    const tools = 0.5 * CENT + 0.5 * CENT + 0.25 * CENT + 44 * 0.5 * CENT + 3 * CENT;
    expect(hostedToolUseCost("xai", use, null, 0)).toBe(tools);
    expect(totalWithHostedTools("xai", 1_000, use, null, 0)).toBe(1_000 + tools);
    expect(totalWithHostedTools("xai", 1_000, { ...use, reportedMicrocents: 99 * CENT }, null, 0)).toBe(99 * CENT);
  });

  it("leaves Anthropic's total as tokens plus tools, with nothing reported to compare", () => {
    expect(totalWithHostedTools("anthropic", 500, { webSearch: 1, webFetch: 0, codeExecution: 0 }, null, 0)).toBe(500 + CENT);
  });
});

// Live 2026-10-07 (gpt-4.1-mini, buffered and streamed): OpenAI also reports a
// top-level `tool_usage.web_search.num_requests` (1 for one search), which the
// docs read that day did not mention. It is OpenAI's own count, so it is used
// when present; output items remain the fallback.
describe("OpenAI's own web search count", () => {
  it("prefers tool_usage.web_search.num_requests over counting items", () => {
    const u = usageFromJson(
      "openai",
      {
        status: "completed",
        usage: { input_tokens: 8174, output_tokens: 73 },
        tool_usage: { web_search: { num_requests: 1 }, image_gen: { input_tokens: 0, output_tokens: 0 } },
        output: [
          { type: "web_search_call", action: { type: "search" } },
          { type: "web_search_call", action: { type: "open_page" } },
          { type: "message" },
        ],
      },
      "responses"
    );
    expect(u.hostedTools?.webSearch).toBe(1);
  });
});
