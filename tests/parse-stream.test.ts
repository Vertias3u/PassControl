import { describe, expect, it } from "vitest";
import { createUsageTransform } from "../lib/usage/parseStream";

describe("stream usage settlement", () => {
  it("resolves parsed usage when the downstream reader cancels before close", async () => {
    const chunk = new TextEncoder().encode(
      'data: {"usage":{"prompt_tokens":12,"completion_tokens":3}}\n\n'
    );
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
      },
    });
    const { stream, usage } = createUsageTransform("openai");
    const reader = source.pipeThrough(stream).getReader();

    await reader.read();
    await reader.cancel("client disconnected");

    const result = await Promise.race([
      usage,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
    ]);
    expect(result).toEqual({ inputTokens: 12, outputTokens: 3 });
  });
});
