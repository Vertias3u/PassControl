// A request that asks Anthropic to cache its prompt may pay the cache-WRITE rate on
// all of it: 1.25x input for the default 5 minutes, 2x for 1 hour (pricing page,
// read 2026-10-08). Claude Code marks its prompt for the 5-minute cache, so a
// session's first call writes ~65K tokens at 1.25x, and a hold at 1x held about 94%
// of it even after P1.6. Owner's pick (P5.1, 2026-10-08): hold such a request's
// input at the write rate. Later calls read the cache at 0.1x or less and were
// already held far above cost; settlement still charges what Anthropic reports.
import { describe, expect, it } from "vitest";
import { cacheWriteHoldMultiplier, costMicrocents, holdMicrocents } from "@/lib/pricing";

const ID = "claude-sonnet-5"; // $2 in, $10 out
const IN = 200;
const OUT = 1_000;
const msg = (block: Record<string, unknown> = {}) => [{ role: "user", content: [{ type: "text", text: "hi", ...block }] }];

describe("cacheWriteHoldMultiplier", () => {
  it.each([
    ["no cache_control", { messages: msg() }, 1],
    ["a 5-minute breakpoint on a block", { messages: msg({ cache_control: { type: "ephemeral" } }) }, 1.25],
    ["a breakpoint on the system prompt", { system: [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }], messages: msg() }, 1.25],
    ["a breakpoint on a tool", { tools: [{ name: "t", input_schema: {}, cache_control: { type: "ephemeral" } }], messages: msg() }, 1.25],
    ["automatic caching at the top level", { cache_control: { type: "ephemeral" }, messages: msg() }, 1.25],
    ["a 1-hour breakpoint", { messages: msg({ cache_control: { type: "ephemeral", ttl: "1h" } }) }, 2],
    ["a 1-hour one beside a 5-minute one", { system: [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }], messages: msg({ cache_control: { type: "ephemeral", ttl: "1h" } }) }, 2],
  ])("%s → %s", (_name, body, multiplier) => {
    expect(cacheWriteHoldMultiplier(body)).toBe(multiplier);
  });
});

describe("holdMicrocents", () => {
  it("holds input at 1.25x when the request asks for the 5-minute cache", () => {
    const body = { messages: msg({ cache_control: { type: "ephemeral" } }) };
    expect(holdMicrocents(ID, { inputTokens: 1_000, outputTokens: 10 }, "anthropic", body)).toBe(1_000 * Math.ceil(IN * 1.25) + 10 * OUT);
  });

  it("holds input at 2x for the 1-hour cache", () => {
    const body = { messages: msg({ cache_control: { type: "ephemeral", ttl: "1h" } }) };
    expect(holdMicrocents(ID, { inputTokens: 1_000, outputTokens: 10 }, "anthropic", body)).toBe(1_000 * IN * 2 + 10 * OUT);
  });

  it("is today's hold exactly when nothing is cached", () => {
    expect(holdMicrocents(ID, { inputTokens: 1_000, outputTokens: 10 }, "anthropic", { messages: msg() })).toBe(
      costMicrocents(ID, 1_000, 10, "anthropic")
    );
  });

  it("uses Haiku 5.5's long-tier write rate, the tier it is held at", () => {
    const body = { messages: msg({ cache_control: { type: "ephemeral" } }) };
    expect(holdMicrocents("claude-haiku-5-5", { inputTokens: 1_000, outputTokens: 0 }, "anthropic", body)).toBe(1_000 * Math.ceil(50 * 1.25));
  });

  it("changes nothing for another provider", () => {
    const body = { messages: msg({ cache_control: { type: "ephemeral" } }) };
    expect(holdMicrocents("gpt-4o-mini", { inputTokens: 1_000, outputTokens: 10 }, "openai", body)).toBe(
      costMicrocents("gpt-4o-mini", 1_000, 10, "openai")
    );
  });
});
