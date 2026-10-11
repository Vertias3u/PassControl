// What an Anthropic request does from INSIDE `messages`, which the gateway reads
// before it forwards the betas that switch those things on (sprint T3, D8).
//
// Claude Code 2.1.295 sends three such betas (captured 2026-10-09,
// tests/fixtures/claude-code/per-turn-effort.json):
//
//   * `per-turn-control-2026-07-01`: a mid-conversation `role: "system"` message
//     carrying `output_config.effort`. Anthropic documents the same feature as
//     `mid-conversation-output-config-2026-07-01` (effort docs, read 2026-10-09);
//     Claude Code sends the other name, and Anthropic accepts it.
//   * `mid-conversation-tool-changes-2026-07-01`: `tool_addition` / `tool_removal`
//     blocks naming a tool already in `tools[]` (by reference).
//   * `inline-tools-2026-09-15`: the same blocks carrying a tool's whole definition
//     (by value), plus everything by reference. Claude Code uses it for MCP tools
//     that connect late (mid-conversation system messages docs, read 2026-10-09).
//
// The checks, and why they suffice:
//
//   * Effort cannot cost more than the hold. `max_tokens` is "a hard limit on total
//     output (thinking plus response text)" at every effort level, and the hold
//     already covers `max_tokens`. So a per-message `output_config` may carry
//     `effort` with a documented value, and nothing else; a message may carry no
//     field besides role, content and that. Anything else keeps the beta dropped.
//   * A tool defined inside `messages` reaches what a `tools[]` entry would. Caps,
//     holds and the advisor's model gate read `tools[]` only, so inside `messages`
//     only the agent's OWN tools are accepted: custom tools and the client-executed
//     families. Every hosted tool, the advisor and any MCP toolset are refused
//     there, priced or not; declared in `tools[]` they are priced as before.
//   * A tool named by reference is already in `tools[]`, which is checked;
//     Anthropic refuses a reference to anything else (`tool_reference_unresolved`).
//     MCP references need `mcp_servers`, refused on its own, and are refused here
//     too so the rule does not depend on that.
//
// Every message is read whatever its role. Where such a block may appear is
// Anthropic's rule; the gateway does not rely on it.

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Anthropic tools the client executes, from @anthropic-ai/sdk 0.112.4's
 * BetaToolUnion: bash, computer, text editor and memory, each versioned by date.
 */
export const ANTHROPIC_CLIENT_TOOL = /^(?:bash|computer|text_editor|memory)_\d{8}$/u;

/** A tool the agent runs itself: untyped or `custom` (Anthropic's BetaTool), or a client family. */
export function isAnthropicClientTool(tool: unknown): boolean {
  if (!isRecord(tool)) return false;
  if (tool.type === undefined || tool.type === null || tool.type === "custom") return true;
  return typeof tool.type === "string" && ANTHROPIC_CLIENT_TOOL.test(tool.type);
}

/**
 * Where a tool change inside `messages` adds something the gateway cannot hold
 * for, or is not a shape it knows: a path such as
 * `messages[3].content[0].tool.definition.type`. Null when every change is a
 * client tool by value or a plain reference.
 */
export function inlineToolRefusal(body: unknown): string | null {
  if (!isRecord(body) || !Array.isArray(body.messages)) return null;
  for (const [i, message] of body.messages.entries()) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const [j, block] of message.content.entries()) {
      if (!isRecord(block) || (block.type !== "tool_addition" && block.type !== "tool_removal")) continue;
      const at = `messages[${i}].content[${j}].tool`;
      const tool = block.tool;
      if (!isRecord(tool)) return at;
      if (tool.type === "tool_reference") {
        if (typeof tool.name === "string" && tool.name) continue;
        return `${at}.name`;
      }
      if (tool.type === "tool_definition" && block.type === "tool_addition") {
        if (isAnthropicClientTool(tool.definition)) continue;
        return isRecord(tool.definition) ? `${at}.definition.type` : `${at}.definition`;
      }
      return `${at}.type`;
    }
  }
  return null;
}

/** The tool type an inline refusal points at, for the error message, or null. */
export function inlineToolType(body: unknown, why: string): string | null {
  const at = /^messages\[(\d+)\]\.content\[(\d+)\]/.exec(why);
  if (!at || !isRecord(body) || !Array.isArray(body.messages)) return null;
  const message = body.messages[Number(at[1])];
  const block = isRecord(message) && Array.isArray(message.content) ? message.content[Number(at[2])] : undefined;
  const tool = isRecord(block) ? block.tool : undefined;
  const definition = isRecord(tool) ? tool.definition : undefined;
  const type = isRecord(definition) ? definition.type : isRecord(tool) ? tool.type : undefined;
  return typeof type === "string" && type ? type.slice(0, 64) : null;
}

const EFFORTS: ReadonlySet<string> = new Set(["low", "medium", "high", "xhigh", "max"]);
const MESSAGE_FIELDS: ReadonlySet<string> = new Set(["role", "content", "output_config"]);

function perTurnEffortOnly(body: Record<string, unknown>): boolean {
  if (!Array.isArray(body.messages)) return true;
  for (const message of body.messages) {
    if (!isRecord(message)) return false;
    for (const field of Object.keys(message)) if (!MESSAGE_FIELDS.has(field)) return false;
    if (!("output_config" in message)) continue;
    if (message.role !== "system") return false;
    const config = message.output_config;
    if (!isRecord(config)) return false;
    for (const field of Object.keys(config)) if (field !== "effort") return false;
    if ("effort" in config && !(typeof config.effort === "string" && EFFORTS.has(config.effort))) return false;
  }
  return true;
}

// Auto mode's server-side safety checks (sprint P7, 2026-10-10;
// plans/auto-mode-classifier-billing.md). Claude Code 2.1.296 sends
// `safeguards: [{ type: "dangerous_tool_use", classifier_context: {...} }]` with beta
// `dangerous-tool-use-2026-09-03`, asking Anthropic to judge its risky tool calls
// inside this call at no charge. The context describes the client's own environment
// (working directory, permission rules, git state) to the provider the transcript
// already goes to; it adds no tool, URL or model, and a verdict only reaches the
// client that asked. So an entry may carry that type and that object, nothing else.
// Anything else keeps the beta dropped: Anthropic then answers 400 and Claude Code
// falls back to its own classifier calls, which is the behaviour before this.
const SAFEGUARD_FIELDS: ReadonlySet<string> = new Set(["type", "classifier_context"]);
const MAX_SAFEGUARDS = 8;

function safeguardsUnderstood(body: Record<string, unknown>): boolean {
  const list = body.safeguards;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_SAFEGUARDS) return false;
  return list.every(
    (entry) =>
      isRecord(entry) &&
      entry.type === "dangerous_tool_use" &&
      Object.keys(entry).every((field) => SAFEGUARD_FIELDS.has(field)) &&
      (!("classifier_context" in entry) || isRecord(entry.classifier_context))
  );
}

/**
 * Whether the body's per-message controls are ones the gateway understands, so
 * the betas that switch them on may travel: `perTurnEffort` for per-turn effort,
 * `toolChanges` for tools added or removed inside `messages`, `safeguards` for
 * auto mode's server-side checks.
 */
export function anthropicMessageControls(body: unknown): { perTurnEffort: boolean; toolChanges: boolean; safeguards: boolean } {
  if (!isRecord(body)) return { perTurnEffort: false, toolChanges: false, safeguards: false };
  return {
    perTurnEffort: perTurnEffortOnly(body),
    toolChanges: inlineToolRefusal(body) === null,
    safeguards: safeguardsUnderstood(body),
  };
}
