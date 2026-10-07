// Package 2, step 4: xAI, through its Responses API only (owner decision P2-5).
//
// Facts pinned here come from xAI's own docs, read 2026-09-27:
//   docs.x.ai/developers/rest-api-reference/inference/responses.md
//   docs.x.ai/developers/rest-api-reference/inference/chat-completions.md
//   docs.x.ai/developers/rest-api-reference/inference/models.md
//   docs.x.ai/developers/models.md (prices)
//
// The load-bearing one is the usage rule. xAI's own example reports
// input 32, output 9, reasoning 110, total 151: reasoning is outside
// `output_tokens` in the example even though the field's description says it is
// inside. Billing output as `total − input` is right under either reading; reading
// `output_tokens` alone would bill 9 tokens for 119 generated.
import { describe, expect, it } from "vitest";
import { PROVIDERS, authHeaders, isProvider, modelListingUrl, requestShapeFamily, upstreamBaseUrl, usesOpenAiUsageShape } from "@/lib/providers";
import { costMicrocents } from "@/lib/pricing";
import { canonicalEndpointPath, endpointAllows, isResponsesEndpoint } from "@/lib/scope";
import { outputLimitShape, requestedOutputTokens } from "@/lib/output-limit";
import { createUsageTransform, usageFromJson } from "@/lib/usage/parseStream";
import { serverSideToolUse } from "@/lib/providers/server-side-tools";
import { buildAlternatives } from "@/lib/providers/alternatives";
import { buildDirectConnectSetup, buildHermesCloudSetup } from "@/lib/direct-connect-config";
import { buildPassportConnectSetup } from "@/lib/passport-connect-config";

const XAI_EXAMPLE_USAGE = {
  input_tokens: 32,
  input_tokens_details: { cached_tokens: 8 },
  output_tokens: 9,
  output_tokens_details: { reasoning_tokens: 110 },
  total_tokens: 151,
  num_sources_used: 0,
  num_server_side_tools_used: 0,
};

describe("xai is a registered provider", () => {
  it("is in PROVIDERS and passes the runtime guard", () => {
    expect(PROVIDERS).toContain("xai");
    expect(isProvider("xai")).toBe(true);
  });

  it("targets api.x.ai with a bearer key", () => {
    expect(upstreamBaseUrl("xai")).toBe("https://api.x.ai");
    expect(modelListingUrl("xai")).toBe("https://api.x.ai/v1/models");
    expect(authHeaders("xai", "xai-key")).toEqual({ authorization: "Bearer xai-key" });
  });

  it("takes OpenAI-style request bodies but not the chat usage shape", () => {
    expect(requestShapeFamily("xai")).toBe("openai");
    expect(usesOpenAiUsageShape("xai")).toBe(false);
  });
});

describe("xai endpoints: Responses and model discovery only", () => {
  it.each([[["responses"]], [["v1", "responses"]]])("serves POST /%s at /v1/responses", (path) => {
    expect(canonicalEndpointPath("xai", "POST", path)).toEqual(["v1", "responses"]);
    expect(isResponsesEndpoint("xai", ["v1", "responses"])).toBe(true);
  });

  it("serves model listing and retrieval", () => {
    expect(canonicalEndpointPath("xai", "GET", ["models"])).toEqual(["v1", "models"]);
    expect(canonicalEndpointPath("xai", "GET", ["v1", "models"])).toEqual(["v1", "models"]);
    expect(canonicalEndpointPath("xai", "GET", ["v1", "models", "grok-4.7"])).toEqual(["v1", "models", "grok-4.7"]);
  });

  it("does not serve xAI's legacy Chat Completions, or anything else", () => {
    for (const path of [["chat", "completions"], ["v1", "chat", "completions"], ["v1", "embeddings"], ["v1", "responses", "resp_1"]]) {
      expect(endpointAllows("xai", "POST", path)).toBe(false);
    }
    expect(endpointAllows("xai", "GET", ["v1", "responses", "resp_1"])).toBe(false);
    expect(endpointAllows("xai", "DELETE", ["v1", "responses", "resp_1"])).toBe(false);
  });

  it("keeps OpenAI Responses a responses endpoint", () => {
    expect(isResponsesEndpoint("openai", ["v1", "responses"])).toBe(true);
    expect(isResponsesEndpoint("groq", ["v1", "responses"])).toBe(false);
  });
});

