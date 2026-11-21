// Where a streamed answer carries the model's words, per provider shape: Anthropic's
// `delta.text` / `delta.partial_json` (tool input) / `delta.thinking`, OpenAI chat's
// `choices[].delta.content` and tool-call `arguments`, and the Responses API's string
// `delta`. Also streamed reasoning, `reasoning_content` (DeepSeek, several OpenRouter
// endpoints) and `reasoning` (OpenRouter), and OpenAI chat's streamed `refusal` (owner,
// 2026-11-10). Collected by key, so a shape this list does not name is still read.
//
// One list, two readers, so they cannot drift apart:
//   - lib/secret-guard.ts watches these fields for a secret the MODEL wrote;
//   - lib/providers/secret-redaction.ts joins them to catch the PROVIDER KEY streamed
//     back in pieces.
// It lives in its own file because the guard imports server-only modules and the
// redactor must not.
export const STREAM_TEXT_KEYS: ReadonlySet<string> = new Set([
  "text",
  "partial_json",
  "thinking",
  "content",
  "arguments",
  "delta",
  "reasoning_content",
  "reasoning",
  "refusal",
]);
