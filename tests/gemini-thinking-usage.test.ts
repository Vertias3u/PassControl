// Gemini bills thinking tokens at the output rate, but its OpenAI-compatible
// Chat Completions endpoint leaves them out of `completion_tokens`. Owner-run on
// the free tier, 2026-09-27, `gemini-3.8-flash` with `reasoning_effort: "medium"`:
//
//   usage: { completion_tokens: 127, prompt_tokens: 13, total_tokens: 304 }
//
// 13 + 127 = 140, so 164 billed tokens sat outside both fields. Charging
// `completion_tokens` alone billed 127 of 291 output tokens. For Gemini the output
// is therefore everything that is not input, `total_tokens − prompt_tokens`,
// never less than `completion_tokens`.
import { describe, expect, it } from "vitest";
import type { ProviderId } from "../lib/providers";
import { createUsageTransform, NO_USAGE, usageFromJson } from "../lib/usage/parseStream";

const OBSERVED = { completion_tokens: 127, prompt_tokens: 13, total_tokens: 304 };
const enc = (s: string) => new TextEncoder().encode(s);

async function streamed(provider: ProviderId, usage: unknown) {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc(`data: {"choices":[{"index":0,"delta":{"content":"391"}}]}\n\n`));
      controller.enqueue(enc(`data: ${JSON.stringify({ choices: [], usage })}\n\n`));
      controller.enqueue(enc("data: [DONE]\n\n"));
      controller.close();
    },
  });
  const { stream, settled } = createUsageTransform(provider);
  const reader = source.pipeThrough(stream).getReader();
  while (!(await reader.read()).done) {
    /* drain */
  }
  return settled;
}

describe("Gemini thinking tokens are charged as output", () => {
  it("bills the observed call as 291 output tokens, not 127 (JSON)", () => {
    const u = usageFromJson("gemini", { choices: [], usage: OBSERVED });
    expect(u).toMatchObject({ inputTokens: 13, outputTokens: 291, sawUsage: true, complete: true });
  });

  it("bills the observed call as 291 output tokens, not 127 (stream)", async () => {
    expect(await streamed("gemini", OBSERVED)).toEqual({
      usage: { ...NO_USAGE, inputTokens: 13, outputTokens: 291 },
      end: "close",
      sawUsage: true,
      complete: true,
    });
  });

  it("changes nothing when the total is just input plus output (no thinking)", async () => {
    const plain = { prompt_tokens: 13, completion_tokens: 20, total_tokens: 33 };
    expect(usageFromJson("gemini", { usage: plain })).toMatchObject({ outputTokens: 20, complete: true });
    expect((await streamed("gemini", plain)).usage.outputTokens).toBe(20);
  });

  it("never bills less than the reported completion_tokens", () => {
    // A total below input + output is not a report we can reconcile, but the
    // output that WAS reported is still owed.
    const low = { prompt_tokens: 13, completion_tokens: 127, total_tokens: 100 };
    expect(usageFromJson("gemini", { usage: low }).outputTokens).toBe(127);
  });

  it("is not complete when the total is below the input", async () => {
    const bad = { prompt_tokens: 13, completion_tokens: 5, total_tokens: 10 };
    const json = usageFromJson("gemini", { usage: bad });
    expect(json.complete).toBe(false);
    expect(json.outputTokens).toBe(5);
    const s = await streamed("gemini", bad);
    expect(s.complete).toBe(false);
    expect(s.usage.outputTokens).toBe(5);
  });

  it("is not complete when the total is malformed", () => {
    for (const total_tokens of ["304", -1, 1.5, null]) {
      expect(usageFromJson("gemini", { usage: { prompt_tokens: 13, completion_tokens: 127, total_tokens } }).complete).toBe(false);
    }
  });

  it.each(["openai", "groq", "mistral", "together", "deepseek"] as const)(
    "leaves %s on completion_tokens, even when its total is larger",
    async (provider) => {
      expect(usageFromJson(provider, { usage: OBSERVED })).toMatchObject({ outputTokens: 127, complete: true });
      expect((await streamed(provider, OBSERVED)).usage.outputTokens).toBe(127);
    }
  );
});