describe("the output ceiling reads the field xAI honours", () => {
  it("uses max_output_tokens, which xAI documents as covering reasoning", () => {
    expect(outputLimitShape("xai", ["v1", "responses"])).toBe("openai_responses");
    expect(requestedOutputTokens("openai_responses", { max_output_tokens: 500 })).toEqual({ kind: "stated", tokens: 500 });
  });

  it("does not accept max_tokens as a limit on an xAI Responses call", () => {
    const shape = outputLimitShape("xai", ["v1", "responses"]);
    expect(requestedOutputTokens(shape, { max_tokens: 10 })).toEqual({ kind: "absent" });
  });
});

describe("xai usage: output is everything generated, total − input", () => {
  it("bills xAI's own example at 119 output tokens, not 9", () => {
    const usage = usageFromJson("xai", { status: "completed", usage: XAI_EXAMPLE_USAGE }, "responses");
    expect(usage).toMatchObject({ inputTokens: 32, outputTokens: 119, sawUsage: true, complete: true });
  });

  it("keeps output_tokens when it is the larger figure", () => {
    const usage = usageFromJson(
      "xai",
      { status: "completed", usage: { input_tokens: 10, output_tokens: 50, total_tokens: 40 } },
      "responses"
    );
    expect(usage.outputTokens).toBe(50);
  });

  it.each([
    ["no total_tokens", { input_tokens: 32, output_tokens: 9 }],
    ["no input_tokens", { output_tokens: 9, total_tokens: 151 }],
    ["no output_tokens", { input_tokens: 32, total_tokens: 151 }],
    ["a negative total", { input_tokens: 32, output_tokens: 9, total_tokens: -1 }],
  ])("is incomplete with %s", (_name, usage) => {
    expect(usageFromJson("xai", { status: "completed", usage }, "responses").complete).toBe(false);
  });

  it("is incomplete when the response did not complete", () => {
    expect(usageFromJson("xai", { status: "incomplete", usage: XAI_EXAMPLE_USAGE }, "responses").complete).toBe(false);
  });

  it("leaves OpenAI Responses billing exactly as it was", () => {
    const usage = usageFromJson(
      "openai",
      { status: "completed", usage: { input_tokens: 32, output_tokens: 9, total_tokens: 151 } },
      "responses"
    );
    expect(usage).toMatchObject({ inputTokens: 32, outputTokens: 9, complete: true });
  });

  async function streamed(provider: "xai" | "openai", events: object[]) {
    const { stream, settled } = createUsageTransform(provider, "responses");
    const body = events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
    const source = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(body));
        c.close();
      },
    });
    await new Response(source.pipeThrough(stream)).text();
    return settled;
  }

  it("applies the same rule to a streamed response.completed", async () => {
    const result = await streamed("xai", [
      { type: "response.created", response: { status: "in_progress" } },
      { type: "response.completed", response: { status: "completed", usage: XAI_EXAMPLE_USAGE } },
    ]);
    expect(result).toMatchObject({ usage: { inputTokens: 32, outputTokens: 119 }, complete: true });
  });

  it("does not call a streamed response.incomplete complete, and still bills what it reported", async () => {
    const result = await streamed("xai", [
      { type: "response.incomplete", response: { status: "incomplete", usage: XAI_EXAMPLE_USAGE } },
    ]);
    expect(result.complete).toBe(false);
    expect(result.usage.outputTokens).toBe(119);
  });
});

