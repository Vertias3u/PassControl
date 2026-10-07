// Hosted tools a provider runs on its own servers, priced instead of refused
// (owner, DECISIONS 2026-10-07, superseding 2026-09-27's refusal).
//
// Three things make a hosted tool safe to accept under a budget, and this module
// owns all three:
//
//   1. A CAP. Under a dollar limit an uncapped tool gets DEFAULT_TOOL_CAP, set on
//      the forwarded copy only; a cap the agent set is never changed, so a large
//      one makes a large hold and is refused like any call that does not fit.
//   2. A HOLD that covers it before anything is sent: cap × (per-call price + a
//      per-call token allowance), because results come back as extra input
//      tokens inside the same call. Settlement keeps the greater of observed and
//      reserved when usage is unknown, so a broken stream keeps this reservation.
//   3. A CHARGE at settlement, from what the provider reported.
//
// Exact tool versions only. Price and behaviour change by version (from
// web_search_20260209 a search runs through code execution), so a version this
// table does not name is refused by lib/providers/server-side-tools.ts.
//
// OpenAI and xAI are priced from their published pages and documented response
// shapes (tests/hosted-tools-openai-xai.test.ts names them); neither has been run
// with a real key yet.
//
// Anthropic prices, platform.claude.com/docs/en/about-claude/pricing, read
// 2026-10-07: web search $10 per 1,000, failed searches not billed; web fetch no
// charge beyond tokens; code execution $0.05 per container-hour with a 5-minute
// minimum, free when the request carries web_search_20260209 / web_fetch_20260209
// or later. The 1,550 free hours a month are ignored: over-counting is the safe
// direction for a budget.
import { costMicrocents, MICROCENTS_PER_CENT } from "@/lib/pricing";
import { openaiContainerTier, type MemoryTier } from "./openai-containers";

/** The cap set on an uncapped hosted tool under a dollar limit (owner, 2026-10-07). */
export const DEFAULT_TOOL_CAP = 5;
/** `max_content_tokens` set on an uncapped web fetch under a dollar limit. */
export const DEFAULT_FETCH_CONTENT_TOKENS = 20_000;
/** Input tokens a search's results are assumed to add, for the hold only. */
export const SEARCH_RESULT_TOKEN_ALLOWANCE = 10_000;
/** Input tokens a code execution's output is assumed to add, for the hold only. */
export const CODE_EXECUTION_TOKEN_ALLOWANCE = 5_000;

const ANTHROPIC_WEB_SEARCH_MICROCENTS = MICROCENTS_PER_CENT; // $10 / 1,000
const ANTHROPIC_CODE_EXECUTION_MIN_MS = 5 * 60_000;
/** $0.05 an hour is 5¢ per 3,600,000 ms. */
function anthropicCodeExecutionMicrocents(durationMs: number): number {
  const ms = Math.max(ANTHROPIC_CODE_EXECUTION_MIN_MS, Math.max(0, durationMs));
  return Math.ceil((ms * 5 * MICROCENTS_PER_CENT) / 3_600_000);
}
export const ANTHROPIC_CODE_EXECUTION_MIN_MICROCENTS = anthropicCodeExecutionMicrocents(0);

type AnthropicKind = "web_search" | "web_fetch" | "code_execution";

/** Exact versions from @anthropic-ai/sdk 0.112.4's BetaToolUnion. */
export const ANTHROPIC_PRICED_TOOLS: Readonly<Record<string, AnthropicKind>> = {
  web_search_20250305: "web_search",
  web_search_20260209: "web_search",
  web_search_20260318: "web_search",
  web_fetch_20250910: "web_fetch",
  web_fetch_20260209: "web_fetch",
  web_fetch_20260309: "web_fetch",
  web_fetch_20260318: "web_fetch",
  code_execution_20250522: "code_execution",
  code_execution_20250825: "code_execution",
  code_execution_20260120: "code_execution",
  code_execution_20260521: "code_execution",
};

/** Versions whose dynamic filtering runs code execution at no extra charge. */
const ANTHROPIC_FREE_CODE_EXECUTION = new Set([
  "web_search_20260209",
  "web_search_20260318",
  "web_fetch_20260209",
  "web_fetch_20260309",
  "web_fetch_20260318",
]);

export interface HostedToolPlan {
  searches: number;
  fetches: number;
  /** Total content tokens the fetches may bring in. */
  fetchTokens: number;
  codeExecutions: number;
  codeExecutionFree: boolean;
  /** OpenAI: built-in calls share one cap, each held at the dearest tool present. */
  openai?: { calls: number; perCallMicrocents: number; containers: MemoryTier[]; searchMicrocents: number };
  /** xAI: no cap field, so the default number of calls per tool present. */
  xai?: { webSearches: number; xSearches: number; codeRuns: number; fileSearches: number };
}

