// The CLI's (and the MCP server's) explanation of a gateway refusal. A 402 used
// to mean only "out of budget", so every 402 said to raise the budget. Since
// 2026-09-27 the three unpriced refusals are 402 too (so SDKs do not retry
// them), and raising a budget does nothing for any of them.
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs CLI module, no types
import { formatProxyError } from "../cli/config.mjs";

describe("formatProxyError", () => {
  it("still tells an out-of-budget agent to raise the budget", () => {
    expect(formatProxyError(402, '{"error":"blocked_budget"}')).toMatch(/raise or clear the agent budget/);
  });

  it.each([
    ['{"error":"unpriced_model"}', /no price for this model/],
    ['{"error":"unpriced_option","field":"service_tier"}', /service_tier/],
    ['{"error":"unpriced_endpoint"}', /custom endpoint/],
  ])("explains %s without advising a bigger budget", (body, pattern) => {
    const message = formatProxyError(402, body);
    expect(message).toMatch(pattern);
    expect(message).not.toMatch(/raise or clear the agent budget/);
  });
});

// Each refusal names the fix that actually applies. Before 2026-09-27 every 403
// said "check scope, suspend/revoke and kill switch", including a K2 output
// ceiling (fixed by sending a smaller max_tokens), and every other status was a
// bare "Proxy error".
describe("formatProxyError names the right fix", () => {
  it("a spent daily/monthly limit says it resets, not only 'raise the budget'", () => {
    expect(formatProxyError(402, '{"error":"blocked_budget_period"}')).toMatch(/daily or monthly limit.*resets/s);
  });

  it("an output-ceiling refusal says to lower max_tokens and gives the limit", () => {
    const m = formatProxyError(403, '{"error":"blocked_policy","rule":"max_output_tokens","reason":"exceeded","limit":31}');
    expect(m).toMatch(/max_tokens/);
    expect(m).toMatch(/31/);
    expect(m).not.toMatch(/kill switch/);
  });

  it("an output-ceiling refusal for a missing limit says to state one", () => {
    const m = formatProxyError(403, '{"error":"blocked_policy","rule":"max_output_tokens","reason":"missing","limit":31}');
    expect(m).toMatch(/state an output limit/i);
  });

  it("a policy rule refusal points at the agent's policy", () => {
    const m = formatProxyError(403, '{"error":"blocked_policy"}');
    expect(m).toMatch(/agent's live policy/);
    expect(m).not.toMatch(/kill switch/);
  });

  it("a scope refusal says the model is outside the agent's access", () => {
    expect(formatProxyError(403, '{"error":"blocked_scope"}')).toMatch(/allowed models/);
  });

  it("no provider key says to store one", () => {
    expect(formatProxyError(409, '{"error":"no_provider_key"}')).toMatch(/provider key/);
  });

  it("a hosted-tool refusal says to remove the tool", () => {
    expect(formatProxyError(400, '{"error":"server_side_tools_unsupported"}')).toMatch(/hosted tool/);
  });

  it("keeps the generic fallbacks for anything else", () => {
    expect(formatProxyError(403, '{"error":"blocked"}')).toMatch(/kill switch/);
    expect(formatProxyError(500, "boom")).toBe("Proxy error 500: boom");
  });
});