describe("unpriced server-side tools are refused", () => {
  it.each([
    ["no tools", {}],
    ["an empty tools list", { tools: [] }],
    ["function tools only", { tools: [{ type: "function", name: "f", parameters: {} }] }],
    // Priced since DECISIONS 2026-10-07 (tests/hosted-tools-openai-xai.test.ts).
    ["web_search (priced)", { tools: [{ type: "web_search" }] }],
    ["x_search (priced)", { tools: [{ type: "function", name: "f" }, { type: "x_search" }] }],
    ["code_interpreter (priced)", { tools: [{ type: "code_interpreter" }] }],
  ])("allows %s", (_name, body) => {
    expect(serverSideToolUse("xai", body)).toBeNull();
  });

  it.each([
    ["mcp", { tools: [{ type: "mcp", server_url: "https://x" }] }],
    ["a tool with no type", { tools: [{ name: "f" }] }],
    ["a non-object tool", { tools: ["web_search"] }],
    ["tools that are not a list", { tools: { type: "function" } }],
    ["search_parameters", { search_parameters: { mode: "auto" } }],
    ["search_parameters even when off", { search_parameters: { mode: "off" } }],
  ])("refuses %s", (_name, body) => {
    expect(serverSideToolUse("xai", body)).toEqual(expect.any(String));
  });
});

describe("xai prices (docs.x.ai/developers/models.md, read 2026-09-27)", () => {
  // The ≥200k-prompt rates, as for Gemini 2.5 Pro: xAI bills every token of a
  // request at the higher rate once its prompt crosses 200k, and a flat table
  // that used the lower rate would under-reserve every long prompt.
  it.each([
    ["grok-4.7", 4, 12],
    ["grok-4.6", 4, 12],
    ["grok-4.5", 4, 12],
    ["grok-4.3", 2.5, 5],
    ["grok-4.20-0309-reasoning", 2.5, 5],
    ["grok-4.20-0309-non-reasoning", 2.5, 5],
    ["grok-4.20-multi-agent-0309", 2.5, 5],
    ["grok-build-0.1", 2, 4],
  ])("prices %s at $%s in / $%s out per 1M", (model, input, output) => {
    expect(costMicrocents(model, 1_000_000, 0, "xai")).toBe(input * 100 * 1_000_000);
    expect(costMicrocents(model, 0, 1_000_000, "xai")).toBe(output * 100 * 1_000_000);
  });

  it("prices an unlisted Grok model at the most expensive listed rate", () => {
    expect(costMicrocents("grok-9", 1_000_000, 1_000_000, "xai")).toBe((4 + 12) * 100 * 1_000_000);
  });
});

describe("xai alternatives and onboarding", () => {
  it("offers xAI as an alternative to a failed Responses call, and not to a failed chat call", () => {
    const base = {
      scopes: [
        { provider: "openai", models: ["gpt-*"] },
        { provider: "xai", models: ["grok-*"] },
      ],
      providersWithKeys: ["openai", "xai"],
      failing: "openai" as const,
      method: "POST",
    };
    expect(buildAlternatives({ ...base, path: ["v1", "responses"] })).toEqual([
      expect.objectContaining({ provider: "xai", path: "/v1/xai/responses" }),
    ]);
    expect(buildAlternatives({ ...base, path: ["v1", "chat", "completions"] })).toEqual([]);
  });

  it("gives an xAI key a Responses example and smoke test, never a chat call it would refuse", () => {
    const setup = buildDirectConnectSetup({ origin: "https://gw.test", provider: "xai", key: "pc-key", model: "grok-4.3" });
    expect(setup.example).toContain("client.responses.create");
    expect(setup.example).not.toContain("chat.completions");
    expect(setup.smokeCommand).toContain("https://gw.test/api/v1/xai/v1/responses");
    expect(setup.smokeCommand).not.toContain("chat/completions");
    expect(setup.envBlock).toContain("OPENAI_BASE_URL=https://gw.test/api/v1/xai/v1");
  });

  it("gives an xAI passport a Responses smoke test", () => {
    const setup = buildPassportConnectSetup({ origin: "https://gw.test", provider: "xai", passportId: "pp_1", passportSecret: "secret", model: "grok-4.3" });
    expect(setup.smokeCode).toContain("client.responses.create");
    expect(setup.smokeCode).not.toContain("chat.completions");
  });

  it("does not offer Hermes, which speaks only Chat Completions, for xAI", () => {
    expect(buildHermesCloudSetup({ origin: "https://gw.test", provider: "xai", key: "k", model: "grok-4.3" })).toBeNull();
  });
});