// How Gemini actually ends a stream. Captured by the owner 2026-09-27
// (`gemini-3.8-flash`, streamed, include_usage), last data lines of each run with
// the opaque `thought_signature` shortened. Usage rides on content chunks — the
// final one carries `finish_reason` — and `[DONE]` follows. There is no separate
// `choices: []` usage chunk, which is the only shape the OpenAI rule accepts as
// final, so every streamed Gemini call used to settle as usage_unknown.
const SIG = { extra_content: { google: { thought_signature: "EqgCCqUCAWkU" } }, role: "assistant" };
const chunk = (choice: Record<string, unknown>, usage: unknown) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, ...choice }], model: "gemini-3.8-flash", object: "chat.completion.chunk", usage })}\n\n`;
const MAX50 = [
  chunk({ delta: SIG, finish_reason: "length" }, { completion_tokens: 0, prompt_tokens: 13, total_tokens: 59 }),
  "data: [DONE]\n\n",
] as const;
const MAX400 = [
  chunk({ delta: { content: "A quick way is to use the difference of squares", role: "assistant" } },
    { completion_tokens: 33, prompt_tokens: 13, total_tokens: 409 }),
  chunk({ delta: SIG, finish_reason: "length" }, { completion_tokens: 33, prompt_tokens: 13, total_tokens: 409 }),
  "data: [DONE]\n\n",
] as const;

async function run(provider: ProviderId, lines: readonly string[], ending: "close" | "break" = "close") {
  let i = 0;
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = lines[i++];
      if (next !== undefined) return controller.enqueue(enc(next));
      if (ending === "break") controller.error(new Error("upstream connection reset"));
      else controller.close();
    },
  });
  const { stream, settled } = createUsageTransform(provider);
  const reader = source.pipeThrough(stream).getReader();
  try {
    while (!(await reader.read()).done) {
      /* drain */
    }
  } catch {
    /* the break is the case under test */
  }
  return settled;
}

describe("a streamed Gemini call is complete on its real final chunk", () => {
  it("settles the 50-token run as complete: 13 in, 46 out", async () => {
    expect(await run("gemini", MAX50)).toEqual({
      usage: { ...NO_USAGE, inputTokens: 13, outputTokens: 46 },
      end: "close",
      sawUsage: true,
      complete: true,
    });
  });

  it("settles the 400-token run, usage on two chunks, as complete: 13 in, 396 out", async () => {
    const s = await run("gemini", MAX400);
    expect(s.complete).toBe(true);
    expect(s.usage).toMatchObject({ inputTokens: 13, outputTokens: 396 });
  });

  it("is not complete when a chunk without usage follows the usage chunk", async () => {
    const after = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "more" } }] })}\n\n`;
    expect((await run("gemini", [MAX400[1], after, "data: [DONE]\n\n"])).complete).toBe(false);
  });

  it("is not complete when the usage chunk has not finished", async () => {
    // MAX400's first line: usage, but no finish_reason.
    expect((await run("gemini", [MAX400[0], "data: [DONE]\n\n"])).complete).toBe(false);
  });

  it("is not complete without [DONE], on a clean close or a break", async () => {
    expect((await run("gemini", [MAX50[0]])).complete).toBe(false);
    const broken = await run("gemini", [MAX50[0]], "break");
    expect(broken.end).toBe("error");
    expect(broken.complete).toBe(false);
  });

  it("leaves OpenAI's rule alone: usage on a finished one-choice chunk is still not final", async () => {
    const s = await run("openai", [chunk({ delta: {}, finish_reason: "stop" }, { prompt_tokens: 13, completion_tokens: 5 }), "data: [DONE]\n\n"]);
    expect(s.complete).toBe(false);
  });
});
