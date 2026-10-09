// Anthropic's advisor tool, priced instead of refused (P4 part a, owner 2026-10-08).
//
// Claude Code 2.1.293 sends it on every main-model call when the user has an advisor
// picked (tests/fixtures/claude-code/advisor-tool.json): `{type: "advisor_20260301",
// name: "advisor", model: "claude-opus-5-5"}` and the `advisor-tool-2026-03-01` beta.
// Refusing it broke Claude Code outright.
//
// Anthropic (advisor-tool docs, read 2026-10-08): the advisor is a separate
// sub-inference "billed at the advisor model's rates", reported in
// `usage.iterations[]` as `advisor_message` entries, NOT rolled into the top-level
// usage. The advisor reads the full transcript; its output is capped by the tool's
// `max_tokens` (default: the advisor model's output cap) and its calls by `max_uses`
// (default: unlimited). The top-level `max_tokens` does not bound it.
//
// So, as for the other priced hosted tools (lib/providers/hosted-tools.ts):
//   1. a cap under a dollar limit: max_uses 1 and max_tokens 4096 when the agent set
//      none (Anthropic's typical advisor output is 1,400 to 1,800 tokens);
//   2. a hold per use: the transcript estimated for the ADVISOR's model, plus the
//      executor's output so far, plus the advisor's output cap, at the advisor's rates;
//   3. a charge from what Anthropic reported, each iteration at its own model's rates,
//      and its tokens counted against a token cap.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ADVISOR_DEFAULT_MAX_TOKENS,
  ADVISOR_DEFAULT_USES,
  hostedToolPlan,
  hostedToolReserve,
  hostedToolTokens,
  hostedToolUseCost,
  withDefaultToolCaps,
} from "@/lib/providers/hosted-tools";
import { serverSideToolUse } from "@/lib/providers/server-side-tools";
import { forwardableAnthropicBeta } from "@/lib/providers/anthropic-beta";
import { costMicrocents, costMicrocentsForUsage, estimateTokenUsage } from "@/lib/pricing";
import { createUsageTransform, usageFromJson } from "@/lib/usage/parseStream";

const fixture = JSON.parse(readFileSync("tests/fixtures/claude-code/advisor-tool.json", "utf8"));
const ADVISOR = fixture.advisor_tools[0] as { type: string; name: string; model: string };
const messages = [{ role: "user", content: "x".repeat(24_000) }];
const body = (tool: Record<string, unknown> = ADVISOR, extra: Record<string, unknown> = {}) => ({
  model: "claude-sonnet-5",
  max_tokens: 500,
  messages,
  tools: [tool],
  ...extra,
});

describe("the fixture is what Claude Code sends", () => {
  it("names the advisor's model, and asks for the advisor beta", () => {
    expect(ADVISOR).toEqual({ type: "advisor_20260301", name: "advisor", model: "claude-opus-5-5" });
    expect(fixture.anthropic_beta.split(",")).toContain("advisor-tool-2026-03-01");
  });
});

describe("which advisors are accepted", () => {
  it("accepts an advisor whose model has a price", () => {
    expect(serverSideToolUse("anthropic", body())).toBeNull();
  });

  it.each([
    ["a model with no price row", { ...ADVISOR, model: "claude-nova-9" }],
    ["no model at all", { type: "advisor_20260301", name: "advisor" }],
    ["a version this table does not know", { ...ADVISOR, type: "advisor_20990101" }],
  ])("refuses %s", (_name, tool) => {
    expect(serverSideToolUse("anthropic", body(tool))).toBe("tools[0].type");
  });
});

describe("the cap under a dollar limit", () => {
  it("sets max_uses and max_tokens on an uncapped advisor, on the forwarded copy", () => {
    const sent = withDefaultToolCaps("anthropic", body(), true);
    expect((sent.tools as unknown[])[0]).toEqual({ ...ADVISOR, max_uses: ADVISOR_DEFAULT_USES, max_tokens: ADVISOR_DEFAULT_MAX_TOKENS });
    expect(ADVISOR_DEFAULT_USES).toBe(1);
    expect(ADVISOR_DEFAULT_MAX_TOKENS).toBe(4096);
  });

  it("never changes caps the agent set", () => {
    const tool = { ...ADVISOR, max_uses: 3, max_tokens: 2048 };
    expect((withDefaultToolCaps("anthropic", body(tool), true).tools as unknown[])[0]).toEqual(tool);
  });

  it("forwards the request untouched without a dollar limit", () => {
    const b = body();
    expect(withDefaultToolCaps("anthropic", b, false)).toBe(b);
  });
});

describe("the hold", () => {
  const OPUS_55_IN = 400;
  const OPUS_55_OUT = 2_000;

  it("covers each use: the transcript at the advisor's tokenizer, the executor's output, and the advisor's output cap, at the advisor's rates", () => {
    const capped = withDefaultToolCaps("anthropic", body(), true);
    const plan = hostedToolPlan("anthropic", capped)!;
    const reserve = hostedToolReserve(plan, "claude-sonnet-5", "anthropic");
    const transcript = estimateTokenUsage(capped, 1000, "claude-opus-5-5").inputTokens + 500;
    expect(reserve.tokens).toBe(transcript + 4096);
    expect(reserve.microcents).toBe(transcript * OPUS_55_IN + 4096 * OPUS_55_OUT);
  });

  it("holds every use the agent allowed", () => {
    const plan = hostedToolPlan("anthropic", body({ ...ADVISOR, max_uses: 3, max_tokens: 2048 }))!;
    const one = hostedToolPlan("anthropic", body({ ...ADVISOR, max_uses: 1, max_tokens: 2048 }))!;
    const r3 = hostedToolReserve(plan, "claude-sonnet-5", "anthropic");
    const r1 = hostedToolReserve(one, "claude-sonnet-5", "anthropic");
    expect(r3.microcents).toBe(3 * r1.microcents);
  });

  it("holds the transcript at the cache-write rate when the advisor caches", () => {
    const plain = hostedToolReserve(hostedToolPlan("anthropic", body({ ...ADVISOR, max_uses: 1, max_tokens: 2048 }))!, "claude-sonnet-5", "anthropic");
    const cached = hostedToolReserve(
      hostedToolPlan("anthropic", body({ ...ADVISOR, max_uses: 1, max_tokens: 2048, caching: { type: "ephemeral", ttl: "5m" } }))!,
      "claude-sonnet-5",
      "anthropic"
    );
    expect(cached.microcents).toBeGreaterThan(plain.microcents);
  });

  it("an uncapped advisor (no dollar limit) is held at its model's output cap", () => {
    const plan = hostedToolPlan("anthropic", body())!;
    expect(plan.advisor).toMatchObject({ model: "claude-opus-5-5", uses: 1, maxTokens: 128_000 });
  });
});

