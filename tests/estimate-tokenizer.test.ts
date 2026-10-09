// The pre-flight token estimate, by tokenizer (sprint P1.6, owner 2026-10-08).
//
// The estimate sizes every hold, so it decides admission against every limit; and on
// the paths where a call may have been billed but reported nothing it is what gets
// CHARGED (settleUnknown: max(observed, estimate)). It used to be characters ÷ 4 for
// every model. Measured 2026-10-08 through the gateway, prompt tokens as Anthropic
// reported them for max_tokens: 1 (UTF-8 bytes of the prompt fields' JSON per token):
//
//   text                                   new tokenizer     old tokenizer
//                                          (Haiku 5.5,       (Haiku 4.5,
//                                           Sonnet 5)         Sonnet 4.6)
//   a real Claude Code request (184 KB)        2.82              3.81
//   source code (lib/budget-view.ts)           2.65              3.29
//   Bulgarian prose                            4.46              4.46
//   random English words (Q0.5)                2.37               -
//
// Characters ÷ 4 held 70% of a Claude Code request on the new tokenizer and 61% of a
// Bulgarian prompt on either: a $2/day limit could be passed by the error of the calls
// in flight. Bytes, not characters, because Cyrillic is two bytes per character and
// tokenizes like it. The divisors sit under every measured text except random words
// (1% short at 2.4), a stated bound.
//
// Base64 is NOT text. A PDF's is counted at 4 bytes a token (billed per page); a Claude
// image is held at the model's per-image ceiling (P5.2, see below).
import { describe, expect, it } from "vitest";
import { estimateTokenUsage, promptBytesPerToken } from "@/lib/pricing";

describe("promptBytesPerToken: which tokenizer a model id names", () => {
  it.each([
    // Claude 4.7 and later, Fable, Mythos: the new tokenizer.
    ["claude-opus-4-7", 2.4],
    ["claude-opus-4-8", 2.4],
    ["claude-opus-5", 2.4],
    ["claude-opus-5-5", 2.4],
    ["claude-sonnet-5", 2.4],
    ["claude-sonnet-5-5", 2.4],
    ["claude-haiku-5-5", 2.4],
    ["claude-fable-5-1", 2.4],
    ["claude-mythos-5", 2.4],
    ["claude-opus-5-5-20261001", 2.4],
    // Through OpenRouter, dots and all.
    ["anthropic/claude-opus-4.7", 2.4],
    ["anthropic/claude-sonnet-5", 2.4],
    // Up to 4.6, and the version-first names: the old one.
    ["claude-opus-4-6", 3.2],
    ["claude-sonnet-4-6", 3.2],
    ["claude-sonnet-4-5-20250929", 3.2],
    ["claude-opus-4-20250514", 3.2],
    ["claude-haiku-4-5", 3.2],
    ["claude-3-5-haiku-20241022", 3.2],
    ["anthropic/claude-sonnet-4.5", 3.2],
    // A Claude id this table cannot read gets the conservative divisor.
    ["claude-nova-1", 2.4],
    ["~anthropic/claude-sonnet-latest", 2.4],
    // Routing ids that name no model may land on Claude: conservative too.
    ["openrouter/auto", 2.4],
    ["meta-llama/llama-3.3-70b-instruct@preset/x", 2.4],
    // Everything else keeps 4.
    ["gpt-4o-mini", 4],
    ["gemini-2.5-flash", 4],
    ["openai/gpt-5-mini", 4],
    ["demo-1", 4],
    [undefined, 4],
  ] as [string | undefined, number][])("%s → %s", (model, divisor) => {
    expect(promptBytesPerToken(model)).toBe(divisor);
  });
});

const text = (n: number) => "a".repeat(n);
const promptBytes = (messages: unknown) => Buffer.byteLength(JSON.stringify(messages));

describe("estimateTokenUsage by tokenizer", () => {
  it("holds a new-tokenizer prompt at bytes ÷ 2.4", () => {
    const messages = [{ role: "user", content: text(24_000) }];
    const u = estimateTokenUsage({ model: "claude-sonnet-5", max_tokens: 100, messages });
    expect(u.inputTokens).toBe(Math.ceil(promptBytes(messages) / 2.4));
    expect(u.outputTokens).toBe(100);
  });

  it("holds an old-tokenizer prompt at bytes ÷ 3.2", () => {
    const messages = [{ role: "user", content: text(24_000) }];
    expect(estimateTokenUsage({ model: "claude-haiku-4-5", max_tokens: 1, messages }).inputTokens).toBe(
      Math.ceil(promptBytes(messages) / 3.2)
    );
  });

  it("leaves every other model at ÷ 4 for ASCII text, exactly as before", () => {
    const messages = [{ role: "user", content: text(24_000) }];
    expect(estimateTokenUsage({ model: "gpt-4o-mini", max_tokens: 1, messages }).inputTokens).toBe(
      Math.ceil(JSON.stringify(messages).length / 4)
    );
  });

  it("counts bytes, so Cyrillic is held at its real weight", () => {
    const bg = "Агентът чете файла и пуска тестовете. ".repeat(500);
    const messages = [{ role: "user", content: bg }];
    const u = estimateTokenUsage({ model: "gpt-4o-mini", max_tokens: 1, messages });
    expect(u.inputTokens).toBe(Math.ceil(promptBytes(messages) / 4));
    // Characters ÷ 4 held 61% of this; bytes ÷ 4 covers the measured 4.46 bytes a token.
    expect(u.inputTokens).toBeGreaterThan(Math.ceil(JSON.stringify(messages).length / 4) * 1.6);
  });

  it("an explicit model argument wins over the body's (a fallback attempt's own model)", () => {
    const messages = [{ role: "user", content: text(24_000) }];
    const body = { model: "gpt-4o-mini", max_tokens: 1, messages };
    expect(estimateTokenUsage(body, 1000, "claude-opus-5-5").inputTokens).toBe(Math.ceil(promptBytes(messages) / 2.4));
  });
});

