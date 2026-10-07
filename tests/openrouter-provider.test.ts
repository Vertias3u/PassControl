// 1.3.0 #4: OpenRouter as a provider (plans/openrouter.md; DECISIONS 2026-10-07).
//
// Facts pinned here were read first-hand on 2026-10-07:
//   openrouter.ai/docs/cookbook/administration/usage-accounting — `usage.cost` in USD on
//     every response, on the last SSE chunk when streaming; `cost_details.upstream_inference_cost`
//   openrouter.ai/docs/guides/overview/auth/byok — a BYOK call's `cost` is OpenRouter's fee only; the
//     inference itself is billed to the user's own provider account
//   openrouter.ai/docs/guides/routing/provider-selection — `provider.max_price` in USD per
//     million tokens "will prevent your request from running if the price is not available"
//   openrouter.ai/docs/api_reference/errors-and-debugging — 402 insufficient credits; a
//     mid-stream error is a 200 chunk with `finish_reason: "error"`
//   GET openrouter.ai/api/v1/models/{id}/endpoints — the fixtures in tests/fixtures/openrouter
//
// The owner's choices: settle at OpenRouter's reported cost (plus the upstream bill on
// BYOK), hold at the dearest endpoint and inject that as `max_price`, send PassControl's
// attribution headers and never the client's.
import { describe, expect, it } from "vitest";
import llama from "./fixtures/openrouter/meta-llama_llama-3.3-70b-instruct.endpoints.json";
import sonnet from "./fixtures/openrouter/anthropic_claude-sonnet-4.5.endpoints.json";
import gemmaFree from "./fixtures/openrouter/google_gemma-4-31b-it_free.endpoints.json";
import {
  PROVIDERS,
  authHeaders,
  detectProviderFromKey,
  isProvider,
  modelListingUrl,
  providerAttributionHeaders,
  requestShapeFamily,
  upstreamBaseUrl,
  usesOpenAiUsageShape,
} from "@/lib/providers";
import {
  OPENROUTER_FREE_ROUTER,
  openrouterCeiling,
  openrouterEndpointsUrl,
  openrouterHoldMicrocents,
  openrouterModelSelectionField,
  openrouterReportedMicrocents,
  isOpenRouterModelRouter,
  usdToMicrocents,
  withMaxPrice,
} from "@/lib/providers/openrouter";
import { canonicalEndpointPath, endpointAllows } from "@/lib/scope";
import { serverSideToolUse, isServerSideSearchModel } from "@/lib/providers/server-side-tools";
import { classifyUpstreamFailure } from "@/lib/providers/exhaustion";
import { createUsageTransform, usageFromJson } from "@/lib/usage/parseStream";
import { outputLimitShape } from "@/lib/output-limit";
import { filterModelListingToScope } from "@/lib/providers/model-listing";

describe("openrouter is a registered provider", () => {
  it("is in PROVIDERS and passes the runtime guard", () => {
    expect(PROVIDERS).toContain("openrouter");
    expect(isProvider("openrouter")).toBe(true);
  });

  it("targets openrouter.ai/api with a bearer key, and lists models at /api/v1/models", () => {
    expect(upstreamBaseUrl("openrouter")).toBe("https://openrouter.ai/api");
    expect(modelListingUrl("openrouter")).toBe("https://openrouter.ai/api/v1/models");
    expect(authHeaders("openrouter", "sk-or-v1-abc")).toEqual({ authorization: "Bearer sk-or-v1-abc" });
  });

  it("speaks Chat Completions, usage included", () => {
    expect(requestShapeFamily("openrouter")).toBe("openai");
    expect(usesOpenAiUsageShape("openrouter")).toBe(true);
    expect(outputLimitShape("openrouter", ["v1", "chat", "completions"])).toBe("chat_completions");
  });

  it("recognises an sk-or- key before the generic sk- family", () => {
    expect(detectProviderFromKey("sk-or-v1-0123456789abcdef")).toEqual({
      suggested: "openrouter",
      candidates: ["openrouter"],
      ambiguous: false,
    });
    expect(detectProviderFromKey("sk-abc").candidates).not.toContain("openrouter");
  });

  it("sends PassControl's attribution, and only for openrouter (owner decision D3)", () => {
    expect(providerAttributionHeaders("openrouter")).toEqual({
      "http-referer": "https://github.com/Vertias3u/PassControl",
      "x-title": "PassControl",
    });
    expect(providerAttributionHeaders("openai")).toEqual({});
  });
});

