// Tools a provider runs on its own servers are billed per call, per item or per
// session, outside token usage. OpenAI charges $10 per 1k web-search calls,
// $2.50 per 1k file-search calls and per 20-minute session for code-interpreter
// containers (developers.openai.com/api/docs/pricing, read 2026-09-27); xAI charges
// $5 per 1k web searches and $5 per 1k X posts fetched (docs.x.ai/developers/
// pricing.md, read 2026-09-27). A budget
// that counts tokens cannot hold those charges, and a receipt would understate
// the call, so a request that could incur one is refused before anything is
// reserved or sent. Owner decisions, 2026-09-27 (OpenAI; xAI as plan P2-5).
//
// Deny-by-default, per provider. For each provider with a rule, only the tool
// types the AGENT executes pass; every other type, a tool with no type, a
// non-object tool and a `tools` value that is not a list are refused, so a
// hosted tool the provider adds later is refused too. A provider with no rule
// here is not inspected.
//
// Model-bound search (OpenAI's `*-search-preview` chat models, which search on
// every call with no tool in the request) is refused in the gate instead
// (lib/gate.ts), because the gate is what the decision trace and failover share.

type ToolCheck = (tool: Record<string, unknown>) => boolean;

import {
  ANTHROPIC_ADVISOR_TYPES,
  ANTHROPIC_PRICED_TOOLS,
  anthropicAdvisor,
  OPENAI_PRICED_TOOLS,
  XAI_PRICED_TOOLS,
} from "@/lib/providers/hosted-tools";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * OpenAI tool types the client executes, from the installed SDK's `Tool` union
 * (openai 6.49.0, resources/responses/responses.d.ts). Chat Completions tools
 * are a subset (`function`, `custom`).
 */
const OPENAI_CLIENT_TOOLS: Record<string, ToolCheck> = {
  function: () => true,
  custom: () => true,
  computer: () => true,
  computer_use_preview: () => true,
  local_shell: () => true,
  apply_patch: () => true,
  // `shell` can run in a hosted container (`container_auto`,
  // `container_reference`); only an explicitly local environment is the agent's.
  shell: (tool) => isRecord(tool.environment) && tool.environment.type === "local",
  // Tool search can run on either side; only the client's is free of a hosted run.
  tool_search: (tool) => tool.execution === "client",
  // A namespace groups functions and custom tools; each member is checked.
  namespace: (tool) =>
    Array.isArray(tool.tools) &&
    tool.tools.every((inner) => isRecord(inner) && (inner.type === "function" || inner.type === "custom")),
};

/**
 * Anthropic tools the client executes, from the installed SDK's `BetaToolUnion`
 * (@anthropic-ai/sdk 0.112.4, resources/beta/messages/messages.d.ts): bash,
 * computer, text editor and memory, each versioned by a date suffix. Matched by
 * family so a newer version of a client tool passes; everything else in that
 * union (web search, web fetch, code execution, the advisor, tool search, an MCP
 * toolset) runs on Anthropic's side and is refused, as is any type added later.
 */
const ANTHROPIC_CLIENT_TOOL = /^(?:bash|computer|text_editor|memory)_\d{8}$/u;

interface ProviderRule {
  clientTools: Record<string, ToolCheck>;
  /** Request fields that switch on a hosted capability whenever present. */
  refusedFields: readonly string[];
  /**
   * A tool with no `type`, or `type: "custom"`/null, is the agent's own. True only
   * where the provider documents it so (Anthropic: `BetaTool.type?: 'custom' | null`).
   */
  untypedIsClient?: boolean;
  /** Client-executed type families, versioned by date. */
  clientTypePattern?: RegExp;
  /**
   * Hosted tools accepted because they are PRICED (lib/providers/hosted-tools.ts):
   * held for before the call and charged at settlement. Exact versions only.
   */
  pricedTools?: Readonly<Record<string, unknown>>;
}

/** xAI documents only functions as client tools ("only functions and web search"). */
const XAI_CLIENT_TOOLS: Record<string, ToolCheck> = {
  function: () => true,
};

