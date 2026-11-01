// The untrusted text in a model request: what tools, documents and searches handed the
// model (plans/injection-guard.md §2a). The injection guard scans these and nothing else.
//
// Picked out by the body's own structure, whatever the provider: the gateway speaks two
// request families (Anthropic Messages; OpenAI Chat and Responses, which every other
// provider here uses), so shape is enough. Never scanned: the system prompt, `role:
// "system"` messages (Claude Code puts its own inside `messages`), user text and the
// model's own turns. Provenance is coarse: a tool result says it came from a tool, not
// whether the tool read the web, a file or an inbox.
//
// Only the newest turn is read (2026-10-27): from the last model turn to the end. A
// conversation is re-sent whole on every call, but an attacker writes tool output, not the
// request's shape, so each tool block is new on exactly one call, the first after the turn
// that asked for it. Reading only that turn catches every block once and holds the cost
// to one turn instead of the whole history on every call (about 29 ms per MB measured).
// The price: a guard switched on mid-conversation never reads what came before.
//
// A shape this file does not name is read as carrying nothing untrusted. That is the
// honest limit (plan §9, limit 5): new block types need adding here, with a test.

export interface UntrustedBlock {
  /** Where in the body, e.g. `messages[3].content[0].content`. */
  path: string;
  /** The block or message type that carried it: `tool_result`, `tool`, `function_call_output`, … */
  source: string;
  text: string;
}

const MAX_BLOCKS = 2_000;
const MAX_DEPTH = 32;

/** Anthropic content blocks whose text came from outside the conversation. */
const ANTHROPIC_UNTRUSTED = new Set(["tool_result", "document", "search_result"]);
/** Server-tool results: `web_fetch_tool_result`, `web_search_tool_result`, `mcp_tool_result`, … */
const isServerToolResult = (type: string) => type.endsWith("_tool_result");

// 1.7.1 (external review P6): every other type the gateway has decided about. These carry
// the user's or the model's own words, or media; anything not here and not read above is
// a format it has no rule for, and is named (unknownTypes), never assumed trusted.
const CONTENT_TRUSTED = new Set([
  // Anthropic
  "text", "image", "tool_use", "thinking", "redacted_thinking", "server_tool_use", "mcp_tool_use", "container_upload",
  // OpenAI Chat content parts
  "image_url", "input_audio", "file", "refusal",
]);
const CHAT_ROLES = new Set(["user", "assistant", "system", "developer", "tool", "function"]);
/** Responses items that are the model's own, the owner's, or carry no text. Not here, and
 * so named: an item with results of its own this does not read (`code_interpreter_call`'s
 * outputs, `mcp_list_tools`' descriptions). */
const RESPONSES_TRUSTED = new Set([
  "message", "reasoning", "item_reference", "function_call", "custom_tool_call", "local_shell_call", "computer_call",
  "web_search_call", "image_generation_call", "mcp_approval_request", "mcp_approval_response",
]);
const MAX_UNKNOWN_TYPES = 5;