describe("openrouter endpoints: chat and the model list only", () => {
  it.each([[["chat", "completions"]], [["v1", "chat", "completions"]]])("serves POST /%s", (path) => {
    expect(canonicalEndpointPath("openrouter", "POST", path)).toEqual(["v1", "chat", "completions"]);
  });

  it.each([[["models"]], [["v1", "models"]]])("serves GET /%s", (path) => {
    expect(canonicalEndpointPath("openrouter", "GET", path)).toEqual(["v1", "models"]);
  });

  // Management first: an endpoint that mints keys or moves credits behind a gateway
  // that holds the account's key is the worst thing this allowlist could miss.
  it.each([
    ["POST", ["v1", "keys"]],
    ["GET", ["v1", "keys"]],
    ["GET", ["v1", "key"]],
    ["GET", ["v1", "credits"]],
    ["POST", ["v1", "auth", "keys"]],
    ["POST", ["v1", "byok"]],
    ["GET", ["v1", "workspaces"]],
    ["GET", ["v1", "generation"]],
    ["POST", ["v1", "batches"]],
    ["POST", ["v1", "embeddings"]],
    ["POST", ["v1", "responses"]],
    ["POST", ["v1", "messages"]],
    ["POST", ["v1", "completions"]],
    ["GET", ["v1", "models", "meta-llama", "llama-3.3-70b-instruct", "endpoints"]],
  ])("refuses %s /%s", (method, path) => {
    expect(endpointAllows("openrouter", method, path)).toBe(false);
  });
});

describe("dollars to microcents", () => {
  it.each([
    [0, 0],
    [0.1, 10_000_000],
    [0.95, 95_000_000],
    [19.95, 1_995_000_000],
    [1.3386e-5, 1339],
    [0.000013386, 1339],
    ["0.00000022", 22],
    ["0.0000000025", 1],
    [1e-12, 1],
  ])("%s USD is %s µ¢, rounded up and never down", (usd, microcents) => {
    expect(usdToMicrocents(usd)).toBe(microcents);
  });

  it.each([[-0.01], [Number.NaN], [Number.POSITIVE_INFINITY], ["abc"], [""], [null], [undefined], [{}], ["1e400"], [1e12]])(
    "refuses %s",
    (value) => {
      expect(usdToMicrocents(value as never)).toBeNull();
    }
  );
});

describe("the reported cost (owner decision D1)", () => {
  it("is `cost` for an ordinary call", () => {
    expect(openrouterReportedMicrocents({ cost: 0.0001, is_byok: false })).toBe(10_000);
    expect(
      openrouterReportedMicrocents({ cost: 0.0001, is_byok: false, cost_details: { upstream_inference_cost: null } })
    ).toBe(10_000);
  });

  it("does not add the upstream figure to a call OpenRouter says was not BYOK", () => {
    expect(
      openrouterReportedMicrocents({ cost: 0.0001, is_byok: false, cost_details: { upstream_inference_cost: 0.0001 } })
    ).toBe(10_000);
  });

  it("adds the upstream bill on a BYOK call, where `cost` is only OpenRouter's fee", () => {
    // The docs' own example: cost 0.95, upstream 19.
    expect(
      openrouterReportedMicrocents({ cost: 0.95, is_byok: true, cost_details: { upstream_inference_cost: 19 } })
    ).toBe(1_995_000_000);
  });

  it("charges both when it cannot tell whether the call was BYOK", () => {
    // The safe direction: an unmarked call with an upstream figure may be BYOK.
    expect(openrouterReportedMicrocents({ cost: 0.95, cost_details: { upstream_inference_cost: 19 } })).toBe(
      1_995_000_000
    );
    expect(openrouterReportedMicrocents({ cost: 0.95, cost_details: { upstream_inference_cost: 0 } })).toBe(95_000_000);
  });

  it("is unknown without a readable cost, or on BYOK without a readable upstream bill", () => {
    expect(openrouterReportedMicrocents({})).toBeNull();
    expect(openrouterReportedMicrocents({ cost: "0.1" })).toBeNull();
    expect(openrouterReportedMicrocents({ cost: -1 })).toBeNull();
    expect(openrouterReportedMicrocents({ cost: 0.95, is_byok: true })).toBeNull();
    expect(openrouterReportedMicrocents({ cost: 0.95, is_byok: true, cost_details: { upstream_inference_cost: "19" } })).toBeNull();
    expect(openrouterReportedMicrocents(null)).toBeNull();
  });
});

