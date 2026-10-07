// Anthropic's hosted tools, priced instead of refused (owner, DECISIONS 2026-10-07).
//
// Prices, from platform.claude.com/docs/en/about-claude/pricing (read 2026-10-07):
//   web search      $10 per 1,000 searches (1¢ each), failed searches not billed,
//                   reported as usage.server_tool_use.web_search_requests
//   web fetch       no charge beyond the tokens of what it fetched
//   code execution  $0.05 per container-hour, 5-minute minimum, free when the
//                   request carries web_search_20260209 / web_fetch_20260209 or later
//                   (dynamic filtering runs it); usage.server_tool_use.code_execution_requests
//
// Search and fetch results come back as extra input tokens INSIDE the same call,
// so the hold covers cap × (per-call price + a per-call token allowance), not the
// per-call price alone. Exact tool versions only: price and behaviour change by
// version, and an unknown one is refused (tests/anthropic-server-side-tools.test.ts).
import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_CODE_EXECUTION_MIN_MICROCENTS,
  DEFAULT_FETCH_CONTENT_TOKENS,
  DEFAULT_TOOL_CAP,
  SEARCH_RESULT_TOKEN_ALLOWANCE,
  CODE_EXECUTION_TOKEN_ALLOWANCE,
  hostedToolPlan,
  hostedToolReserve,
  hostedToolUseCost,
  withDefaultToolCaps,
} from "@/lib/providers/hosted-tools";
import { costMicrocents } from "@/lib/pricing";

const CENT = 1_000_000; // microcents
const search = (extra: object = {}) => ({ type: "web_search_20250305", name: "web_search", ...extra });
const fetchTool = (extra: object = {}) => ({ type: "web_fetch_20250910", name: "web_fetch", ...extra });
const code = { type: "code_execution_20250825", name: "code_execution" };
const custom = { name: "Read", input_schema: { type: "object" } };

describe("the default cap, under a dollar limit", () => {
  it("adds max_uses 5 to a search with none, on a copy", () => {
    const body = { model: "m", tools: [custom, search()] };
    const out = withDefaultToolCaps("anthropic", body, true);
    expect(out.tools).toEqual([custom, search({ max_uses: DEFAULT_TOOL_CAP })]);
    expect(body.tools[1]).toEqual(search());
  });

  it("caps a fetch's uses and its content tokens", () => {
    const out = withDefaultToolCaps("anthropic", { tools: [fetchTool()] }, true);
    expect(out.tools).toEqual([fetchTool({ max_uses: DEFAULT_TOOL_CAP, max_content_tokens: DEFAULT_FETCH_CONTENT_TOKENS })]);
  });

  it("never changes a cap the agent set, however large", () => {
    const body = { tools: [search({ max_uses: 40 }), fetchTool({ max_uses: 2, max_content_tokens: 90_000 })] };
    expect(withDefaultToolCaps("anthropic", body, true)).toBe(body);
  });

  it("changes nothing without a dollar limit", () => {
    const body = { tools: [search()] };
    expect(withDefaultToolCaps("anthropic", body, false)).toBe(body);
  });

  it("changes nothing for a request with no hosted tool", () => {
    const body = { tools: [custom] };
    expect(withDefaultToolCaps("anthropic", body, true)).toBe(body);
  });
});

describe("the hold covers the tools before the call is sent", () => {
  it("reserves each capped search's price and its result tokens", () => {
    const plan = hostedToolPlan("anthropic", { tools: [search({ max_uses: 3 })] })!;
    const tokens = 3 * SEARCH_RESULT_TOKEN_ALLOWANCE;
    expect(hostedToolReserve(plan, "claude-haiku-4-5", "anthropic")).toEqual({
      tokens,
      microcents: 3 * CENT + costMicrocents("claude-haiku-4-5", tokens, 0, "anthropic"),
    });
  });

  it("reserves a fetch by its content-token cap, at no per-call price", () => {
    const plan = hostedToolPlan("anthropic", { tools: [fetchTool({ max_uses: 2, max_content_tokens: 10_000 })] })!;
    expect(hostedToolReserve(plan, "claude-haiku-4-5", "anthropic")).toEqual({
      tokens: 20_000,
      microcents: costMicrocents("claude-haiku-4-5", 20_000, 0, "anthropic"),
    });
  });

  it("assumes the default cap where the agent set none (no dollar limit, so no cap was added)", () => {
    const plan = hostedToolPlan("anthropic", { tools: [search()] })!;
    expect(plan.searches).toBe(DEFAULT_TOOL_CAP);
  });

  it("reserves code execution at its 5-minute minimum, unless dynamic filtering makes it free", () => {
    const paid = hostedToolPlan("anthropic", { tools: [code] })!;
    expect(hostedToolReserve(paid, "claude-haiku-4-5", "anthropic").microcents).toBe(
      DEFAULT_TOOL_CAP * ANTHROPIC_CODE_EXECUTION_MIN_MICROCENTS +
        costMicrocents("claude-haiku-4-5", DEFAULT_TOOL_CAP * CODE_EXECUTION_TOKEN_ALLOWANCE, 0, "anthropic")
    );
    const free = hostedToolPlan("anthropic", { tools: [code, { type: "web_search_20260209", name: "web_search", max_uses: 1 }] })!;
    expect(free.codeExecutionFree).toBe(true);
  });

  it("has no plan for a request without hosted tools", () => {
    expect(hostedToolPlan("anthropic", { tools: [custom] })).toBeNull();
    expect(hostedToolPlan("anthropic", {})).toBeNull();
  });
});

describe("settlement charges what Anthropic reports", () => {
  const plan = hostedToolPlan("anthropic", { tools: [search({ max_uses: 5 }), code] })!;

  it("charges 1¢ per reported search, and nothing for fetches", () => {
    expect(hostedToolUseCost("anthropic", { webSearch: 2, webFetch: 3, codeExecution: 0 }, plan, 1_000)).toBe(2 * CENT);
  });

  it("charges code execution at max(5 minutes, the call's duration) at $0.05 an hour", () => {
    expect(ANTHROPIC_CODE_EXECUTION_MIN_MICROCENTS).toBe(416_667);
    expect(hostedToolUseCost("anthropic", { webSearch: 0, webFetch: 0, codeExecution: 1 }, plan, 60_000)).toBe(416_667);
    // 10 minutes: 2 × the minimum.
    expect(hostedToolUseCost("anthropic", { webSearch: 0, webFetch: 0, codeExecution: 1 }, plan, 600_000)).toBe(833_334);
  });

  it("charges no code execution when dynamic filtering made it free", () => {
    const free = hostedToolPlan("anthropic", { tools: [{ type: "web_fetch_20260209", name: "web_fetch", max_uses: 1 }, code] })!;
    expect(hostedToolUseCost("anthropic", { webSearch: 0, webFetch: 1, codeExecution: 4 }, free, 600_000)).toBe(0);
  });

  it("charges nothing when nothing was reported", () => {
    expect(hostedToolUseCost("anthropic", undefined, plan, 1_000)).toBe(0);
  });
});
