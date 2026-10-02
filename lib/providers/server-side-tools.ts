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

interface ProviderRule {
  clientTools: Record<string, ToolCheck>;
  /** Request fields that switch on a hosted capability whenever present. */
  refusedFields: readonly string[];
}

/** xAI documents only functions as client tools ("only functions and web search"). */
const XAI_CLIENT_TOOLS: Record<string, ToolCheck> = {
  function: () => true,
};

const RULES: Readonly<Record<string, ProviderRule>> = {
  openai: {
    clientTools: OPENAI_CLIENT_TOOLS,
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
  xai: {
    clientTools: XAI_CLIENT_TOOLS,
    // xAI's older live-search switch. Refused whenever present, even
    // `mode: "off"`: telling a harmless value from a costly one is the judgement
    // this rule avoids making.
    refusedFields: ["search_parameters"],
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
    if (!isRecord(tool) || typeof tool.type !== "string") return `tools[${index}]`;
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
  return provider === "openai" && /(^|-)search(-|$)/iu.test(model);
}