describe("the hold's price: the dearest endpoint (owner decision D2)", () => {
  it("takes the highest rate across every endpoint, not the listing's", () => {
    // Listing shows $0.22/$0.50 (Parasail); the dearest endpoints are $1.04/M in, $2.253/M out.
    expect(openrouterCeiling(llama.endpoints)).toEqual({
      inputMicrocentsPerToken: 104,
      outputMicrocentsPerToken: 226,
      requestMicrocents: 0,
      imageMicrocents: 0,
    });
  });

  it("includes long-prompt tiers and cache writes", () => {
    const c = openrouterCeiling(sonnet.endpoints)!;
    expect(c.inputMicrocentsPerToken).toBe(1320);
    expect(c.outputMicrocentsPerToken).toBe(2475);
  });

  it("is zero for a free model", () => {
    expect(openrouterCeiling(gemmaFree.endpoints)).toEqual({
      inputMicrocentsPerToken: 0,
      outputMicrocentsPerToken: 0,
      requestMicrocents: 0,
      imageMicrocents: 0,
    });
  });

  it("counts a per-request and a per-image price", () => {
    const c = openrouterCeiling([{ pricing: { prompt: "0.000001", completion: "0.000002", request: "0.005", image: "0.001" } }]);
    expect(c).toEqual({ inputMicrocentsPerToken: 100, outputMicrocentsPerToken: 200, requestMicrocents: 500_000, imageMicrocents: 100_000 });
  });

  it.each([
    ["no endpoints (an alias or a router)", []],
    ["a variable price", [{ pricing: { prompt: "-1", completion: "-1" } }]],
    ["an unreadable price", [{ pricing: { prompt: "abc", completion: "0.000001" } }]],
    ["a missing completion price", [{ pricing: { prompt: "0.000001" } }]],
    ["a price dimension it does not know", [{ pricing: { prompt: "0", completion: "0", per_second: "0.01" } }]],
    ["a malformed endpoint", [null]],
  ])("cannot price %s", (_label, endpoints) => {
    expect(openrouterCeiling(endpoints as never)).toBeNull();
  });

  it("ignores price dimensions for things this gateway refuses, and a discount", () => {
    expect(
      openrouterCeiling([{ pricing: { prompt: "0.000001", completion: "0.000002", web_search: "0.01", discount: 0.1 } }])
    ).toMatchObject({ inputMicrocentsPerToken: 100, outputMicrocentsPerToken: 200 });
  });

  it("prices a hold from the estimate, the request fee and each image", () => {
    const ceiling = { inputMicrocentsPerToken: 100, outputMicrocentsPerToken: 200, requestMicrocents: 500, imageMicrocents: 1000 };
    const body = {
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: "x" } }, { type: "image_url", image_url: { url: "y" } }] },
      ],
    };
    expect(openrouterHoldMicrocents(ceiling, { inputTokens: 10, outputTokens: 20 }, body)).toBe(10 * 100 + 20 * 200 + 500 + 2 * 1000);
  });

  it("looks the price up at the model's own endpoints listing", () => {
    expect(openrouterEndpointsUrl("meta-llama/llama-3.3-70b-instruct:nitro")).toBe(
      "https://openrouter.ai/api/v1/models/meta-llama/llama-3.3-70b-instruct:nitro/endpoints"
    );
    expect(openrouterEndpointsUrl("google/gemma-4-31b-it:free")).toBe(
      "https://openrouter.ai/api/v1/models/google/gemma-4-31b-it:free/endpoints"
    );
  });

  it.each([["no-slash"], ["a/b/c"], ["../x/y"], ["a/b?x=1"], ["a/b#x"], ["a /b"], [""], ["a/" + "b".repeat(200)]])(
    "never builds a lookup from %s",
    (model) => {
      expect(openrouterEndpointsUrl(model)).toBeNull();
    }
  );
});