/** Keys that name or locate content rather than carry it. */
const SKIP_KEYS = new Set([
  "type",
  "id",
  "tool_use_id",
  "call_id",
  "media_type",
  "encrypted_content",
  "encrypted_index",
  "file_id",
  "signature",
  "url",
  "page_age",
  "retrieved_at",
  "status",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Base64 media: never text (the secret guard's rule). */
function isMedia(key: string, value: string, parent: Record<string, unknown>): boolean {
  return (key === "data" && parent.type === "base64") || key === "file_data" || value.startsWith("data:");
}

/** Why reading stopped before the end (1.7.1): what was not read is not clean. */
export type UntrustedCut = "too_many_blocks" | "too_deep";

/** Where the read stands: the blocks so far, and the first reason it stopped early. */
interface Reading {
  out: UntrustedBlock[];
  cut?: UntrustedCut;
  unknown?: Set<string>;
}

function noteUnknown(reading: Reading, name: string): void {
  reading.unknown ??= new Set();
  if (reading.unknown.size < MAX_UNKNOWN_TYPES) reading.unknown.add(/^[a-z0-9_:]{1,64}$/.test(name) ? name : "?");
}

// Only the block limit ends the read: a branch too deep is skipped, and the rest is read.
const full = (r: Reading) => r.out.length >= MAX_BLOCKS && r.cut !== undefined;

const TEXT_PROBE_NODES = 10_000;

/** Whether text sits anywhere under `value`; past TEXT_PROBE_NODES nodes, assumed so. */
function holdsText(value: unknown): boolean {
  const pending = [value];
  for (let seen = 0; pending.length > 0; seen++) {
    if (seen >= TEXT_PROBE_NODES) return true;
    const node = pending.pop();
    if (typeof node === "string") {
      if (node.length > 0) return true;
    } else if (Array.isArray(node)) pending.push(...node);
    else if (isRecord(node)) pending.push(...Object.values(node));
  }
  return false;
}

function collect(value: unknown, path: string, source: string, depth: number, reading: Reading): void {
  const { out } = reading;
  if (out.length >= MAX_BLOCKS || depth > MAX_DEPTH) {
    if (!full(reading) && holdsText(value)) reading.cut = out.length >= MAX_BLOCKS ? "too_many_blocks" : (reading.cut ?? "too_deep");
    return;
  }
  if (typeof value === "string") {
    if (value.length > 0) out.push({ path, source, text: value });
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length && !full(reading); i++) collect(value[i], `${path}[${i}]`, source, depth + 1, reading);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (full(reading)) return;
    if (SKIP_KEYS.has(key)) continue;
    // A search result's `source` is its URL; a document's is an object holding the text.
    if (key === "source" && typeof item === "string") continue;
    if (typeof item === "string" && isMedia(key, item, value)) continue;
    collect(item, `${path}.${key}`, source, depth + 1, reading);
  }
}

/**
 * Where the newest turn starts: the first of the last run of items the model wrote (one
 * Responses turn can be several calls in a row), not counting a final item (a prefill),
 * or 0 when the model has not spoken yet. Inclusive, because a server tool's result sits
 * inside the model's own message.
 */
function newestTurnStart(items: unknown[], isModelTurn: (item: Record<string, unknown>) => boolean): number {
  const byModel = (i: number) => isRecord(items[i]) && isModelTurn(items[i] as Record<string, unknown>);
  let i = items.length - 2;
  while (i >= 0 && !byModel(i)) i--;
  if (i < 0) return 0;
  while (i > 0 && byModel(i - 1)) i--;
  return i;
}

function fromMessages(messages: unknown[], reading: Reading): void {
  const start = newestTurnStart(messages, (m) => m.role === "assistant");
  messages.forEach((message, i) => {
    if (i < start || !isRecord(message) || full(reading)) return;
    const base = `messages[${i}]`;
    // OpenAI Chat: the whole message is a tool's answer.
    if (message.role === "tool" || message.role === "function") {
      collect(message.content, `${base}.content`, message.role, 1, reading);
      return;
    }
    if (typeof message.role !== "string" || !CHAT_ROLES.has(message.role)) noteUnknown(reading, `role:${String(message.role)}`);
    // Anthropic: untrusted blocks sit among the user's and the model's own.
    if (message.role === "system" || !Array.isArray(message.content)) return;
    message.content.forEach((block, j) => {
      if (!isRecord(block) || typeof block.type !== "string") return;
      if (!ANTHROPIC_UNTRUSTED.has(block.type) && !isServerToolResult(block.type)) {
        if (!CONTENT_TRUSTED.has(block.type)) noteUnknown(reading, block.type);
        return;
      }
      const blockPath = `${base}.content[${j}]`;
      if (block.type === "tool_result") collect(block.content, `${blockPath}.content`, block.type, 1, reading);
      else collect(block, blockPath, block.type, 1, reading);
    });
  });
}

/** OpenAI Responses `input` items whose payload came from a tool. */
function fromResponsesInput(items: unknown[], reading: Reading): void {
  // The model's own items: its messages and the calls it made (`function_call`,
  // `mcp_call`, `file_search_call`, …), never a `*_call_output`.
  const start = newestTurnStart(
    items,
    (item) => item.role === "assistant" || (typeof item.type === "string" && item.type.endsWith("_call"))
  );
  items.forEach((item, i) => {
    if (i < start || !isRecord(item) || typeof item.type !== "string" || full(reading)) return;
    const base = `input[${i}]`;
    if (item.type.endsWith("_call_output")) collect(item.output, `${base}.output`, item.type, 1, reading);
    else if (item.type === "mcp_call") {
      collect(item.output, `${base}.output`, item.type, 1, reading);
      collect(item.error, `${base}.error`, item.type, 1, reading);
    } else if (item.type === "file_search_call") collect(item.results, `${base}.results`, item.type, 1, reading);
    else if (!RESPONSES_TRUSTED.has(item.type)) noteUnknown(reading, item.type);
  });
}

/**
 * The tool-supplied text in a request body's newest turn, in body order, at most 2,000
 * blocks, `cut` when text was left unread past that or past the depth limit, and
 * `unknownTypes`, at most five, for formats it has no rule for (telemetry only).
 */
export function readUntrusted(body: unknown): { blocks: UntrustedBlock[]; cut?: UntrustedCut; unknownTypes?: string[] } {
  const reading: Reading = { out: [] };
  if (!isRecord(body)) return { blocks: reading.out };
  if (Array.isArray(body.messages)) fromMessages(body.messages, reading);
  if (Array.isArray(body.input)) fromResponsesInput(body.input, reading);
  return {
    blocks: reading.out,
    ...(reading.cut ? { cut: reading.cut } : {}),
    ...(reading.unknown?.size ? { unknownTypes: [...reading.unknown] } : {}),
  };
}

/** The blocks alone (readUntrusted, without saying whether it stopped early). */
export function untrustedBlocks(body: unknown): UntrustedBlock[] {
  return readUntrusted(body).blocks;
}