const RULES: Readonly<Record<string, ProviderRule>> = {
  // Web search, file search, code interpreter and hosted shell are accepted and
  // priced (DECISIONS 2026-10-07); MCP, image generation and server tool search
  // stay refused. Azure below keeps the old rule: nobody has priced its tools.
  openai: {
    clientTools: OPENAI_CLIENT_TOOLS,
    pricedTools: OPENAI_PRICED_TOOLS,
    refusedFields: [
      // Chat Completions' web search switch.
      "web_search_options",
      // A stored Responses prompt carries its own configuration, tools included,
      // which PassControl cannot see from the request.
      "prompt",
    ],
  },
  // Azure's v1 API is OpenAI's wire format, and its Responses API hosts the same
  // kinds of tool (MCP, code interpreter, image generation, web search), billed
  // outside tokens. Same rule as OpenAI's (owner decision 2026-09-27).
  azure: {
    clientTools: OPENAI_CLIENT_TOOLS,
    refusedFields: ["web_search_options", "prompt"],
  },
  // Claude Code's own tools are untyped custom tools (captured 2026-10-07), plus,
  // since 2.1.293, Anthropic's advisor on main-model calls (captured 2026-10-08).
  // Web search, web fetch and code execution are accepted and priced (owner,
  // DECISIONS 2026-10-07); the advisor too, when its model has a price (P4,
  // 2026-10-08). Tool search and MCP toolsets have no published per-use price, or
  // reach servers the agent names, and stay refused.
  anthropic: {
    clientTools: {},
    untypedIsClient: true,
    clientTypePattern: ANTHROPIC_CLIENT_TOOL,
    // The advisor is priced when it names a model with a price row (P4, 2026-10-08).
    pricedTools: {
      ...ANTHROPIC_PRICED_TOOLS,
      ...Object.fromEntries([...ANTHROPIC_ADVISOR_TYPES].map((type) => [type, (tool: Record<string, unknown>) => anthropicAdvisor(tool) !== null])),
    },
    // Remote MCP servers Anthropic connects to. (`container` reuses a priced
    // code execution container across turns, so it passes.)
    refusedFields: ["mcp_servers"],
  },
  // Web search, X search, code execution and collections search are accepted and
  // priced (DECISIONS 2026-10-07); remote MCP and image generation stay refused.
  xai: {
    clientTools: XAI_CLIENT_TOOLS,
    pricedTools: XAI_PRICED_TOOLS,
    // xAI's older live-search switch. Refused whenever present, even
    // `mode: "off"`: telling a harmless value from a costly one is the judgement
    // this rule avoids making.
    refusedFields: ["search_parameters"],
  },
  // OpenRouter runs its own server tools (`openrouter:web_search`, `:shell`,
  // `:advisor`, `:subagent`, `:fusion`, …), some of which call other models. Its web
  // search is priced by an engine OpenRouter picks, and one engine bills a third-party
  // account, so none is priced yet: functions only (plans/openrouter.md).
  openrouter: {
    clientTools: { function: () => true },
    refusedFields: [
      // The web plugin, and the other plugins (PDF parsing, response healing).
      "plugins",
      // Chat Completions' web search switch, which OpenRouter also accepts.
      "web_search_options",
      // Server-tool loop control: meaningless without server tools.
      "stop_server_tools_when",
      // The legacy switch for xAI's X search through OpenRouter.
      "x_search_filter",
    ],
  },
};

/** Why this request could invoke a server-side tool, or null if it cannot. */
export function serverSideToolUse(provider: string, body: unknown): string | null {
  const rule = RULES[provider];
  if (!rule || !isRecord(body)) return null;
  for (const field of rule.refusedFields) {
    if (field in body && body[field] !== undefined && body[field] !== null) return field;
  }
  if (!("tools" in body) || body.tools === undefined || body.tools === null) return null;
  const tools = body.tools;
  if (!Array.isArray(tools)) return "tools";
  for (const [index, tool] of tools.entries()) {
    if (!isRecord(tool)) return `tools[${index}]`;
    if (rule.untypedIsClient && (tool.type === undefined || tool.type === null || tool.type === "custom")) continue;
    if (typeof tool.type !== "string") return `tools[${index}]`;
    if (rule.clientTypePattern?.test(tool.type)) continue;
    if (rule.pricedTools && Object.prototype.hasOwnProperty.call(rule.pricedTools, tool.type)) {
      // A value that is a function is a shape check (an OpenAI container tool
      // must name its container); anything else means the type alone suffices.
      const priced = rule.pricedTools[tool.type];
      if (typeof priced !== "function" || (priced as ToolCheck)(tool)) continue;
    }
    const check = Object.prototype.hasOwnProperty.call(rule.clientTools, tool.type)
      ? rule.clientTools[tool.type]
      : undefined;
    if (!check || !check(tool)) return `tools[${index}].type`;
  }
  return null;
}

/**
 * OpenAI chat models that run a web search on every call, billed per call,
 * with no tool in the request (`gpt-4o-search-preview`, `gpt-4o-mini-search-preview`
 * and their dated ids, per the installed SDK's `ChatModel` union).
 */
export function isServerSideSearchModel(provider: string, model: string): boolean {
  // OpenRouter's `:online` suffix is "exactly equivalent" to its web plugin
  // (openrouter.ai/docs/guides/features/plugins/web-search, read 2026-10-07).
  if (provider === "openrouter") return /:online$/iu.test(model);
  return provider === "openai" && /(^|-)search(-|$)/iu.test(model);
}

/**
 * What to name in a refusal: the tool's own `type` where `why` points at a tools[]
 * entry (`tools[3].type` → `advisor_20260301`), otherwise `why` itself (a refused
 * field such as `mcp_servers`). Capped, since it echoes the caller's own input.
 */
export function serverToolLabel(body: unknown, why: string): string {
  const index = /^tools\[(\d+)\]/.exec(why);
  if (index && isRecord(body) && Array.isArray(body.tools)) {
    const tool = body.tools[Number(index[1])];
    if (isRecord(tool) && typeof tool.type === "string" && tool.type) return tool.type.slice(0, 64);
  }
  return why.slice(0, 64);
}

/**
 * The sentence a refused agent (and the person reading its error) gets. Claude
 * Code's advisor gets the two documented ways to turn it off
 * (code.claude.com/docs/en/settings-reference, `advisorModel`, read 2026-10-08).
 */
export function serverToolRefusalMessage(tool: string): string {
  if (tool.startsWith("advisor_")) {
    return (
      `PassControl cannot price this advisor call (${tool}), so the request was refused before anything was sent. ` +
      "In Claude Code, run /advisor and pick No advisor, or start it with CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1, then retry."
    );
  }
  return (
    `The request uses a hosted tool PassControl does not price (${tool}), so it was refused before anything was sent. ` +
    "Remove that tool, or call it outside PassControl."
  );
}