describe("max_price: OpenRouter cannot route above the hold", () => {
  const ceiling = { inputMicrocentsPerToken: 104, outputMicrocentsPerToken: 226, requestMicrocents: 0, imageMicrocents: 0 };

  it("injects the held rates in USD per million tokens", () => {
    expect(withMaxPrice({ model: "m" }, ceiling)).toEqual({ model: "m", provider: { max_price: { prompt: 1.04, completion: 2.26 } } });
  });

  it("caps a per-request and per-image price when the model has one", () => {
    const c = { ...ceiling, requestMicrocents: 500_000, imageMicrocents: 100_000 };
    expect(withMaxPrice({}, c).provider).toEqual({ max_price: { prompt: 1.04, completion: 2.26, request: 0.005, image: 0.001 } });
  });

  it("keeps the client's own ceiling where it is lower, and its other routing choices", () => {
    const out = withMaxPrice({ provider: { order: ["groq"], max_price: { prompt: 0.5, completion: 9 } } }, ceiling);
    expect(out.provider).toEqual({ order: ["groq"], max_price: { prompt: 0.5, completion: 2.26 } });
  });

  it("is zero for a free model", () => {
    expect(withMaxPrice({}, { inputMicrocentsPerToken: 0, outputMicrocentsPerToken: 0, requestMicrocents: 0, imageMicrocents: 0 }).provider).toEqual({
      max_price: { prompt: 0, completion: 0 },
    });
  });

  it("does not change the body it was given", () => {
    const body = { provider: { max_price: { prompt: 9 } } };
    withMaxPrice(body, ceiling);
    expect(body).toEqual({ provider: { max_price: { prompt: 9 } } });
  });
});

describe("fields that pick a model behind `model`'s back are refused", () => {
  it.each([
    [{ models: ["openai/gpt-5"] }, "models"],
    [{ route: "fallback" }, "route"],
    [{ preset: "@preset/x" }, "preset"],
    [{ debug: { echo_upstream_body: true } }, "debug"],
    [{ provider: "groq" }, "provider"],
    [{ provider: { max_price: "1" } }, "provider.max_price"],
  ])("%j → %s", (body, field) => {
    expect(openrouterModelSelectionField(body)).toBe(field);
  });

  it("lets an ordinary body and its routing preferences through", () => {
    expect(openrouterModelSelectionField({ model: "x/y", messages: [], provider: { order: ["groq"], sort: "price" } })).toBeNull();
  });

  it.each([["openrouter/auto"], ["openrouter/fusion"], ["openrouter/pareto-code"], ["@preset/mine"], ["openai/gpt-4@preset/mine"], ["OpenRouter/Auto"]])(
    "%s is a router or a preset",
    (model) => {
      expect(isOpenRouterModelRouter(model)).toBe(true);
    }
  );

  it("treats the free router as a model: it only ever picks a $0 one", () => {
    expect(OPENROUTER_FREE_ROUTER).toBe("openrouter/free");
    expect(isOpenRouterModelRouter("openrouter/free")).toBe(false);
    expect(isOpenRouterModelRouter("meta-llama/llama-3.3-70b-instruct:nitro")).toBe(false);
  });
});

