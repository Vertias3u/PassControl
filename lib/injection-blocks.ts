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

function collect(value: unknown, path: string, source: string, depth: number, out: UntrustedBlock[]): void {
  if (out.length >= MAX_BLOCKS || depth > MAX_DEPTH) return;
  if (typeof value === "string") {
    if (value.length > 0) out.push({ path, source, text: value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => collect(item, `${path}[${i}]`, source, depth + 1, out));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (out.length >= MAX_BLOCKS) return;
    if (SKIP_KEYS.has(key)) continue;
    // A search result's `source` is its URL; a document's is an object holding the text.
    if (key === "source" && typeof item === "string") continue;
    if (typeof item === "string" && isMedia(key, item, value)) continue;
    collect(item, `${path}.${key}`, source, depth + 1, out);
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

function fromMessages(messages: unknown[], out: UntrustedBlock[]): void {
  const start = newestTurnStart(messages, (m) => m.role === "assistant");
  messages.forEach((message, i) => {
    if (i < start || !isRecord(message) || out.length >= MAX_BLOCKS) return;
    const base = `messages[${i}]`;
    // OpenAI Chat: the whole message is a tool's answer.
    if (message.role === "tool" || message.role === "function") {
      collect(message.content, `${base}.content`, message.role, 1, out);
      return;
    }
    // Anthropic: untrusted blocks sit among the user's and the model's own.
    if (message.role === "system" || !Array.isArray(message.content)) return;
    message.content.forEach((block, j) => {
      if (!isRecord(block) || typeof block.type !== "string") return;
      if (!ANTHROPIC_UNTRUSTED.has(block.type) && !isServerToolResult(block.type)) return;
      const blockPath = `${base}.content[${j}]`;
      if (block.type === "tool_result") collect(block.content, `${blockPath}.content`, block.type, 1, out);
      else collect(block, blockPath, block.type, 1, out);
    });
  });
}

/** OpenAI Responses `input` items whose payload came from a tool. */
function fromResponsesInput(items: unknown[], out: UntrustedBlock[]): void {
  // The model's own items: its messages and the calls it made (`function_call`,
  // `mcp_call`, `file_search_call`, …), never a `*_call_output`.
  const start = newestTurnStart(
    items,
    (item) => item.role === "assistant" || (typeof item.type === "string" && item.type.endsWith("_call"))
  );
  items.forEach((item, i) => {
    if (i < start || !isRecord(item) || typeof item.type !== "string" || out.length >= MAX_BLOCKS) return;
    const base = `input[${i}]`;
    if (item.type.endsWith("_call_output")) collect(item.output, `${base}.output`, item.type, 1, out);
    else if (item.type === "mcp_call") {
      collect(item.output, `${base}.output`, item.type, 1, out);
      collect(item.error, `${base}.error`, item.type, 1, out);
    } else if (item.type === "file_search_call") collect(item.results, `${base}.results`, item.type, 1, out);
  });
}

/** The tool-supplied text in a request body's newest turn, in body order, at most 2,000. */
export function untrustedBlocks(body: unknown): UntrustedBlock[] {
  const out: UntrustedBlock[] = [];
  if (!isRecord(body)) return out;
  if (Array.isArray(body.messages)) fromMessages(body.messages, out);
  if (Array.isArray(body.input)) fromResponsesInput(body.input, out);
  return out;
}