describe("images: held at the model's per-image ceiling on Claude, never by their bytes", () => {
  // P5.2 (owner, 2026-10-08). Anthropic bills an image by its pixels, resized to at
  // most 2576 px / 4,784 visual tokens on Claude 4.7 and later and 1568 px / 1,568
  // tokens on the rest (vision docs, read 2026-10-08). Bytes ÷ 4 held a 1 MB
  // screenshot at ~330K tokens and refused a $2/day agent a call that costs cents;
  // an image sent by URL or file id was held at almost nothing. Each Claude image
  // now holds its ceiling. A PDF is billed per page, so it keeps bytes ÷ 4.
  const b64 = "iVBORw0KGgo".padEnd(400_000, "A");
  const image = (source: Record<string, unknown>) => ({ type: "image", source });

  it("a base64 image on a 4.7+ model holds 4,784 tokens, whatever its size", () => {
    const messages = [{ role: "user", content: [image({ type: "base64", media_type: "image/png", data: b64 }), { type: "text", text: "what is this?" }] }];
    const u = estimateTokenUsage({ model: "claude-opus-5-5", max_tokens: 1, messages });
    expect(u.inputTokens).toBe(Math.ceil((promptBytes(messages) - b64.length) / 2.4) + 4_784);
  });

  it("an older model's ceiling is 1,568", () => {
    const messages = [{ role: "user", content: [image({ type: "base64", media_type: "image/png", data: b64 })] }];
    const u = estimateTokenUsage({ model: "claude-sonnet-4-5", max_tokens: 1, messages });
    expect(u.inputTokens).toBe(Math.ceil((promptBytes(messages) - b64.length) / 3.2) + 1_568);
  });

  it("an image by URL or file id holds its ceiling too, not the length of its reference", () => {
    const messages = [{ role: "user", content: [image({ type: "url", url: "https://x.example/a.png" }), image({ type: "file", file_id: "file_1" })] }];
    const u = estimateTokenUsage({ model: "claude-sonnet-5", max_tokens: 1, messages });
    expect(u.inputTokens).toBe(Math.ceil(promptBytes(messages) / 2.4) + 2 * 4_784);
  });

  it("a tiny image is held at the ceiling as well: the bytes are no bound on the pixels", () => {
    const tiny = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
    const messages = [{ role: "user", content: [image({ type: "base64", media_type: "image/png", data: tiny })] }];
    const u = estimateTokenUsage({ model: "claude-sonnet-5", max_tokens: 1, messages });
    expect(u.inputTokens).toBe(Math.ceil((promptBytes(messages) - tiny.length) / 2.4) + 4_784);
  });

  it("an image inside a tool result counts (computer use screenshots)", () => {
    const messages = [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [image({ type: "base64", media_type: "image/png", data: b64 })] }] }];
    const u = estimateTokenUsage({ model: "claude-sonnet-5", max_tokens: 1, messages });
    expect(u.inputTokens).toBe(Math.ceil((promptBytes(messages) - b64.length) / 2.4) + 4_784);
  });

  it("an OpenAI-format image to a Claude model through OpenRouter holds the ceiling", () => {
    const url = `data:image/png;base64,${b64}`;
    const messages = [{ role: "user", content: [{ type: "image_url", image_url: { url } }] }];
    const u = estimateTokenUsage({ model: "anthropic/claude-sonnet-5", max_tokens: 1, messages });
    expect(u.inputTokens).toBe(Math.ceil((promptBytes(messages) - url.length) / 2.4) + 4_784);
  });

  it("a PDF keeps bytes ÷ 4: Anthropic bills it per page", () => {
    const doc = [{ role: "user", content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } }] }];
    const u = estimateTokenUsage({ model: "claude-sonnet-5", max_tokens: 1, messages: doc });
    expect(u.inputTokens).toBe(Math.ceil((promptBytes(doc) - b64.length) / 2.4) + Math.ceil(b64.length / 4));
  });

  it("another provider's images keep bytes ÷ 4", () => {
    const url = `data:image/png;base64,${b64}`;
    const input = [{ role: "user", content: [{ type: "input_image", image_url: url }, { type: "input_file", file_data: b64 }] }];
    const u = estimateTokenUsage({ model: "gpt-4.1", max_output_tokens: 1, input });
    const raw = url.length + b64.length;
    expect(u.inputTokens).toBe(Math.ceil((promptBytes(input) - raw) / 4) + Math.ceil(raw / 4));
  });
});

describe("what did not change", () => {
  it("an empty body keeps its one-token floor", () => {
    expect(estimateTokenUsage({}).inputTokens).toBe(1);
  });

  it("the decision trace's model-only body is unchanged", () => {
    expect(estimateTokenUsage({ model: "claude-sonnet-5" })).toEqual({ inputTokens: 1, outputTokens: 1024, totalTokens: 1025 });
  });
});