describe("tools OpenRouter runs itself are refused (until priced)", () => {
  it("passes function tools", () => {
    expect(serverSideToolUse("openrouter", { tools: [{ type: "function", function: { name: "f" } }] })).toBeNull();
  });

  it.each([["openrouter:web_search"], ["openrouter:advisor"], ["openrouter:subagent"], ["openrouter:fusion"], ["openrouter:datetime"], ["web_search"]])(
    "refuses a %s tool",
    (type) => {
      expect(serverSideToolUse("openrouter", { tools: [{ type }] })).toBe("tools[0].type");
    }
  );

  it.each([["plugins"], ["web_search_options"], ["stop_server_tools_when"], ["x_search_filter"]])("refuses `%s`", (field) => {
    expect(serverSideToolUse("openrouter", { [field]: [{ id: "web" }] })).toBe(field);
  });

  it("refuses the :online suffix, which is the web plugin", () => {
    expect(isServerSideSearchModel("openrouter", "openai/gpt-5-mini:online")).toBe(true);
    expect(isServerSideSearchModel("openrouter", "openai/gpt-5-mini")).toBe(false);
    expect(isServerSideSearchModel("openrouter", "perplexity/sonar")).toBe(false);
  });
});

describe("402 means the account is out of credits", () => {
  it("is credit exhaustion", () => {
    const body = JSON.stringify({ error: { code: 402, message: "Insufficient credits. Add more using https://openrouter.ai/credits" } });
    expect(classifyUpstreamFailure("openrouter", 402, body)).toBe("credit_exhausted");
    expect(classifyUpstreamFailure("openrouter", 429, JSON.stringify({ error: { code: 429, message: "Rate limit exceeded" } }))).toBeNull();
  });
});