const ITERATIONS = [
  { type: "message", input_tokens: 412, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 89 },
  { type: "advisor_message", model: "claude-opus-5-5", input_tokens: 823, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, output_tokens: 1612 },
  { type: "message", input_tokens: 1348, cache_read_input_tokens: 412, cache_creation_input_tokens: 0, output_tokens: 442 },
];

describe("reading what the advisor used", () => {
  it("takes advisor_message iterations from a buffered response, and only those", () => {
    const u = usageFromJson("anthropic", {
      usage: { input_tokens: 1760, output_tokens: 531, cache_read_input_tokens: 412, cache_creation_input_tokens: 0, iterations: ITERATIONS },
    });
    expect(u.inputTokens).toBe(1760);
    expect(u.hostedTools?.advisor).toEqual([{ model: "claude-opus-5-5", inputTokens: 823, outputTokens: 1612, cacheReadTokens: 100, cacheWriteTokens: 0 }]);
  });

  it("counts a stream's iterations once, however many deltas repeat them", async () => {
    const { stream, settled } = createUsageTransform("anthropic");
    const lines = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":412,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}\n\n',
      `data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 89, iterations: ITERATIONS.slice(0, 2) } })}\n\n`,
      `data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 531, iterations: ITERATIONS } })}\n\n`,
      'data: {"type":"message_stop"}\n\n',
    ];
    const source = new ReadableStream<Uint8Array>({
      start(c) {
        for (const l of lines) c.enqueue(new TextEncoder().encode(l));
        c.close();
      },
    });
    const reader = source.pipeThrough(stream).getReader();
    while (!(await reader.read()).done) {
      /* drain */
    }
    const out = await settled;
    expect(out.usage.hostedTools?.advisor).toHaveLength(1);
  });

  it("ignores malformed iterations", () => {
    const u = usageFromJson("anthropic", {
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, iterations: [null, { type: "advisor_message", input_tokens: "x" }, 7] },
    });
    expect(u.hostedTools?.advisor ?? []).toEqual([]);
  });

  it("leaves a call without iterations exactly as before", () => {
    const u = usageFromJson("anthropic", {
      usage: { input_tokens: 105, output_tokens: 239, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use: { web_search_requests: 2 } },
    });
    expect(u.hostedTools).toEqual({ webSearch: 2, webFetch: 0, codeExecution: 0 });
  });
});

describe("the charge", () => {
  const use = {
    webSearch: 0,
    webFetch: 0,
    codeExecution: 0,
    advisor: [{ model: "claude-opus-5-5", inputTokens: 823, outputTokens: 1612, cacheReadTokens: 100, cacheWriteTokens: 0 }],
  };

  it("prices each advisor iteration at its own model's rates", () => {
    const plan = hostedToolPlan("anthropic", body())!;
    const expected = costMicrocentsForUsage({ inputTokens: 823, outputTokens: 1612, cacheReadTokens: 100, cacheWriteTokens: 0 }, "claude-opus-5-5", "anthropic");
    expect(hostedToolUseCost("anthropic", use, plan, 1_000)).toBe(expected);
    expect(expected).toBe(823 * 400 + 1612 * 2_000 + 100 * 20);
  });

  it("falls back to the tool's model when an iteration names none", () => {
    const plan = hostedToolPlan("anthropic", body())!;
    const { model: _m, ...unnamed } = use.advisor[0]!;
    expect(hostedToolUseCost("anthropic", { ...use, advisor: [unnamed] }, plan, 1_000)).toBe(
      hostedToolUseCost("anthropic", use, plan, 1_000)
    );
  });

  it("counts the advisor's tokens for a token cap", () => {
    expect(hostedToolTokens(use)).toBe(823 + 1612 + 100);
    expect(hostedToolTokens({ webSearch: 1, webFetch: 0, codeExecution: 0 })).toBe(0);
  });

  it("is a large share of a call: an Opus advice on a Sonnet call costs more than the call's own output", () => {
    expect(costMicrocents("claude-opus-5-5", 823, 1612, "anthropic")).toBeGreaterThan(costMicrocents("claude-sonnet-5", 0, 442, "anthropic"));
  });
});

describe("the advisor beta header", () => {
  it("is dropped unless the request carries an accepted advisor", () => {
    expect(forwardableAnthropicBeta(fixture.anthropic_beta).dropped).toContain("advisor-tool-2026-03-01");
  });

  it("is forwarded when it does", () => {
    const { header } = forwardableAnthropicBeta(fixture.anthropic_beta, { advisor: true });
    expect(header?.split(",")).toContain("advisor-tool-2026-03-01");
    // And nothing else the default would drop.
    expect(header?.split(",")).not.toContain("mid-conversation-system-2026-04-07");
  });
});
