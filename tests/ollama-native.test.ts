// Ollama's own API, governed through the `local` provider (1.3.0 #3). Apps that
// only take OLLAMA_HOST speak it, not the OpenAI-compatible /v1 API.
//
// Captured from the real `ollama` CLI against Ollama 0.40.0 on 2026-10-07: it
// sends `HEAD /`, then `POST /api/show` (model metadata), then `POST
// /api/generate` with no `stream` field, and Ollama answers
// `application/x-ndjson` (streaming is the default). The final line carries
// `done: true`, `prompt_eval_count` and `eval_count`; a repeated prompt still
// reported its full prompt_eval_count (35) beside `prompt_eval_cached_count`.
//
// The native paths live at the server root, not under the stored `/v1` base.
// Metadata calls (show, tags, version) generate nothing and are treated like a
// model listing. Model management (pull, push, create, copy, delete) and
// embeddings are not on the allowlist, so the gateway refuses them.
import { describe, expect, it } from "vitest";
import { canonicalEndpointPath, endpointAllows, isModelListing, isOllamaNativeEndpoint } from "@/lib/scope";
import { serverRootOf } from "@/lib/providers/endpoint";
import { createUsageTransform, usageFromJson } from "@/lib/usage/parseStream";
import { outputLimitShape, requestedOutputTokens, largestStatedOutputLimit } from "@/lib/output-limit";

describe("the allowlist", () => {
  it.each([
    ["POST", ["api", "chat"]],
    ["POST", ["api", "generate"]],
    ["POST", ["api", "show"]],
    ["GET", ["api", "tags"]],
    ["GET", ["api", "version"]],
  ])("serves %s /%s", (method, path) => {
    expect(endpointAllows("local", method, path)).toBe(true);
    expect(canonicalEndpointPath("local", method, path)).toEqual(path);
  });

  it.each([
    ["POST", ["api", "pull"]],
    ["POST", ["api", "push"]],
    ["POST", ["api", "create"]],
    ["POST", ["api", "copy"]],
    ["DELETE", ["api", "delete"]],
    ["POST", ["api", "embed"]],
    ["POST", ["api", "embeddings"]],
    ["GET", ["api", "ps"]],
  ])("refuses %s /%s", (method, path) => {
    expect(endpointAllows("local", method, path)).toBe(false);
  });

  it("serves none of it for a provider other than local", () => {
    expect(endpointAllows("openai", "POST", ["api", "chat"])).toBe(false);
  });

  it("marks chat and generate as Ollama's own format, and only those", () => {
    expect(isOllamaNativeEndpoint("local", "POST", ["api", "chat"])).toBe(true);
    expect(isOllamaNativeEndpoint("local", "POST", ["api", "generate"])).toBe(true);
    expect(isOllamaNativeEndpoint("local", "POST", ["chat", "completions"])).toBe(false);
    expect(isOllamaNativeEndpoint("local", "GET", ["api", "tags"])).toBe(false);
  });

  it("treats the metadata calls like a model listing", () => {
    expect(isModelListing(["api", "tags"])).toBe(true);
    expect(isModelListing(["api", "version"])).toBe(true);
    expect(isModelListing(["api", "show"])).toBe(true);
    expect(isModelListing(["api", "chat"])).toBe(false);
  });
});

describe("the server root", () => {
  it("drops the stored version segment", () => {
    expect(serverRootOf("http://localhost:11434/v1")).toBe("http://localhost:11434");
    expect(serverRootOf("http://localhost:11434/v1/")).toBe("http://localhost:11434");
    expect(serverRootOf("http://gpu.lan:8000/ollama/v1")).toBe("http://gpu.lan:8000/ollama");
  });

  it("leaves a base with no version segment alone", () => {
    expect(serverRootOf("http://localhost:11434")).toBe("http://localhost:11434");
  });
});

describe("Ollama usage", () => {
  const FINAL = { model: "qwen2.5:0.5b", done: true, done_reason: "stop", prompt_eval_count: 35, prompt_eval_cached_count: 34, eval_count: 7 };

  it("reads a buffered response", () => {
    expect(usageFromJson("local", FINAL, "ollama")).toMatchObject({ inputTokens: 35, outputTokens: 7, sawUsage: true, complete: true });
  });

  it("is incomplete without done, or without its counts", () => {
    expect(usageFromJson("local", { ...FINAL, done: false }, "ollama").complete).toBe(false);
    expect(usageFromJson("local", { done: true, done_reason: "load" }, "ollama").complete).toBe(false);
  });

  async function stream(lines: string[]) {
    const { stream, settled } = createUsageTransform("local", "ollama");
    const reader = new ReadableStream<Uint8Array>({
      start(c) {
        for (const l of lines) c.enqueue(new TextEncoder().encode(l));
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

  it("reads the final line of an NDJSON stream", async () => {
    const out = await stream([
      '{"model":"qwen2.5:0.5b","response":"Hel","done":false}\n',
      '{"model":"qwen2.5:0.5b","response":"lo","done":false}\n',
      `${JSON.stringify(FINAL)}\n`,
    ]);
    expect(out.usage).toMatchObject({ inputTokens: 35, outputTokens: 7 });
    expect(out.complete).toBe(true);
  });

  it("does not call a stream that ended on an error line complete", async () => {
    const out = await stream(['{"response":"Hel","done":false}\n', '{"error":"model runner stopped"}\n']);
    expect(out.complete).toBe(false);
  });
});

describe("Ollama's output limit is options.num_predict", () => {
  const shape = outputLimitShape("local", ["api", "chat"]);

  it("is its own shape", () => {
    expect(shape).toBe("ollama_native");
    expect(outputLimitShape("local", ["v1", "chat", "completions"])).toBe("chat_completions");
  });

  it("reads a positive num_predict as the ceiling", () => {
    expect(requestedOutputTokens(shape, { options: { num_predict: 128 } })).toEqual({ kind: "stated", tokens: 128 });
  });

  it("treats -1 and -2 (no limit) and an absent one as no stated limit", () => {
    expect(requestedOutputTokens(shape, { options: { num_predict: -1 } })).toEqual({ kind: "absent" });
    expect(requestedOutputTokens(shape, { options: { num_predict: -2 } })).toEqual({ kind: "absent" });
    expect(requestedOutputTokens(shape, { options: {} })).toEqual({ kind: "absent" });
    expect(requestedOutputTokens(shape, {})).toEqual({ kind: "absent" });
  });

  it("calls any other value invalid", () => {
    expect(requestedOutputTokens(shape, { options: { num_predict: 0 } })).toEqual({ kind: "invalid", field: "options.num_predict" });
    expect(requestedOutputTokens(shape, { options: { num_predict: "64" } })).toEqual({ kind: "invalid", field: "options.num_predict" });
  });

  it("sizes the hold from num_predict too", () => {
    expect(largestStatedOutputLimit({ options: { num_predict: 4096 } })).toBe(4096);
  });
});