/** What a provider reported its hosted tools did. */
export interface HostedToolUse {
  webSearch: number;
  webFetch: number;
  codeExecution: number;
  fileSearch?: number;
  /** OpenAI: the container of every code interpreter or shell call, repeats included. */
  containers?: string[];
  xSearch?: number;
  xPosts?: number;
  xUsers?: number;
  /** xAI's exact charge for the whole call, tokens included (cost_in_usd_ticks / 100). */
  reportedMicrocents?: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function positiveInt(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
}

function anthropicKind(tool: unknown): AnthropicKind | null {
  if (!isRecord(tool) || typeof tool.type !== "string") return null;
  return Object.prototype.hasOwnProperty.call(ANTHROPIC_PRICED_TOOLS, tool.type)
    ? ANTHROPIC_PRICED_TOOLS[tool.type]!
    : null;
}

// ── OpenAI (developers.openai.com/api/docs/pricing, read 2026-10-07) ─────────
const OPENAI_WEB_SEARCH_MICROCENTS = MICROCENTS_PER_CENT; // $10 / 1k
/** The preview tools cost $25 / 1k on non-reasoning models; charged so whatever the model. */
const OPENAI_WEB_SEARCH_PREVIEW_MICROCENTS = 2.5 * MICROCENTS_PER_CENT;
const OPENAI_FILE_SEARCH_MICROCENTS = 0.25 * MICROCENTS_PER_CENT; // $2.50 / 1k
/** Per minute: a 20-minute session is 1g $0.03, 4g $0.12, 16g $0.48, 64g $1.92. */
const OPENAI_CONTAINER_MINUTE_MICROCENTS: Readonly<Record<MemoryTier, number>> = {
  "1g": 150_000,
  "4g": 600_000,
  "16g": 2_400_000,
  "64g": 9_600_000,
};
const OPENAI_CONTAINER_MIN_MINUTES = 5;
const OPENAI_CONTAINER_SESSION_MINUTES = 20;

const OPENAI_SEARCH_TYPES: Readonly<Record<string, number>> = {
  web_search: OPENAI_WEB_SEARCH_MICROCENTS,
  web_search_2025_08_26: OPENAI_WEB_SEARCH_MICROCENTS,
  web_search_preview: OPENAI_WEB_SEARCH_PREVIEW_MICROCENTS,
  web_search_preview_2025_03_11: OPENAI_WEB_SEARCH_PREVIEW_MICROCENTS,
};

/**
 * OpenAI hosted tools accepted because they are priced, each with the check its
 * shape must pass. Exact type strings from openai 6.49.0's `Tool` union.
 */
export const OPENAI_PRICED_TOOLS: Readonly<Record<string, (tool: Record<string, unknown>) => boolean>> = {
  web_search: () => true,
  web_search_2025_08_26: () => true,
  web_search_preview: () => true,
  web_search_preview_2025_03_11: () => true,
  file_search: () => true,
  code_interpreter: (tool) => openaiContainerTier(tool) !== null,
  shell: (tool) => openaiContainerTier(tool) !== null,
};

function openaiContainerMicrocents(tier: MemoryTier, minutes: number): number {
  return minutes * OPENAI_CONTAINER_MINUTE_MICROCENTS[tier];
}

// ── xAI (docs.x.ai/developers/pricing.md, read 2026-10-07) ──────────────────
const XAI_CALL_MICROCENTS = 0.5 * MICROCENTS_PER_CENT; // web search, code execution: $5 / 1k
const XAI_FILE_SEARCH_MICROCENTS = 0.25 * MICROCENTS_PER_CENT; // collections: $2.50 / 1k
const XAI_X_POST_MICROCENTS = 0.5 * MICROCENTS_PER_CENT; // $5 / 1k posts
const XAI_X_USER_MICROCENTS = MICROCENTS_PER_CENT; // $10 / 1k profiles
/** Posts an X search is assumed to return, for the hold only (the docs' example: 22 a call). */
export const X_SEARCH_POSTS_ALLOWANCE = 25;
/** 10^10 ticks per dollar, 10^8 microcents per dollar. */
const XAI_TICKS_PER_MICROCENT = 100;

export const XAI_PRICED_TOOLS: Readonly<Record<string, true>> = {
  web_search: true,
  x_search: true,
  code_interpreter: true,
  file_search: true,
};

/**
 * The forwarded body with a cap on every uncapped hosted tool, or the SAME object
 * when nothing changes. Only under a dollar limit, which is how the owner phrased
 * the decision; a token-only or unlimited agent's request is forwarded as sent.
 */
export function withDefaultToolCaps(
  provider: string,
  body: Record<string, unknown>,
  dollarLimited: boolean
): Record<string, unknown> {
  if (!dollarLimited || !Array.isArray(body.tools)) return body;
  if (provider === "openai") {
    // `max_tool_calls` caps every built-in call together (openai 6.49.0).
    const priced = body.tools.some((t) => isRecord(t) && typeof t.type === "string" && t.type in OPENAI_PRICED_TOOLS);
    return priced && positiveInt(body.max_tool_calls) === null ? { ...body, max_tool_calls: DEFAULT_TOOL_CAP } : body;
  }
  if (provider !== "anthropic") return body;
  let changed = false;
  const tools = body.tools.map((tool) => {
    const kind = anthropicKind(tool);
    if (kind !== "web_search" && kind !== "web_fetch") return tool;
    const t = tool as Record<string, unknown>;
    const next: Record<string, unknown> = { ...t };
    if (positiveInt(t.max_uses) === null) next.max_uses = DEFAULT_TOOL_CAP;
    if (kind === "web_fetch" && positiveInt(t.max_content_tokens) === null) {
      next.max_content_tokens = DEFAULT_FETCH_CONTENT_TOKENS;
    }
    if (next.max_uses !== t.max_uses || next.max_content_tokens !== t.max_content_tokens) {
      changed = true;
      return next;
    }
    return tool;
  });
  return changed ? { ...body, tools } : body;
}

/** What the hold must cover for this body's hosted tools, or null if it has none. */
export function hostedToolPlan(provider: string, body: unknown): HostedToolPlan | null {
  if (!isRecord(body) || !Array.isArray(body.tools)) return null;
  const plan: HostedToolPlan = { searches: 0, fetches: 0, fetchTokens: 0, codeExecutions: 0, codeExecutionFree: false };
  if (provider === "openai") {
    let perCall = 0;
    let searchMicrocents = 0;
    const containers: MemoryTier[] = [];
    for (const tool of body.tools) {
      if (!isRecord(tool) || typeof tool.type !== "string") continue;
      const search = OPENAI_SEARCH_TYPES[tool.type];
      if (search !== undefined) {
        perCall = Math.max(perCall, search);
        searchMicrocents = Math.max(searchMicrocents, search);
      } else if (tool.type === "file_search") perCall = Math.max(perCall, OPENAI_FILE_SEARCH_MICROCENTS);
      else {
        const tier = openaiContainerTier(tool);
        // Unknown (a reused container): priced at the top tier, the safe side.
        if (tier) containers.push(tier === "unknown" ? "64g" : tier);
      }
    }
    if (perCall === 0 && containers.length === 0) return null;
    plan.openai = {
      calls: positiveInt(body.max_tool_calls) ?? DEFAULT_TOOL_CAP,
      perCallMicrocents: perCall,
      containers,
      searchMicrocents,
    };
    return plan;
  }
  if (provider === "xai") {
    const x = { webSearches: 0, xSearches: 0, codeRuns: 0, fileSearches: 0 };
    for (const tool of body.tools) {
      if (!isRecord(tool)) continue;
      if (tool.type === "web_search") x.webSearches += DEFAULT_TOOL_CAP;
      else if (tool.type === "x_search") x.xSearches += DEFAULT_TOOL_CAP;
      else if (tool.type === "code_interpreter") x.codeRuns += DEFAULT_TOOL_CAP;
      else if (tool.type === "file_search") x.fileSearches += DEFAULT_TOOL_CAP;
    }
    if (x.webSearches + x.xSearches + x.codeRuns + x.fileSearches === 0) return null;
    plan.xai = x;
    return plan;
  }
  if (provider !== "anthropic") return null;
  let any = false;
  for (const tool of body.tools) {
    const kind = anthropicKind(tool);
    if (!kind) continue;
    any = true;
    const t = tool as Record<string, unknown>;
    if (ANTHROPIC_FREE_CODE_EXECUTION.has(t.type as string)) plan.codeExecutionFree = true;
    // Uncapped (no dollar limit, so none was added): the hold still assumes the
    // default, which is what a token budget is then measured against.
    const uses = positiveInt(t.max_uses) ?? DEFAULT_TOOL_CAP;
    if (kind === "web_search") plan.searches += uses;
    else if (kind === "web_fetch") {
      plan.fetches += uses;
      plan.fetchTokens += uses * (positiveInt(t.max_content_tokens) ?? DEFAULT_FETCH_CONTENT_TOKENS);
    } else plan.codeExecutions += DEFAULT_TOOL_CAP;
  }
  return any ? plan : null;
}

/** The tokens and money the hold adds for a plan, priced at this attempt's model. */
export function hostedToolReserve(
  plan: HostedToolPlan,
  model: string,
  provider: Parameters<typeof costMicrocents>[3]
): { tokens: number; microcents: number } {
  if (plan.openai) {
    const o = plan.openai;
    const tokens = o.calls * SEARCH_RESULT_TOKEN_ALLOWANCE;
    const sessions = o.containers.reduce(
      (sum, tier) => sum + openaiContainerMicrocents(tier, OPENAI_CONTAINER_SESSION_MINUTES),
      0
    );
    return { tokens, microcents: o.calls * o.perCallMicrocents + sessions + costMicrocents(model, tokens, 0, provider) };
  }
  if (plan.xai) {
    const x = plan.xai;
    const calls = x.webSearches + x.xSearches + x.codeRuns + x.fileSearches;
    const tokens = calls * SEARCH_RESULT_TOKEN_ALLOWANCE;
    const perUse =
      (x.webSearches + x.codeRuns) * XAI_CALL_MICROCENTS +
      x.fileSearches * XAI_FILE_SEARCH_MICROCENTS +
      x.xSearches * X_SEARCH_POSTS_ALLOWANCE * XAI_X_POST_MICROCENTS;
    return { tokens, microcents: perUse + costMicrocents(model, tokens, 0, provider) };
  }
  const tokens =
    plan.searches * SEARCH_RESULT_TOKEN_ALLOWANCE +
    plan.fetchTokens +
    plan.codeExecutions * CODE_EXECUTION_TOKEN_ALLOWANCE;
  const perUse =
    plan.searches * ANTHROPIC_WEB_SEARCH_MICROCENTS +
    (plan.codeExecutionFree ? 0 : plan.codeExecutions * ANTHROPIC_CODE_EXECUTION_MIN_MICROCENTS);
  return { tokens, microcents: perUse + costMicrocents(model, tokens, 0, provider) };
}

/**
 * The per-use charge for what the provider reported, on top of the tokens it
 * reported (which already include search and fetch results). `durationMs` is the
 * call's wall time, the upper bound on any code execution inside it.
 */
export function hostedToolUseCost(
  provider: string,
  use: HostedToolUse | undefined,
  plan: HostedToolPlan | null,
  durationMs: number
): number {
  if (!use) return 0;
  if (provider === "openai") {
    // Each web_search_call counts, whatever its action or status: over-counting
    // an open_page is the safe side of a per-call price nobody itemises.
    const search = plan?.openai?.searchMicrocents || OPENAI_WEB_SEARCH_PREVIEW_MICROCENTS;
    const tiers = plan?.openai?.containers ?? [];
    // A container's tier comes from the request; with several, the dearest.
    const tier = tiers.reduce<MemoryTier>(
      (best, t) => (OPENAI_CONTAINER_MINUTE_MICROCENTS[t] > OPENAI_CONTAINER_MINUTE_MICROCENTS[best] ? t : best),
      tiers.length ? tiers[0]! : "64g"
    );
    const minutes = Math.max(OPENAI_CONTAINER_MIN_MINUTES, Math.ceil(Math.max(0, durationMs) / 60_000));
    const containers = new Set(use.containers ?? []).size;
    return (
      use.webSearch * search +
      (use.fileSearch ?? 0) * OPENAI_FILE_SEARCH_MICROCENTS +
      containers * openaiContainerMicrocents(tier, minutes)
    );
  }
  if (provider === "xai") {
    return (
      (use.webSearch + use.codeExecution) * XAI_CALL_MICROCENTS +
      (use.fileSearch ?? 0) * XAI_FILE_SEARCH_MICROCENTS +
      (use.xPosts ?? 0) * XAI_X_POST_MICROCENTS +
      (use.xUsers ?? 0) * XAI_X_USER_MICROCENTS
    );
  }
  if (provider !== "anthropic") return 0;
  const searches = use.webSearch * ANTHROPIC_WEB_SEARCH_MICROCENTS;
  const code = plan?.codeExecutionFree ? 0 : use.codeExecution * anthropicCodeExecutionMicrocents(durationMs);
  return searches + code;
}

/**
 * What a call is charged: its tokens plus its hosted tools. Where the provider
 * reports the exact charge itself (xAI), the larger of the two, so a price this
 * table lags behind can only over-count.
 */
export function totalWithHostedTools(
  provider: string,
  tokenMicrocents: number,
  use: HostedToolUse | undefined,
  plan: HostedToolPlan | null,
  durationMs: number
): number {
  const computed = tokenMicrocents + hostedToolUseCost(provider, use, plan, durationMs);
  return Math.max(computed, use?.reportedMicrocents ?? 0);
}

/** xAI's `cost_in_usd_ticks` in microcents, rounded up; null when absent or malformed. */
export function xaiTicksToMicrocents(ticks: unknown): number | null {
  return typeof ticks === "number" && Number.isFinite(ticks) && ticks >= 0
    ? Math.ceil(ticks / XAI_TICKS_PER_MICROCENT)
    : null;
}
