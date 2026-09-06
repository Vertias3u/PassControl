import { describe, expect, it } from "vitest";
import { createUsageTransform, usageFromJson, NO_USAGE } from "../lib/usage/parseStream";
import { estimateTokenUsage } from "../lib/pricing";

const enc = (value: string) => new TextEncoder().encode(value);

async function drain(readable: ReadableStream<Uint8Array>): Promise<void> {
  const reader = readable.getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) return;
  }
}

describe("OpenAI Responses API usage accounting", () => {
  it("reserves against Responses input and max_output_tokens", () => {
    expect(estimateTokenUsage({ input: "12345678", max_output_tokens: 64 })).toEqual({
      inputTokens: 3,
      outputTokens: 64,
      totalTokens: 67,
    });
  });

  // Regression: dispatching on provider alone sends this through the ordinary
  // OpenAI parser, which looks for prompt_tokens/completion_tokens and records
  // zero. That releases the whole reservation and makes the endpoint free to
  // the agent's budget even though the provider billed it.
  it("reads input_tokens and output_tokens from a buffered Responses payload", () => {
    expect(
      usageFromJson(
        "openai",
        { status: "completed", usage: { input_tokens: 37, output_tokens: 11, total_tokens: 48 } },
        "responses"
      )
    ).toEqual({ ...NO_USAGE, inputTokens: 37, outputTokens: 11, sawUsage: true, complete: true });
  });

  // The documented stream reports its final usage inside response.completed,
  // not in a Chat Completions include_usage chunk. Prove the numbers that will
  // reach reconciliation rather than merely proving that bytes pass through.
  it("reads usage from the response.completed streaming event", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          enc(
            'event: response.completed\n' +
              'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":37,"output_tokens":11,"total_tokens":48}}}\n\n'
          )
        );
        controller.close();
      },
    });
    const { stream, settled } = createUsageTransform("openai", "responses");

    await drain(source.pipeThrough(stream));

    expect(await settled).toEqual({
      usage: { ...NO_USAGE, inputTokens: 37, outputTokens: 11 },
      end: "close",
      sawUsage: true,
      complete: true,
    });
  });

  it("does not treat failed or incomplete Responses usage as a complete result", () => {
    expect(
      usageFromJson(
        "openai",
        { status: "incomplete", usage: { input_tokens: 37, output_tokens: 11 } },
        "responses"
      )
    ).toEqual({ ...NO_USAGE, inputTokens: 37, outputTokens: 11, sawUsage: true, complete: false });
  });
});
