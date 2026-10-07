// Claude Code sends `anthropic-beta` on every call, and its body carries fields
// Anthropic accepts only under one of those betas (`context_management`). The
// gateway built its upstream headers from scratch and dropped the header, so
// every Claude Code call through PassControl came back
// "400 context_management: Extra inputs are not permitted" (reproduced live
// 2026-10-07, Claude Code 2.1.292).
//
// The header is forwarded, but only betas that change neither what a call can
// reach nor what it costs. Matched by family, not by date: Claude Code moves the
// dates, and an exact list would bring this bug back on its next release.
// Unknown betas are dropped rather than refused: dropping can cause an upstream
// 400, never spend.
import { describe, expect, it } from "vitest";
import { forwardableAnthropicBeta } from "@/lib/providers/anthropic-beta";

// Captured from Claude Code 2.1.292 on 2026-10-07.
const CLAUDE_CODE =
  "claude-code-20250219,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13," +
  "context-management-2025-06-27,prompt-caching-scope-2026-01-05,advisor-tool-2026-03-01";

describe("forwardableAnthropicBeta", () => {
  it("keeps what Claude Code needs and drops the advisor tool's beta", () => {
    expect(forwardableAnthropicBeta(CLAUDE_CODE)).toEqual({
      header:
        "claude-code-20250219,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13," +
        "context-management-2025-06-27,prompt-caching-scope-2026-01-05",
      dropped: ["advisor-tool-2026-03-01"],
    });
  });

  it("accepts a later date in a known family", () => {
    expect(forwardableAnthropicBeta("context-management-2027-01-01").header).toBe("context-management-2027-01-01");
    expect(forwardableAnthropicBeta("claude-code-20270101").header).toBe("claude-code-20270101");
  });

  it.each([
    "mcp-client-2025-11-20",
    "code-execution-2025-08-25",
    "files-api-2025-04-14",
    "web-fetch-2025-09-10",
    "web-search-2025-03-05",
    "context-1m-2025-08-07",
    "skills-2025-10-02",
    "something-new-2027-01-01",
  ])("drops %s: it reaches out, bills outside tokens, or is unknown", (beta) => {
    expect(forwardableAnthropicBeta(beta)).toEqual({ header: null, dropped: [beta] });
  });

  it("forwards nothing when there is no header", () => {
    expect(forwardableAnthropicBeta(null)).toEqual({ header: null, dropped: [] });
    expect(forwardableAnthropicBeta("  ")).toEqual({ header: null, dropped: [] });
  });

  it("cannot be used to inject a header line", () => {
    const out = forwardableAnthropicBeta("claude-code-20250219\r\nx-api-key: stolen");
    expect(out.header ?? "").not.toMatch(/[\r\n]/);
    expect(out.header ?? "").not.toContain("x-api-key");
  });

  it("ignores spacing and repeats", () => {
    expect(forwardableAnthropicBeta(" claude-code-20250219 , claude-code-20250219,").header).toBe("claude-code-20250219");
  });

  it("drops a family name with a suffix glued on", () => {
    expect(forwardableAnthropicBeta("claude-code-20250219-mcp-client").header).toBeNull();
  });
});
