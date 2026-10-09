// Which `anthropic-beta` values travel upstream with the provider key.
//
// The proxy builds its upstream headers from scratch, and this header is the one
// deliberate exception: Claude Code sends it on every call, and its body carries
// fields Anthropic accepts only under one of these betas (`context_management`).
// Without it, every Claude Code call came back "400 context_management: Extra
// inputs are not permitted" (reproduced 2026-10-07, Claude Code 2.1.292).
//
// Forwarded: betas that change neither what a call can reach nor what it costs.
// Matched by FAMILY, with any date: Claude Code moves the dates, and an exact list
// would bring the 400 back on its next release.
//
// Never forwarded, whatever their date: betas for tools PassControl refuses
// (mcp-client, files-api, skills), advisor-tool unless the request's advisor was
// accepted and priced, and context-1m. Every 1M-context
// model (Claude 4.6 and later) has 1M by default at its flat rate, so the beta adds
// nothing there; on the 200K models (Sonnet 4.5 and earlier) Anthropic's pricing
// page states no 1M rate to price it at (read 2026-10-08;
// tests/anthropic-long-context.test.ts). The priced hosted tools
// (web search, web fetch, code execution: lib/providers/hosted-tools.ts) need no
// beta: all three ran live without one on 2026-10-07, so theirs stay dropped too.
//
// An unknown beta is DROPPED, not refused. Dropping can make Anthropic answer 400;
// it cannot make a call cost more or reach further.
const FORWARDED_FAMILIES = [
  "claude-code",
  "interleaved-thinking",
  "context-management",
  "prompt-caching-scope",
  "thinking-token-count",
  "fine-grained-tool-streaming",
  "token-efficient-tools",
] as const;

// A family, then a date as Anthropic writes them: `2025-06-27` or `20250219`.
const FORWARDED = new RegExp(`^(?:${FORWARDED_FAMILIES.join("|")})-(?:\\d{4}-\\d{2}-\\d{2}|\\d{8})$`);
const MAX_HEADER_CHARS = 1024;
const MAX_BETAS = 16;

// The advisor's beta, forwarded only for a request whose advisor PassControl
// accepted and priced (P4, 2026-10-08; lib/providers/hosted-tools.ts). Anthropic
// refuses the advisor tool without it.
const ADVISOR_BETA = /^advisor-tool-(?:\d{4}-\d{2}-\d{2}|\d{8})$/;

export function forwardableAnthropicBeta(
  raw: string | null,
  options: { advisor?: boolean } = {}
): { header: string | null; dropped: string[] } {
  if (!raw) return { header: null, dropped: [] };
  // A control character can only be an attempt to start a new header line.
  // Cut at the first one rather than joining across it.
  const line = raw.split(/[\x00-\x1f\x7f]/u)[0]!.slice(0, MAX_HEADER_CHARS);
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const part of line.split(",")) {
    const beta = part.trim();
    if (!beta || kept.includes(beta) || dropped.includes(beta)) continue;
    if ((FORWARDED.test(beta) || (options.advisor === true && ADVISOR_BETA.test(beta))) && kept.length < MAX_BETAS) kept.push(beta);
    else dropped.push(beta.slice(0, 64));
  }
  return { header: kept.length ? kept.join(",") : null, dropped };
}
