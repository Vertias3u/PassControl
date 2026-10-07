// OpenAI's hosted tools are billed per call or per session, outside token usage
// (developers.openai.com/api/docs/pricing, read 2026-09-27: web search $10 per 1k
// calls, file search $2.50 per 1k calls, code interpreter containers per
// 20-minute session). A budget that counts tokens cannot hold those charges, so a
// request that could incur one is refused before anything is reserved or sent.
// Owner decision, 2026-09-27.
//
// Deny-by-default. The allowed tool types are the ones the AGENT executes, taken
// from the installed SDK's `Tool` union (openai 6.49.0,
// resources/responses/responses.d.ts); anything else, including a type OpenAI adds
// later, is refused.
import { describe, expect, it } from "vitest";
import { evaluateGate, type GateInput } from "@/lib/gate";
import { serverSideToolUse } from "@/lib/providers/server-side-tools";

const fn = { type: "function", name: "lookup", parameters: { type: "object" } };

describe("OpenAI: client-executed tools pass", () => {
  it.each([
    ["no tools", {}],
    ["an empty list", { tools: [] }],
    ["a null tools value", { tools: null }],
    ["function", { tools: [fn] }],
    ["custom", { tools: [{ type: "custom", name: "grammar" }] }],
    ["a namespace of functions and custom tools", { tools: [{ type: "namespace", name: "ns", description: "d", tools: [fn, { type: "custom", name: "c" }] }] }],
    ["computer", { tools: [{ type: "computer" }] }],
    ["computer_use_preview", { tools: [{ type: "computer_use_preview", display_width: 1, display_height: 1, environment: "browser" }] }],
    ["local_shell", { tools: [{ type: "local_shell" }] }],
    ["apply_patch", { tools: [{ type: "apply_patch" }] }],
    ["shell on the local environment", { tools: [{ type: "shell", environment: { type: "local" } }] }],
    ["tool_search executed by the client", { tools: [{ type: "tool_search", execution: "client" }] }],
    // Priced since DECISIONS 2026-10-07 (tests/hosted-tools-openai-xai.test.ts).
    ["web_search (priced)", { tools: [{ type: "web_search" }] }],
    ["web_search_preview (priced)", { tools: [{ type: "web_search_preview" }] }],
    ["a dated web_search_preview (priced)", { tools: [{ type: "web_search_preview_2025_03_11" }] }],
    ["file_search (priced)", { tools: [{ type: "file_search", vector_store_ids: ["vs_1"] }] }],
    ["code_interpreter (priced)", { tools: [{ type: "code_interpreter", container: { type: "auto" } }] }],
    ["shell in a hosted container (priced)", { tools: [{ type: "shell", environment: { type: "container_auto" } }] }],
  ])("allows %s", (_name, body) => {
    expect(serverSideToolUse("openai", body)).toBeNull();
  });
});

describe("OpenAI: unpriced hosted tools and anything ambiguous are refused", () => {
  it.each([
    ["image_generation", { tools: [{ type: "image_generation" }] }],
    ["mcp", { tools: [{ type: "mcp", server_label: "s", server_url: "https://x" }] }],
    ["programmatic_tool_calling", { tools: [{ type: "programmatic_tool_calling" }] }],
    ["shell with no environment", { tools: [{ type: "shell" }] }],
    ["shell with a null environment", { tools: [{ type: "shell", environment: null }] }],
    ["tool_search executed by the server", { tools: [{ type: "tool_search", execution: "server" }] }],
    ["tool_search with no execution stated", { tools: [{ type: "tool_search" }] }],
    ["a namespace wrapping web_search", { tools: [{ type: "namespace", name: "ns", description: "d", tools: [fn, { type: "web_search" }] }] }],
    ["a namespace with no tools list", { tools: [{ type: "namespace", name: "ns", description: "d" }] }],
    ["an unpriced hosted tool after a function", { tools: [fn, { type: "image_generation" }] }],
    ["an unknown type", { tools: [{ type: "something_new" }] }],
    ["a tool with no type", { tools: [{ name: "f" }] }],
    ["a non-object tool", { tools: ["web_search"] }],
    ["tools that are not a list", { tools: { type: "function" } }],
    ["chat web_search_options", { web_search_options: {} }],
    ["a stored prompt, whose tools PassControl cannot see", { prompt: { id: "pmpt_1" } }],
  ])("refuses %s", (_name, body) => {
    expect(serverSideToolUse("openai", body)).toEqual(expect.any(String));
  });
});

// Anthropic gained a rule on 2026-10-07: tests/anthropic-server-side-tools.test.ts.
describe("providers without a rule", () => {
  it.each(["groq", "mistral", "together", "deepseek", "gemini"])(
    "leaves %s requests alone",
    (provider) => {
      expect(serverSideToolUse(provider, { tools: [{ type: "web_search" }], web_search_options: {} })).toBeNull();
    }
  );

  it("does not treat a non-object body as a tool request", () => {
    expect(serverSideToolUse("openai", null)).toBeNull();
    expect(serverSideToolUse("openai", [])).toBeNull();
    expect(serverSideToolUse("openai", "x")).toBeNull();
  });
});

const AT = new Date("2026-07-27T10:00:00.000Z");
function chatInput(model: string, overrides: Partial<GateInput> = {}): GateInput {
  return {
    agentId: "agent-a",
    killState: { platformKill: false, userKill: false, denylist: [] },
    suspended: false,
    scopes: [{ provider: "openai", models: ["gpt-*"] }],
    provider: "openai",
    method: "POST",
    path: ["v1", "chat", "completions"],
    model,
    policy: { kind: "value", value: {} },
    policyFailClosed: false,
    now: AT,
    ...overrides,
  };
}

describe("OpenAI search models search on every call, with no tool in the request", () => {
  it.each([
    "gpt-4o-search-preview",
    "gpt-4o-mini-search-preview",
    "gpt-4o-search-preview-2025-03-11",
    "gpt-4o-mini-search-preview-2025-03-11",
    // Case is not trusted to be significant upstream.
    "GPT-4o-Search-Preview",
  ])("refuses %s at the endpoint step, so the trace and failover agree", (model) => {
    // A wildcard scope, so the model reaches the endpoint step whatever its case.
    const result = evaluateGate(chatInput(model, { scopes: [{ provider: "openai", models: ["*"] }] }));
    expect(result.deniedBy).toBe("endpoint");
    expect(result.steps.find((s) => s.name === "endpoint")?.rule).toBe("endpoint:openai_search_model");
  });

  it("leaves ordinary OpenAI models and other providers alone", () => {
    expect(evaluateGate(chatInput("gpt-4o")).deniedBy).toBeUndefined();
    expect(evaluateGate(chatInput("gpt-4.1-mini")).deniedBy).toBeUndefined();
    expect(
      evaluateGate(
        chatInput("some-search-preview", { provider: "groq", scopes: [{ provider: "groq", models: ["*"] }] })
      ).deniedBy
    ).toBeUndefined();
  });

  it("leaves model listing alone", () => {
    expect(
      evaluateGate(chatInput("", { method: "GET", path: ["v1", "models", "gpt-4o-search-preview"] })).deniedBy
    ).toBeUndefined();
  });
});