describe("usage: OpenRouter's reported cost", () => {
  const USAGE = {
    prompt_tokens: 194,
    completion_tokens: 2,
    total_tokens: 196,
    cost: 0.000095,
    is_byok: false,
    prompt_tokens_details: { cached_tokens: 0 },
    cost_details: { upstream_inference_cost: null },
  };

  it("reads a buffered response, cost included", () => {
    const u = usageFromJson("openrouter", { id: "gen-1", model: "x/y", choices: [{ finish_reason: "stop" }], usage: USAGE });
    expect(u).toMatchObject({ inputTokens: 194, outputTokens: 2, reportedMicrocents: 9500, sawUsage: true, complete: true });
  });

  it("is incomplete without a readable cost", () => {
    const { cost: _c, ...noCost } = USAGE;
    const u = usageFromJson("openrouter", { choices: [{ finish_reason: "stop" }], usage: noCost });
    expect(u.complete).toBe(false);
    expect(u.reportedMicrocents).toBeUndefined();
  });

  it("is incomplete on a 200 that carries only an error", () => {
    const u = usageFromJson("openrouter", { id: "gen-1", error: { code: 502, message: "upstream died" } });
    expect(u.complete).toBe(false);
  });

  it("leaves every other provider without a reported cost", () => {
    expect(usageFromJson("openai", { usage: { ...USAGE } }).reportedMicrocents).toBeUndefined();
  });

  async function stream(chunks: string[]) {
    const { stream, settled } = createUsageTransform("openrouter");
    const reader = new ReadableStream<Uint8Array>({
      start(c) {
        for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
        c.close();
      },
    })
      .pipeThrough(stream)
      .getReader();
    while (!(await reader.read()).done) {
      /* drain */
    }
    return settled;
  }

  const content = (text: string) =>
    `data: ${JSON.stringify({ id: "gen-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`;

  it("reads the cost off the final chunk, past OpenRouter's keep-alive comments", async () => {
    const out = await stream([
      ": OPENROUTER PROCESSING\n\n",
      content("Hel"),
      ": OPENROUTER PROCESSING\n\n",
      content("lo"),
      `data: ${JSON.stringify({ id: "gen-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
      `data: ${JSON.stringify({ id: "gen-1", object: "chat.completion.chunk", choices: [], usage: USAGE })}\n\n`,
      "data: [DONE]\n\n",
    ]);
    expect(out.usage).toMatchObject({ inputTokens: 194, outputTokens: 2, reportedMicrocents: 9500 });
    expect(out.complete).toBe(true);
  });

  // Captured live 2026-10-07 through PassControl (openrouter/free, served by Nvidia):
  // the usage rides on a chunk whose choice has FINISHED, not on a `choices: []` chunk.
  // Requiring an empty `choices` called this call unknown and charged its reservation.
  it("reads usage off a finished-choice chunk, as OpenRouter actually sends it", async () => {
    const live = {
      id: "gen-1791371418-hYWGUp5Fhn3VrcLVUkDE",
      object: "chat.completion.chunk",
      created: 1791371418,
      model: "nvidia/nemotron-3-super-120b-a12b:free",
      provider: "Nvidia",
      service_tier: null,
      choices: [{ index: 0, delta: { content: "", role: "assistant" }, finish_reason: "stop", native_finish_reason: "stop" }],
      usage: {
        prompt_tokens: 27,
        completion_tokens: 53,
        total_tokens: 80,
        cost: 0,
        is_byok: false,
        prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0, audio_tokens: 0, video_tokens: 0 },
        cost_details: { upstream_inference_cost: 0, upstream_inference_prompt_cost: 0, upstream_inference_completions_cost: 0 },
        completion_tokens_details: { reasoning_tokens: 37, image_tokens: 0, audio_tokens: 0 },
      },
    };
    const out = await stream([
      content(" 5"),
      `data: ${JSON.stringify({ ...live, usage: undefined, choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }] })}\n\n`,
      `data: ${JSON.stringify(live)}\n\n`,
      "data: [DONE]\n\n",
    ]);
    expect(out.usage).toMatchObject({ inputTokens: 27, outputTokens: 53, reportedMicrocents: 0 });
    expect(out.complete).toBe(true);
  });

  it("does not take a usage report as final when content follows it", async () => {
    const out = await stream([
      `data: ${JSON.stringify({ id: "gen-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: USAGE })}\n\n`,
      content("late"),
      "data: [DONE]\n\n",
    ]);
    expect(out.complete).toBe(false);
  });

  it("does not take a usage report on an unfinished chunk as final", async () => {
    const out = await stream([
      `data: ${JSON.stringify({ id: "gen-1", choices: [{ index: 0, delta: { content: "x" }, finish_reason: null }], usage: USAGE })}\n\n`,
      "data: [DONE]\n\n",
    ]);
    expect(out.complete).toBe(false);
  });

  it("does not call a stream complete when it ended on an error chunk", async () => {
    const out = await stream([
      content("Hel"),
      `data: ${JSON.stringify({ id: "gen-1", object: "chat.completion.chunk", error: { code: 429, message: "Rate limit exceeded" }, choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }] })}\n\n`,
      "data: [DONE]\n\n",
    ]);
    expect(out.complete).toBe(false);
  });

  it("does not call a stream complete when its usage carried no cost", async () => {
    const { cost: _c, ...noCost } = USAGE;
    const out = await stream([
      content("Hi"),
      `data: ${JSON.stringify({ id: "gen-1", object: "chat.completion.chunk", choices: [], usage: noCost })}\n\n`,
      "data: [DONE]\n\n",
    ]);
    expect(out.complete).toBe(false);
  });
});

describe("the model list offers only models the gateway will run", () => {
  // Live 2026-10-07: a scope of `openrouter/*` listed `openrouter/auto`, `fusion` and the
  // other routers, every one of which the gate refuses whatever the scope says.
  it("drops routers and presets from OpenRouter's list, and keeps the free router", () => {
    const body = { data: [{ id: "openrouter/auto" }, { id: "openrouter/fusion" }, { id: "openrouter/free" }, { id: "meta-llama/llama-3.3-70b-instruct" }] };
    const out = filterModelListingToScope(body, "openrouter", [{ provider: "openrouter", models: ["*"] }]) as { data: { id: string }[] };
    expect(out.data.map((m) => m.id)).toEqual(["openrouter/free", "meta-llama/llama-3.3-70b-instruct"]);
  });

  it("leaves another provider's list alone", () => {
    const body = { data: [{ id: "openrouter/auto" }] };
    const out = filterModelListingToScope(body, "together", [{ provider: "together", models: ["*"] }]) as { data: unknown[] };
    expect(out.data).toHaveLength(1);
  });
});
